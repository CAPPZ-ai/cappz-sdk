import { afterEach, describe, expect, it, vi } from 'vitest';
import { gzipBytes, gunzipBytes, isGzip } from '../lib/sync/storageEngines/kvBackends';

describe('gzip without CompressionStream (Safari < 16.4)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('gzips and gunzips through the fflate fallback', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    vi.stubGlobal('DecompressionStream', undefined);
    const raw = new TextEncoder().encode('<bpmn:definitions/>'.repeat(50));
    const gz = await gzipBytes(raw);
    expect(isGzip(gz)).toBe(true);
    expect(Array.from(await gunzipBytes(gz))).toEqual(Array.from(raw));
  });

  it('fallback output is readable by the native stream and vice versa', async () => {
    if (typeof CompressionStream === 'undefined') return;
    const raw = new TextEncoder().encode('cappz '.repeat(200));
    const native = await gzipBytes(raw);
    vi.stubGlobal('CompressionStream', undefined);
    vi.stubGlobal('DecompressionStream', undefined);
    const fallback = await gzipBytes(raw);
    expect(Array.from(await gunzipBytes(native))).toEqual(Array.from(raw));
    vi.unstubAllGlobals();
    expect(Array.from(await gunzipBytes(fallback))).toEqual(Array.from(raw));
  });
});
