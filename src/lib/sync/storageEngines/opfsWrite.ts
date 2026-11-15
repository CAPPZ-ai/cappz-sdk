/**
 * COPE node crystallized. Node ID: v15-01-02-opfs-write
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * One OPFS file writer for every cappz-store / wallet-blob / media / model
 * write. Main-thread `createWritable()` where the browser has it; otherwise
 * (iOS/macOS Safari before 26, which ships `getDirectory()` without it) the
 * write goes through a dedicated worker using `createSyncAccessHandle()`.
 * Without this, every durable flush on those devices threw and release
 * saves into wallets failed on each page load.
 */

type Pending = { resolve: () => void; reject: (err: Error) => void };

let worker: Worker | null = null;
let workerUrl: string | URL | null = null;
let nextId = 0;

/** Where the write worker lives when this module is bundled into one file (a bundler drops `import.meta.url`). */
export function setOpfsWriteWorkerUrl(url: string | URL): void { workerUrl = url; }
const pending = new Map<number, Pending>();

function writeWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(workerUrl ?? new URL('./opfsWriteWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (msg: MessageEvent<{ id: number; ok: boolean; error?: string }>) => {
    const p = pending.get(msg.data.id);
    if (!p) return;
    pending.delete(msg.data.id);
    if (msg.data.ok) p.resolve();
    else p.reject(new Error(`[opfs] worker write failed: ${msg.data.error ?? 'unknown'}`));
  };
  worker.onerror = (ev) => {
    const err = new Error(`[opfs] write worker crashed: ${ev.message || 'unknown'}`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker = null;
  };
  return worker;
}

/** True when this browser can write OPFS files from the main thread. */
export function mainThreadWritable(handle: FileSystemFileHandle): boolean {
  return typeof (handle as { createWritable?: unknown }).createWritable === 'function';
}

/** WebKit's UnknownError ("unknown transient reason (e.g. out of memory)"): worth one more try. */
export function isTransientOpfsError(err: unknown): boolean {
  const name = (err as { name?: unknown })?.name;
  const message = err instanceof Error ? err.message : String(err);
  return name === 'UnknownError' || /unknown transient reason|UnknownError/i.test(message);
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function writeViaWorker(path: string[], data: Uint8Array | ArrayBuffer | Blob): Promise<void> {
  if (typeof Worker === 'undefined') throw new Error('[opfs] no createWritable and no Worker for createSyncAccessHandle');
  const buffer = data instanceof Blob
    ? await data.arrayBuffer()
    : data instanceof Uint8Array ? data.slice().buffer : data.slice(0);
  const id = ++nextId;
  await new Promise<void>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    writeWorker().postMessage({ id, path, bytes: buffer }, [buffer]);
  });
}

async function writeOnce(path: string[], data: Uint8Array | ArrayBuffer | Blob): Promise<void> {
  let dir = await navigator.storage.getDirectory();
  for (const segment of path.slice(0, -1)) dir = await dir.getDirectoryHandle(segment, { create: true });
  const handle = await dir.getFileHandle(path[path.length - 1], { create: true });
  if (!mainThreadWritable(handle)) return writeViaWorker(path, data);
  const w = await handle.createWritable();
  try {
    await w.write(data as BlobPart);
    await w.close();
  } catch (err) {
    // A failed writable must be released, or the file stays locked for the retry.
    try { await (w as { abort?: () => Promise<void> }).abort?.(); } catch { /* already closed */ }
    throw err;
  }
}

/**
 * Replace the file at `path` (directory segments from the OPFS root, file
 * name last) with `data`. Resolves only once the bytes are written.
 *
 * v15-46-00 — Safari reports memory pressure as a transient UnknownError. The
 * write is tried once more after a short pause; where the main-thread writable
 * failed twice and a worker is available, the third try goes through the
 * worker's sync access handle (a separate heap). Other errors fail at once.
 */
export async function opfsWriteFile(path: string[], data: Uint8Array | ArrayBuffer | Blob): Promise<void> {
  try {
    return await writeOnce(path, data);
  } catch (first) {
    if (!isTransientOpfsError(first)) throw first;
    await pause(150);
    try {
      return await writeOnce(path, data);
    } catch (second) {
      if (!isTransientOpfsError(second) || typeof Worker === 'undefined') throw second;
      try { return await writeViaWorker(path, data); } catch { throw second; }
    }
  }
}
