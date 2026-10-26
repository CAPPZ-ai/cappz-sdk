import { describe, it, expect } from 'vitest';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../lib/auth/wallet/session';
import { generateSigningKey } from '../lib/sync/helloSignature';
import { declareHelloKey } from '../lib/sync/helloKeyDeclaration';
import { createVerifyGateway, signRequest, requestSigner } from '../lib/identity/edgeVerify';
import { createLegacyGateway, memoryQuarantineStore } from '../lib/sync/transports/legacyGateway';
import { checkSource, curlPlan, parseListing, planPull, recordableRemote, seenKey } from '../lib/sync/transports/legacyPull';
import { DEFAULT_QUARANTINE_POLICY } from '../lib/sync/quarantine';
import type { KeyEvidence } from '../lib/identity/keyDeclaration';

const node = "m/44'/144'/0'/cappz/operational/dmz-node";
const base = 'http://dmz.local:41447';
const xml = '<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"/>';

async function setup(policy = DEFAULT_QUARANTINE_POLICY) {
  const op = keyPairFromPhrase(generateRecoveryPhrase()); const dev = await generateSigningKey();
  const ev: KeyEvidence = { declarations: [await declareHelloKey(op.privateKey, op.address, dev.publicKeyHex)] };
  const verify = createVerifyGateway({ evidence: { evidenceFor: async () => ev } });
  const store = memoryQuarantineStore();
  const gw = createLegacyGateway({ nodeAddress: node, store, verify, policy: { ...policy, operators: [op.address] }, directory: async () => ({ entries: [{ name: 'dmz-node' }] }) });
  const signed = async (method: string, path: string, body?: string) => {
    const b = body !== undefined ? new TextEncoder().encode(body) : undefined;
    const h = await signRequest({ method, url: base + path, body: b, walletAddress: op.address }, requestSigner(dev));
    if (b) h.set('content-type', 'application/json');
    return new Request(base + path, { method, headers: h, body: b });
  };
  return { gw, store, op, signed };
}

describe('v15-09-00 legacy front end (HTTP drop, receipts, released listing, operator decisions)', () => {
  it('an unsigned curl-style drop is quarantined, released by policy, listed, and fetchable by hash', async () => {
    const { gw, store } = await setup();
    const res = await gw.handle(new Request(`${base}/legacy/v1/drop/statement.xml`, { method: 'PUT', body: xml, headers: { 'content-type': 'application/xml' } }));
    expect(res.status).toBe(201);
    const r = await res.json();
    expect(r.state).toBe('released');
    expect(r.checks.find((c: { check: string }) => c.check === 'sender-signature').result).toBe('not-evaluated');
    const again = await (await gw.handle(new Request(`${base}/legacy/v1/drop/copy.xml`, { method: 'POST', body: xml }))).json();
    expect(again).toEqual(expect.objectContaining({ duplicate: true, sha256: r.sha256 }));
    expect(store.txs.filter((t) => t.eventType === 'ContentQuarantined')).toHaveLength(1);
    const list = await (await gw.handle(new Request(`${base}/legacy/v1/released`))).json();
    expect(list.files.map((f: { name: string }) => f.name)).toEqual(['statement.xml']);
    expect(await (await gw.handle(new Request(`${base}/legacy/v1/released?format=text`))).text()).toContain(`${r.sha256}  `);
    const file = await gw.handle(new Request(`${base}/legacy/v1/objects/${r.sha256}`));
    expect(file.headers.get('cappz-content-sha256')).toBe(r.sha256);
    expect(await file.text()).toBe(xml);
  });

  it('a rejected drop answers 422 with the reason, and its bytes are never served', async () => {
    const { gw } = await setup();
    const res = await gw.handle(new Request(`${base}/legacy/v1/drop/run.exe`, { method: 'POST', body: Uint8Array.from([0x4d, 0x5a, 0, 0]) }));
    expect(res.status).toBe(422);
    const r = await res.json();
    expect(r.because).toMatch(/executable/);
    expect((await gw.handle(new Request(`${base}/legacy/v1/objects/${r.sha256}`))).status).toBe(409);
  });

  it('a held drop waits for a signed operator decision; unsigned or unlisted decisions are refused', async () => {
    const { gw, signed } = await setup({ ...DEFAULT_QUARANTINE_POLICY, required: [...DEFAULT_QUARANTINE_POLICY.required, 'malware-scan'] });
    const res = await gw.handle(new Request(`${base}/legacy/v1/drop/report.pdf`, { method: 'POST', body: Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x0a]) }));
    expect(res.status).toBe(202);
    const { sha256 } = await res.json();
    expect((await gw.handle(new Request(`${base}/legacy/v1/objects/${sha256}`))).status).toBe(409);
    expect((await gw.handle(new Request(`${base}/legacy/v1/decide/${sha256}`, { method: 'POST', body: '{"decision":"release"}' }))).status).toBe(401);
    const ok = await gw.handle(await signed('POST', `/legacy/v1/decide/${sha256}`, JSON.stringify({ decision: 'release', because: 'scanned on the analyst workstation' })));
    expect(ok.status).toBe(200);
    expect((await ok.json()).state).toBe('released');
    expect((await gw.handle(new Request(`${base}/legacy/v1/objects/${sha256}`))).status).toBe(200);
  });

  it('a signed drop passes the sender check; oversize drops are refused before reading', async () => {
    const { gw, signed } = await setup();
    const r = await (await gw.handle(await signed('POST', '/legacy/v1/drop/data.json', '{"rows":[1,2,3]}'))).json();
    expect(r.checks.find((c: { check: string }) => c.check === 'sender-signature')).toEqual(expect.objectContaining({ result: 'pass' }));
    const big = await gw.handle(new Request(`${base}/legacy/v1/drop/big.bin`, { method: 'POST', body: 'x', headers: { 'content-length': String(DEFAULT_QUARANTINE_POLICY.maxBytes + 1) } }));
    expect(big.status).toBe(413);
    expect((await (await gw.handle(new Request(`${base}/legacy/v1/directory`))).json()).entries[0].name).toBe('dmz-node');
  });
});

describe('v15-09-00 CAPPZ FTP client plan (curl)', () => {
  const src = { id: 'bank-a', url: 'ftps://ftp.bank-a.example/outbox/', userEnv: 'BANK_A_USER', passEnv: 'BANK_A_PASS', suffix: '.xml' };

  it('credentials go on stdin, never in argv; TLS is required for FTPS; protocols are pinned', () => {
    const p = curlPlan(src, 'get', { BANK_A_USER: 'acme', BANK_A_PASS: 's3cr"et' }, 'camt053 2026-10-26.xml');
    expect(p.args.join(' ')).not.toContain('acme');
    expect(p.args.join(' ')).not.toContain('s3cr');
    expect(p.args).toEqual(expect.arrayContaining(['--config', '-', '--ssl-reqd', '--proto', '=ftps', '--fail']));
    expect(p.stdin).toContain('user = "acme:s3cr\\"et"');
    expect(p.stdin).toContain('url = "ftps://ftp.bank-a.example/outbox/camt053%202026-10-26.xml"');
    expect(curlPlan({ ...src, url: 'sftp://h/out/' }, 'list', {}).args).toEqual(expect.arrayContaining(['--list-only', '=sftp']));
    expect(() => curlPlan(src, 'get', {}, '../etc/passwd')).toThrow();
  });

  it('refuses credentials in URLs and plain FTP unless explicitly allowed', () => {
    expect(checkSource({ id: 'x', url: 'ftps://u:p@h/out/' })).toEqual(expect.objectContaining({ ok: false }));
    expect(checkSource({ id: 'x', url: 'ftp://h/out/' })).toEqual(expect.objectContaining({ ok: false }));
    expect(checkSource({ id: 'x', url: 'ftp://h/out/', allowPlainFtp: true })).toEqual({ ok: true, scheme: 'ftp' });
    expect(checkSource({ id: 'x', url: 'https://h/out/' })).toEqual(expect.objectContaining({ ok: false }));
    expect(recordableRemote('ftps://user:pw@h/out/?x=1')).toBe('ftps://h/out/');
  });

  it('plans only new files matching the suffix', () => {
    const names = parseListing('.\r\n..\r\na.xml\r\nb.XML\r\nnotes.txt\r\nsub/\r\n');
    expect(names).toEqual(['a.xml', 'b.XML', 'notes.txt']);
    expect(planPull(src, names, new Set([seenKey(src, 'a.xml')]))).toEqual(['b.XML']);
  });
});
