// @vitest-environment node
/** v15-12-05 — the hosted mirror is optional: with nothing registered the SDK stays local. */
import { describe, it, expect } from 'vitest';
import { hasHostedClient, hostedClient, registerHostedClient } from '../hostedBackend';

describe('hosted backend port', () => {
  it('local-only: reads are empty, writes and functions answer an error, nothing throws', async () => {
    registerHostedClient('routed', null); registerHostedClient('direct', null);
    expect(hasHostedClient()).toBe(false);
    const read = await hostedClient().from('chainlet_blocks').select('*', { count: 'exact' }).eq('id', 'x').order('block_number', { ascending: false }).range(0, 9);
    expect(read).toEqual({ data: [], error: null, count: 0 });
    const write = await hostedClient('direct').from('chainlet_blocks').insert([{ id: 1 }]);
    expect(write.error?.message).toMatch(/no hosted backend/);
    const fn = await hostedClient().functions!.invoke('repoz-merge-assist', { body: {} });
    expect(String((fn.error as { message: string }).message)).toMatch(/repoz-merge-assist: no hosted backend/);
  });

  it('a registered client is used; direct falls back to routed', () => {
    const client = { from: () => 'q' };
    registerHostedClient('routed', client);
    expect(hostedClient()).toBe(client);
    expect(hostedClient('direct')).toBe(client);
    const direct = { from: () => 'd' };
    registerHostedClient('direct', direct);
    expect(hostedClient('direct')).toBe(direct);
    registerHostedClient('routed', null); registerHostedClient('direct', null);
  });
});
