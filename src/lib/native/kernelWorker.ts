/**
 * COPE node crystallized.
 * Node ID: v15-17-00-kernel-worker
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * One thread of a kernel pool (kernelPool.ts): loads the core WASM module
 * (checked against its pinned hash) and answers jobs. Apps start it with a
 * one-line module that calls startKernelWorker(); the handler is exported on
 * its own so tests can run it in-process.
 */
import { loadWasmKernels, typescriptKernels, type NativeKernels } from './cappzNative';

export type KernelJob =
  | { id: number; type: 'init'; wasm?: ArrayBuffer }
  | { id: number; type: 'gf'; coeffs: Uint8Array; rows: number; k: number; inputs: Uint8Array; len: number }
  | { id: number; type: 'sha'; data: Uint8Array; chunk: number };

export type KernelReply =
  | { id: number; ok: true; backend?: string; out?: Uint8Array }
  | { id: number; ok: false; error: string };

export interface KernelWorkerState { kernels: NativeKernels }

export function createKernelWorkerState(): KernelWorkerState {
  return { kernels: typescriptKernels };
}

/** Answer one job. Returns the reply and the buffers to transfer back. */
export async function handleKernelJob(state: KernelWorkerState, job: KernelJob): Promise<{ reply: KernelReply; transfer: ArrayBuffer[] }> {
  try {
    if (job.type === 'init') {
      if (job.wasm) state.kernels = await loadWasmKernels(new Uint8Array(job.wasm));
      return { reply: { id: job.id, ok: true, backend: state.kernels.backend }, transfer: [] };
    }
    if (job.type === 'gf') {
      const out = state.kernels.gfMatmul(job.coeffs, job.rows, job.k, job.inputs, job.len, 1);
      return { reply: { id: job.id, ok: true, out }, transfer: [out.buffer as ArrayBuffer] };
    }
    // Hashing: WebCrypto (the CPU's SHA instructions in a browser) when this thread has it.
    const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
    const n = Math.ceil(job.data.length / job.chunk);
    const out = new Uint8Array(n * 32);
    if (subtle && !state.kernels.features.shaInstructions) {
      for (let i = 0; i < n; i++) {
        out.set(new Uint8Array(await subtle.digest('SHA-256', job.data.subarray(i * job.chunk, (i + 1) * job.chunk) as BufferSource)), i * 32);
      }
    } else {
      state.kernels.sha256Chunks(job.data, job.chunk).forEach((d, i) => out.set(d, i * 32));
    }
    return { reply: { id: job.id, ok: true, out }, transfer: [out.buffer as ArrayBuffer] };
  } catch (err) {
    return { reply: { id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) }, transfer: [] };
  }
}

/** Wire the handler to this worker's message port. Call once from the worker entry module. */
export function startKernelWorker(): void {
  const state = createKernelWorkerState();
  const port = globalThis as unknown as { onmessage: ((e: MessageEvent<KernelJob>) => void) | null; postMessage(m: unknown, t: Transferable[]): void };
  port.onmessage = (e) => {
    void handleKernelJob(state, e.data).then(({ reply, transfer }) => port.postMessage(reply, transfer));
  };
}
