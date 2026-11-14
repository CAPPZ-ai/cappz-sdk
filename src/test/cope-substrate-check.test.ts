/** 15.40.1 — soul.md is checked once per page, shared by concurrent callers; a stub is retried and never amends. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapCopeSubstrate, COPE_STUB_RETRY_MS, principlesChainlet, resetCopeSubstrateCheck, sha256Hex, type PrincipleRecord } from '../lib/governance/PrinciplesChainlet';

const SOUL = '# soul.md\nCOPE substrate v1\n';
const record = async (content: string, version = 1): Promise<PrincipleRecord> => ({ id: 'cope', version, contentHash: await sha256Hex(content), path: `m/44'/144'/100'/principles/cope/v${version}` } as unknown as PrincipleRecord);

describe('bootstrapCopeSubstrate', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetCopeSubstrateCheck();
    fetchMock = vi.fn(async () => new Response(SOUL, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('a burst of saves reads soul.md once and adopts once', async () => {
    let adopted: PrincipleRecord | null = null;
    vi.spyOn(principlesChainlet, 'getLatest').mockImplementation(async () => adopted);
    const adopt = vi.spyOn(principlesChainlet, 'adopt').mockImplementation(async () => { adopted = await record(SOUL); return adopted; });
    const results = await Promise.all(Array.from({ length: 25 }, () => bootstrapCopeSubstrate()));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(new Set(results).size).toBe(1);
    await bootstrapCopeSubstrate(); await bootstrapCopeSubstrate();
    expect(fetchMock).toHaveBeenCalledTimes(1); // reused for the life of the page
  });

  it('still amends once when soul.md drifted', async () => {
    vi.spyOn(principlesChainlet, 'getLatest').mockResolvedValue(await record('# older soul.md\n'));
    const amend = vi.spyOn(principlesChainlet, 'amend').mockImplementation(async () => record(SOUL, 2));
    const [a, b] = await Promise.all([bootstrapCopeSubstrate(), bootstrapCopeSubstrate()]);
    expect(amend).toHaveBeenCalledTimes(1);
    expect(a).toBe(b); expect(a.version).toBe(2);
  });

  it('offline: the stub never amends the real principle, and the check is retried later', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-14T10:00:00Z') });
    fetchMock.mockRejectedValue(new TypeError('offline'));
    const real = await record(SOUL);
    vi.spyOn(principlesChainlet, 'getLatest').mockResolvedValue(real);
    const amend = vi.spyOn(principlesChainlet, 'amend');
    expect(await bootstrapCopeSubstrate()).toBe(real);
    expect(amend).not.toHaveBeenCalled();
    await bootstrapCopeSubstrate();
    expect(fetchMock).toHaveBeenCalledTimes(1); // within the retry window: reused
    vi.setSystemTime(Date.now() + COPE_STUB_RETRY_MS);
    fetchMock.mockResolvedValue(new Response(SOUL, { status: 200 }));
    expect(await bootstrapCopeSubstrate()).toBe(real);
    expect(fetchMock).toHaveBeenCalledTimes(2); // retried once the window passed
    await bootstrapCopeSubstrate();
    expect(fetchMock).toHaveBeenCalledTimes(2); // a real read is kept
  });

  it('a failed check is not reused: the next call tries again', async () => {
    const getLatest = vi.spyOn(principlesChainlet, 'getLatest').mockRejectedValueOnce(new Error('store unavailable')).mockResolvedValue(await record(SOUL));
    await expect(bootstrapCopeSubstrate()).rejects.toThrow('store unavailable');
    await expect(bootstrapCopeSubstrate()).resolves.toMatchObject({ id: 'cope' });
    expect(getLatest).toHaveBeenCalledTimes(2);
  });
});
