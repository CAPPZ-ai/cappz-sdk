import { describe, it, expect } from 'vitest';
import { dueTimers, parseTimerSchedules, signEdgeTx, timerFiredTx, verifyTimerTrigger } from '../lib/functions/edgeJobs';

const P = "m/44'/144'/100'/principles/cope/v1";
const bpmn = (attrs: string) => `<bpmn:startEvent id="T" cappz:function="schedule-reminders" cappz:governingPrinciple="${P}" ${attrs}><bpmn:timerEventDefinition><bpmn:timeCycle>R/PT5M</bpmn:timeCycle></bpmn:timerEventDefinition></bpmn:startEvent>`;
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
async function nodeKey() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicKeyHex: hex(await crypto.subtle.exportKey('raw', pair.publicKey)) };
}

describe('15.19.0 trigger timers', () => {
  it('a timer with an https trigger is bound without a local job; other URLs are refused', () => {
    const { schedules } = parseTimerSchedules(bpmn('cappz:trigger="https://x.supabase.co/functions/v1/schedule-reminders"'));
    expect(schedules[0].trigger).toBe('https://x.supabase.co/functions/v1/schedule-reminders');
    expect(dueTimers(schedules, {}, 0, {}).due).toHaveLength(1);
    expect(parseTimerSchedules(bpmn('cappz:trigger="http://169.254.169.254/latest"')).rejected[0].reason).toMatch(/https/);
    expect(dueTimers(parseTimerSchedules(bpmn('')).schedules, {}, 0, {}).unbound).toEqual(['schedule-reminders']);
  });

  it('the receiver accepts only a fresh, signed TimerFired for its function from an allowlisted node', async () => {
    const { schedules } = parseTimerSchedules(bpmn('cappz:trigger="https://x.supabase.co/functions/v1/schedule-reminders"'));
    const node = await nodeKey(); const stranger = await nodeKey();
    const now = Date.parse('2026-10-31T12:00:00Z');
    const fired = (k: typeof node, at = new Date(now - 1000).toISOString()) => timerFiredTx(schedules[0], 'm/node', at).then((t) => signEdgeTx(t, k));
    const allowed = [node.publicKeyHex];
    expect((await verifyTimerTrigger(await fired(node), { functionName: 'schedule-reminders', allowedNodeKeys: allowed, now })).ok).toBe(true);
    expect(await verifyTimerTrigger(await fired(stranger), { functionName: 'schedule-reminders', allowedNodeKeys: allowed, now })).toEqual({ ok: false, reason: 'unknown-node' });
    expect(await verifyTimerTrigger(await fired(node), { functionName: 'dms-trigger-executor', allowedNodeKeys: allowed, now })).toEqual({ ok: false, reason: 'wrong-function' });
    expect(await verifyTimerTrigger(await fired(node, new Date(now - 11 * 60_000).toISOString()), { functionName: 'schedule-reminders', allowedNodeKeys: allowed, now })).toEqual({ ok: false, reason: 'stale' });
    const t = await fired(node);
    expect(await verifyTimerTrigger({ ...t, payload: { ...t.payload, functionName: 'other' } }, { functionName: 'other', allowedNodeKeys: allowed, now })).toEqual({ ok: false, reason: 'bad-signature' });
    expect(await verifyTimerTrigger({ hello: 1 }, { functionName: 'schedule-reminders', allowedNodeKeys: allowed, now })).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('timer parsing', () => {
  it('a self-closing start event before a timer does not swallow it', () => {
    const xml = `<bpmn:startEvent id="NodeStarted" name="NodeStarted"/>\n${bpmn('cappz:trigger="https://x.supabase.co/functions/v1/schedule-reminders"')}`;
    const { schedules, rejected } = parseTimerSchedules(xml);
    expect(rejected).toEqual([]);
    expect(schedules.map((s) => s.eventId)).toEqual(['T']);
  });
});
