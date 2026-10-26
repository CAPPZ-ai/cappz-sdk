import { describe, it, expect } from 'vitest';
import { intakeQuarantined, operatorDecision, replayQuarantine, sniffType, DEFAULT_QUARANTINE_POLICY, DMZ_EVENT_TYPES } from '../lib/sync/quarantine';
import { getEventTxRegistryEntry } from '../lib/skills/core/MDMEventTxRegistry';
import { transportTypeAddress } from '../lib/wallets/paths';

const node = "m/44'/144'/0'/cappz/operational/dmz-node";
const enc = (s: string) => new TextEncoder().encode(s);
const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const http = { kind: 'http-drop' as const, transportType: transportTypeAddress('http-drop') };

describe('v15-09-00 DMZ quarantine', () => {
  it('sniffs types from bytes, never from names', () => {
    expect(sniffType(pdf)).toBe('application/pdf');
    expect(sniffType(Uint8Array.from([0x4d, 0x5a, 0x90, 0]))).toBe('application/x-executable');
    expect(sniffType(enc('<?xml version="1.0"?><Document/>'))).toBe('application/xml');
    expect(sniffType(enc('{"a":1}'))).toBe('application/json');
    expect(sniffType(enc('id,amount\n1,2\n'))).toBe('text/plain');
    expect(sniffType(Uint8Array.from([1, 0, 2, 3]))).toBe('application/octet-stream');
  });

  it('a clean ISO 20022 XML drop is released by policy, with every check recorded', async () => {
    const r = await intakeQuarantined({ nodeAddress: node, bytes: enc('<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"/>'), name: 'pain001.xml', declaredType: 'application/xml', source: http });
    expect(r.decision).toBe('released');
    expect(r.txs.map((t) => t.eventType)).toEqual(['ContentQuarantined', ...Array(5).fill('QuarantineCheckRecorded'), 'ContentReleased']);
    for (const t of r.txs) { expect(t.targetAddress).toBe(`${node}/dmz/quarantine/${r.sha256}`); expect(t.payload.governingPrinciple).toBeTruthy(); }
    const [e] = replayQuarantine(r.txs);
    expect(e).toEqual(expect.objectContaining({ state: 'released', decidedBy: 'policy' }));
    expect(e.checks.find((c) => c.check === 'sender-signature')?.result).toBe('not-evaluated');
    expect(e.checks.find((c) => c.check === 'malware-scan')?.result).toBe('not-evaluated');
  });

  it('executables, type lies, digest mismatches and bad signatures are rejected with the reason', async () => {
    const exe = await intakeQuarantined({ nodeAddress: node, bytes: Uint8Array.from([0x4d, 0x5a, 0, 0, 1]), name: 'invoice.pdf', declaredType: 'application/pdf', source: http });
    expect(exe).toEqual(expect.objectContaining({ decision: 'rejected' }));
    expect(exe.because).toMatch(/executable/);
    const lie = await intakeQuarantined({ nodeAddress: node, bytes: enc('just text'), name: 'x.pdf', declaredType: 'application/pdf', source: http });
    expect(lie.because).toMatch(/declared application\/pdf/);
    const digest = await intakeQuarantined({ nodeAddress: node, bytes: pdf, name: 'a.pdf', source: { ...http, declaredSha256: '00'.repeat(32) } });
    expect(digest.because).toMatch(/^hash:/);
    const forged = await intakeQuarantined({ nodeAddress: node, bytes: pdf, name: 'a.pdf', source: { ...http, verdict: { signature: 'bad-signature', trust: 'undeclared', content: 'not-checked' } } });
    expect(forged.because).toMatch(/^sender-signature:/);
    const virus = await intakeQuarantined({ nodeAddress: node, bytes: pdf, name: 'a.pdf', source: http, external: { 'malware-scan': { result: 'fail', reason: 'EICAR' } } });
    expect(virus.decision).toBe('rejected');
  });

  it('a check the policy requires but cannot evaluate holds the file; only a listed operator decides', async () => {
    const policy = { ...DEFAULT_QUARANTINE_POLICY, required: [...DEFAULT_QUARANTINE_POLICY.required, 'malware-scan' as const], operators: ['wallet-op'] };
    const r = await intakeQuarantined({ nodeAddress: node, bytes: pdf, name: 'a.pdf', source: http, policy });
    expect(r.decision).toBe('held');
    expect(replayQuarantine(r.txs, policy)[0].state).toBe('held');
    expect(() => operatorDecision(node, r.sha256, 'release', 'stranger', 'looks fine', policy)).toThrow(/listed DMZ operator/);
    const ok = operatorDecision(node, r.sha256, 'release', 'wallet-op', 'scanned offline', policy, Date.now() + 10_000);
    const forged = { ...ok, txId: 'x', payload: { ...ok.payload, decidedBy: 'stranger' }, timestamp: new Date(Date.now() + 20_000).toISOString(), eventType: 'ContentRejected' };
    const e = replayQuarantine([...r.txs, ok, forged], policy)[0];
    expect(e).toEqual(expect.objectContaining({ state: 'released', decidedBy: 'wallet-op' }));
  });

  it('a valid signature from an undeclared key is not-evaluated (never worse than unsigned); a revoked key fails', async () => {
    const und = await intakeQuarantined({ nodeAddress: node, bytes: pdf, name: 'a.pdf', source: { ...http, verdict: { signature: 'verified', trust: 'undeclared', content: 'digest-match' } } });
    expect(und.decision).toBe('released');
    expect(replayQuarantine(und.txs)[0].checks.find((c) => c.check === 'sender-signature')?.result).toBe('not-evaluated');
    const rev = await intakeQuarantined({ nodeAddress: node, bytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x0b]), name: 'b.pdf', source: { ...http, verdict: { signature: 'verified', trust: 'revoked', content: 'digest-match' } } });
    expect(rev.decision).toBe('rejected');
  });

  it('a signed sender with a declared key passes the sender check', async () => {
    const r = await intakeQuarantined({ nodeAddress: node, bytes: pdf, name: 'a.pdf', source: { ...http, verdict: { signature: 'verified', trust: 'declared', content: 'digest-match', walletAddress: 'w' } } });
    expect(replayQuarantine(r.txs)[0].checks.find((c) => c.check === 'sender-signature')?.result).toBe('pass');
  });

  it('every DMZ event is MDM-declared', () => {
    for (const e of DMZ_EVENT_TYPES) expect(getEventTxRegistryEntry(e), e).toBeTruthy();
  });
});
