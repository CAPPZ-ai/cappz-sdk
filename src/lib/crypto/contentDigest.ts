/**
 * COPE node crystallized.
 * Node ID: v15-15-00-content-digest
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * One read of a file gives both hashes notarization needs:
 *
 *   sha256 — SHA-256(content), lowercase hex: the file's identity
 *   leaf   — SHA-256(prefix || content), uppercase hex: the salted leaf
 *
 * The prefix is whatever the caller's receipt scheme salts with — the salt
 * TEXT (clientNotarize, clientVerify, cappz-notarize, cappz-verify) or the
 * raw salt BYTES (CAPPZ's XRPL notary service). Leaves are byte-identical to
 * the one-shot formulas they replace; only how the bytes are read changes.
 *
 * Backend, by runtime and size:
 *   native kernels loaded (Node 26, Deno, Bun) → streamed, ARMv8 SHA-256 instructions
 *   up to `webCryptoMaxBytes` with WebCrypto    → one buffer, WebCrypto (a browser's
 *                                                 only route to the CPU's SHA instructions)
 *   anything larger                             → streamed in slices on the given
 *                                                 kernels (WASM in browsers), so memory
 *                                                 stays at one slice however big the file
 */
import { activeKernels, type NativeBackend, type NativeKernels } from '../native/cappzNative';

export type DigestSource = Uint8Array | Blob;

export interface DigestOptions {
  /** When given, `leaf` = SHA-256(leafPrefix || content) is computed in the same pass. */
  leafPrefix?: Uint8Array;
  /** Compute `sha256` of the content itself (default true). */
  contentHash?: boolean;
  /** Kernels for the streamed path (default: the SDK's active kernels). */
  kernels?: NativeKernels;
  /** Largest input hashed in one WebCrypto call (default 64 MiB). */
  webCryptoMaxBytes?: number;
  /** Slice size when streaming (default 4 MiB). */
  sliceBytes?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface ContentDigests {
  sha256?: string;
  leaf?: string;
  size: number;
  via: 'webcrypto' | NativeBackend;
}

export const WEBCRYPTO_MAX_BYTES = 64 * 1024 * 1024;
export const DIGEST_SLICE_BYTES = 4 * 1024 * 1024;

const hex = (d: ArrayBuffer | Uint8Array) => Array.from(d instanceof Uint8Array ? d : new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');

/** Hash `source` once for its SHA-256 and/or salted leaf. */
export async function digestContent(source: DigestSource, o: DigestOptions = {}): Promise<ContentDigests> {
  const size = source instanceof Uint8Array ? source.length : source.size;
  const wantHash = o.contentHash !== false;
  const prefix = o.leafPrefix;
  if (!wantHash && !prefix) throw new Error('digestContent: nothing to compute (contentHash false and no leafPrefix)');
  const kernels = o.kernels ?? activeKernels();
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;

  if (kernels.backend !== 'native' && subtle && size <= (o.webCryptoMaxBytes ?? WEBCRYPTO_MAX_BYTES)) {
    // One buffer holding prefix then content, so both digests read the same
    // bytes; a Uint8Array without a prefix is hashed in place.
    const p = prefix ?? new Uint8Array(0);
    let buf: Uint8Array;
    if (source instanceof Uint8Array && !p.length) {
      buf = source;
    } else {
      buf = new Uint8Array(p.length + size);
      buf.set(p);
      buf.set(source instanceof Uint8Array ? source : new Uint8Array(await source.arrayBuffer()), p.length);
    }
    const [h, l] = await Promise.all([
      wantHash ? subtle.digest('SHA-256', buf.subarray(p.length) as BufferSource) : null,
      prefix ? subtle.digest('SHA-256', buf as BufferSource) : null,
    ]);
    o.onProgress?.(size, size);
    return { ...(h ? { sha256: hex(h) } : {}), ...(l ? { leaf: hex(l).toUpperCase() } : {}), size, via: 'webcrypto' };
  }

  const hs = wantHash ? kernels.sha256Stream() : null;
  const ls = prefix ? kernels.sha256Stream() : null;
  if (prefix) ls!.update(prefix);
  const slice = Math.max(64 * 1024, o.sliceBytes ?? DIGEST_SLICE_BYTES);
  const read = (at: number): Promise<Uint8Array> | Uint8Array => {
    const end = Math.min(at + slice, size);
    return source instanceof Uint8Array ? source.subarray(at, end) : source.slice(at, end).arrayBuffer().then((b) => new Uint8Array(b));
  };
  // Read the next slice while this one is hashed, and feed both digests in
  // one call where the kernels can run them on two cores.
  let next = size ? read(0) : null;
  for (let at = 0; at < size; at += slice) {
    const piece = await next!;
    next = at + slice < size ? read(at + slice) : null;
    if (hs && ls && kernels.sha256UpdatePair) kernels.sha256UpdatePair(hs, ls, piece);
    else { hs?.update(piece); ls?.update(piece); }
    o.onProgress?.(at + piece.length, size);
  }
  if (!size) o.onProgress?.(0, 0);
  return { ...(hs ? { sha256: hex(hs.digest()) } : {}), ...(ls ? { leaf: hex(ls.digest()).toUpperCase() } : {}), size, via: kernels.backend };
}
