/**
 * IngestKnowledge — Unified content ingestion pipeline for MKF Skill.
 *
 * Supports multiple input sources:
 *   - HTTP/HTTPS URL fetch
 *   - FTP URL fetch (via proxy)
 *   - File system browse (single file, multi-select, folder recursive crawl)
 *   - Copy-paste text/URL in prompt window
 *   - Attachment upload
 *
 * Pipeline: Acquire → Store Raw → Notarize → Parse → Fragment → Index
 * All ingested files are stored as-is and notarized PRIOR to parsing content.
 *
 * HD Addressing: m/44'/144'/0'/skills/mkf/content/{docIndex}/{fragmentPath}
 */

import { notarizeClient } from '../crypto/clientNotarize';
import { offlineCache } from '../offlineCache';

// ─── Input Source Types ────────────────────────────────────────

export type IngestionSourceType =
  | 'http'       // HTTP/HTTPS URL fetch
  | 'ftp'        // FTP URL (proxied)
  | 'file'       // File system — single or multi-select
  | 'folder'     // File system — recursive folder crawl
  | 'paste'      // Copy-paste text in prompt window
  | 'attachment'  // File attachment (drag-drop or browse)
  | 'url-paste';  // URL pasted in prompt window → fetched

export interface IngestionSource {
  type: IngestionSourceType;
  /** URL for http/ftp/url-paste sources */
  url?: string;
  /** File objects for file/folder/attachment sources */
  files?: File[];
  /** Raw text for paste source */
  text?: string;
  /** Source label for provenance */
  label?: string;
}

// ─── Ingestion Result Types ────────────────────────────────────

export interface IngestedDocument {
  /** Unique document ID */
  docId: string;
  /** Original filename or URL */
  sourceName: string;
  /** Source type used */
  sourceType: IngestionSourceType;
  /** MIME type */
  mimeType: string;
  /** Raw size in bytes */
  rawSize: number;
  /** HD address for this document's raw content */
  hdAddress: string;
  /** Notarization receipt hash (raw content notarized before parsing) */
  notarizationHash: string;
  /** Notarization salt */
  notarizationSalt: string;
  /** Notarization ID */
  notarizationId: string;
  /** Whether DB persistence succeeded */
  persistedToDb: boolean;
  /** Timestamp of ingestion */
  ingestedAt: string;
  /** Raw content stored — cappz-middleware key */
  rawStorageKey: string;
}

export interface IngestionBatchResult {
  /** Total documents ingested in this batch */
  totalDocuments: number;
  /** Successfully ingested */
  succeeded: IngestedDocument[];
  /** Failed ingestions */
  failed: Array<{ sourceName: string; error: string }>;
  /** Batch ID for tracking */
  batchId: string;
  /** Batch timestamp */
  timestamp: string;
  /** ContentIngested Tx event payloads (one per doc) */
  events: ContentIngestedEvent[];
}

export interface ContentIngestedEvent {
  eventType: 'ContentIngested';
  docId: string;
  sourceName: string;
  sourceType: IngestionSourceType;
  hdAddress: string;
  notarizationHash: string;
  rawSize: number;
  timestamp: string;
}

export interface ContentFragmentedEvent {
  eventType: 'ContentFragmented';
  docId: string;
  fragmentCount: number;
  hdBasePath: string;
  timestamp: string;
}

export interface ContentTranslatedEvent {
  eventType: 'ContentTranslated';
  sourceDocId: string;
  targetDocId: string;
  sourceLanguage: string;
  targetLanguage: string;
  /** Direction of translation */
  direction: 'source-to-target';
  /** HD address of source language graph */
  sourceHdAddress: string;
  /** HD address of target language graph */
  targetHdAddress: string;
  /** Translation method */
  method: 'agent-ai' | 'human' | 'hybrid';
  /** Granularity level matched (verse, paragraph, section, chapter) */
  granularity: string;
  timestamp: string;
}

// ─── MKF HD Path Constants ─────────────────────────────────────

const MKF_CONTENT_ROOT = "m/44'/144'/0'/skills/mkf/content";
const MKF_TRANSLATIONS_ROOT = "m/44'/144'/0'/skills/mkf/translations";

// ─── File Acquisition Helpers ──────────────────────────────────

async function fetchFromUrl(url: string): Promise<{ data: ArrayBuffer; mimeType: string; name: string }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  const data = await response.arrayBuffer();
  const mimeType = response.headers.get('content-type') || 'application/octet-stream';
  const urlPath = new URL(url).pathname;
  const name = urlPath.split('/').pop() || url;
  return { data, mimeType, name };
}

async function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Recursively collect files from a folder via the File System Access API.
 * Falls back to flat file list if API unavailable.
 */
async function crawlFolder(dirHandle: FileSystemDirectoryHandle): Promise<File[]> {
  const files: File[] = [];
  for await (const entry of (dirHandle as any).values()) {
    if (entry.kind === 'file') {
      const file = await (entry as FileSystemFileHandle).getFile();
      files.push(file);
    } else if (entry.kind === 'directory') {
      const subFiles = await crawlFolder(entry as FileSystemDirectoryHandle);
      files.push(...subFiles);
    }
  }
  return files;
}

// ─── Core Ingestion Pipeline ───────────────────────────────────

/**
 * Ingest a single document: Store raw → Notarize → Return receipt.
 * Parsing is a SEPARATE downstream step (MKF Phase 1 parser).
 */
async function ingestSingleDocument(
  rawBytes: ArrayBuffer,
  sourceName: string,
  sourceType: IngestionSourceType,
  mimeType: string,
  walletAddress: string,
  docIndex: number,
  network: 'testnet' | 'devnet' | 'mainnet' = 'testnet',
): Promise<IngestedDocument> {
  const docId = crypto.randomUUID();
  const hdAddress = `${MKF_CONTENT_ROOT}/${docIndex}`;
  const rawStorageKey = `mkf:raw:${walletAddress}:${docId}`;
  const timestamp = new Date().toISOString();

  // 1. Store raw content as-is in cappz-middleware
  const base64Raw = arrayBufferToBase64(rawBytes);
  await offlineCache.set('kv', rawStorageKey, {
    docId,
    sourceName,
    sourceType,
    mimeType,
    rawSize: rawBytes.byteLength,
    rawBase64: base64Raw,
    hdAddress,
    storedAt: timestamp,
  }, {
    walletAddress,
    ttl: 365 * 24 * 60 * 60 * 1000, // 1 year
  });

  // 2. Notarize raw content BEFORE any parsing
  const notarizeResult = await notarizeClient({
    fileBase64: base64Raw,
    userWallet: walletAddress,
    fileName: sourceName,
    contentType: mimeType,
    network,
    metadata: {
      event: 'ContentIngested',
      docId,
      hdAddress,
      sourceType,
    },
  });

  return {
    docId,
    sourceName,
    sourceType,
    mimeType,
    rawSize: rawBytes.byteLength,
    hdAddress,
    notarizationHash: notarizeResult.leaf,
    notarizationSalt: notarizeResult.salt,
    notarizationId: notarizeResult.notarizationId,
    persistedToDb: notarizeResult.persistedToDb,
    ingestedAt: timestamp,
    rawStorageKey,
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ─── Public API ────────────────────────────────────────────────

/**
 * IngestKnowledge — Primary ingestion entry point.
 *
 * Acquires content from the specified source(s), stores raw, notarizes,
 * and returns batch results with ContentIngested events.
 *
 * Called by:
 *   - WalletAgent.ingestKnowledge() (delegates to attached MKF skill)
 *   - AgentSkill.ingestKnowledge() (direct skill invocation)
 */
export async function ingestKnowledge(
  source: IngestionSource,
  walletAddress: string,
  startDocIndex: number,
  network: 'testnet' | 'devnet' | 'mainnet' = 'testnet',
): Promise<IngestionBatchResult> {
  const batchId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const succeeded: IngestedDocument[] = [];
  const failed: Array<{ sourceName: string; error: string }> = [];
  const events: ContentIngestedEvent[] = [];
  let docIndex = startDocIndex;

  // Resolve raw content items from source
  const items = await resolveSourceItems(source);

  for (const item of items) {
    try {
      const doc = await ingestSingleDocument(
        item.data,
        item.name,
        source.type,
        item.mimeType,
        walletAddress,
        docIndex++,
        network,
      );
      succeeded.push(doc);
      events.push({
        eventType: 'ContentIngested',
        docId: doc.docId,
        sourceName: doc.sourceName,
        sourceType: source.type,
        hdAddress: doc.hdAddress,
        notarizationHash: doc.notarizationHash,
        rawSize: doc.rawSize,
        timestamp: doc.ingestedAt,
      });
    } catch (err) {
      failed.push({
        sourceName: item.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Store batch metadata
  const batchKey = `mkf:batch:${walletAddress}:${batchId}`;
  await offlineCache.set('kv', batchKey, {
    batchId,
    totalDocuments: items.length,
    succeededCount: succeeded.length,
    failedCount: failed.length,
    docIds: succeeded.map(d => d.docId),
    timestamp,
  }, {
    walletAddress,
    ttl: 365 * 24 * 60 * 60 * 1000,
  });

  return {
    totalDocuments: items.length,
    succeeded,
    failed,
    batchId,
    timestamp,
    events,
  };
}

// ─── Source Resolution ──────────────────────────────────────────

interface RawItem {
  name: string;
  data: ArrayBuffer;
  mimeType: string;
}

async function resolveSourceItems(source: IngestionSource): Promise<RawItem[]> {
  switch (source.type) {
    case 'http':
    case 'ftp':
    case 'url-paste': {
      if (!source.url) throw new Error(`URL required for ${source.type} source`);
      const { data, mimeType, name } = await fetchFromUrl(source.url);
      return [{ name, data, mimeType }];
    }

    case 'file':
    case 'attachment': {
      if (!source.files?.length) throw new Error('No files provided');
      const items: RawItem[] = [];
      for (const file of source.files) {
        const data = await readFileAsArrayBuffer(file);
        items.push({ name: file.name, data, mimeType: file.type || 'application/octet-stream' });
      }
      return items;
    }

    case 'folder': {
      if (!source.files?.length) throw new Error('No files provided from folder crawl');
      const items: RawItem[] = [];
      for (const file of source.files) {
        const data = await readFileAsArrayBuffer(file);
        items.push({
          name: (file as any).webkitRelativePath || file.name,
          data,
          mimeType: file.type || 'application/octet-stream',
        });
      }
      return items;
    }

    case 'paste': {
      if (!source.text) throw new Error('No text provided for paste source');
      const encoder = new TextEncoder();
      const data = encoder.encode(source.text).buffer;
      return [{ name: source.label || 'pasted-content.txt', data, mimeType: 'text/plain' }];
    }

    default:
      throw new Error(`Unsupported source type: ${source.type}`);
  }
}

// ─── Folder Browser Helper (File System Access API) ────────────

/**
 * Open a folder picker dialog and recursively crawl all files.
 * Returns File[] for use as IngestionSource.files.
 * Requires modern browser with File System Access API.
 */
export async function browseFolder(): Promise<File[]> {
  if (!('showDirectoryPicker' in window)) {
    throw new Error('Folder browsing requires File System Access API (Chrome/Edge)');
  }
  const dirHandle = await (window as any).showDirectoryPicker();
  return crawlFolder(dirHandle);
}

/**
 * Open a file picker dialog with multi-select.
 * Returns File[] for use as IngestionSource.files.
 */
export async function browseFiles(accept?: string): Promise<File[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (accept) input.accept = accept;
    input.onchange = () => {
      const files = input.files ? Array.from(input.files) : [];
      resolve(files);
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}

// ─── Translation HD Constants ──────────────────────────────────

export { MKF_CONTENT_ROOT, MKF_TRANSLATIONS_ROOT, crawlFolder };
