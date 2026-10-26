/**
 * COPE node crystallized. Node ID: v15-01-02-opfs-write-worker
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Dedicated-worker OPFS writer for browsers without main-thread
 * `createWritable()` (iOS/macOS Safari before 26). Sync access handles are
 * exclusive per file, so writes are serialized through one queue.
 */

type WriteRequest = { id: number; path: string[]; bytes: ArrayBuffer };

interface SyncAccessHandle {
  truncate(size: number): void;
  write(buffer: ArrayBufferView | ArrayBuffer, opts?: { at?: number }): number;
  flush(): void;
  close(): void;
}

let queue: Promise<void> = Promise.resolve();

async function writeFile(path: string[], bytes: ArrayBuffer): Promise<void> {
  let dir = await navigator.storage.getDirectory();
  for (const segment of path.slice(0, -1)) dir = await dir.getDirectoryHandle(segment, { create: true });
  const handle = await dir.getFileHandle(path[path.length - 1], { create: true });
  const access = await (handle as unknown as { createSyncAccessHandle(): Promise<SyncAccessHandle> }).createSyncAccessHandle();
  try {
    access.truncate(0);
    access.write(new Uint8Array(bytes), { at: 0 });
    access.flush();
  } finally {
    access.close();
  }
}

self.onmessage = (msg: MessageEvent<WriteRequest>) => {
  const { id, path, bytes } = msg.data;
  queue = queue.then(() => writeFile(path, bytes)).then(
    () => (self as unknown as Worker).postMessage({ id, ok: true }),
    (err) => (self as unknown as Worker).postMessage({ id, ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }),
  );
};
