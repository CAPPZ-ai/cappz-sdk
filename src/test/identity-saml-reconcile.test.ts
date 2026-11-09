import { describe, it, expect } from 'vitest';
import { reconcileSamlLogins, issuedFromOktaSystemLog, issuedFromEntraSignIns, loginsFromRecords, parseCsv, sealIssuedBatch, openSealedBatches, hashLogins, type IssuedAssertion, type SpLogin } from '../lib/identity/samlReconcile';
import { generateSigningKey } from '../lib/sync/helloSignature';

const T = Date.parse('2026-10-19T09:00:00Z');
const m = (n: number) => T + n * 60_000;
const iss = (at: number, subject = 'alice@corp.com', app = 'Saas'): IssuedAssertion => ({ at, subject, app, source: 'idp' });
const login = (at: number, subject = 'alice@corp.com', app = 'saas', extra: Partial<SpLogin> = {}): SpLogin => ({ at, subject, app, source: 'saas', ...extra });

describe('15.36.0 SAML login reconciliation', () => {
  it('a SaaS login with no IdP issuance is an orphan — the forged-assertion signal', async () => {
    const r = await reconcileSamlLogins([iss(m(0)), iss(m(60), 'bob@corp.com')], [login(m(1)), login(m(61), 'bob@corp.com'), login(m(30), 'ceo@corp.com', 'saas', { ip: '203.0.113.9' })]);
    expect(r.counts).toMatchObject({ matched: 2, orphan: 1 });
    expect(r.verdict).toBe('findings');
    expect(r.findings[0]).toMatchObject({ state: 'orphan', subject: 'ceo@corp.com', ip: '203.0.113.9' });
    expect(r.summary).toMatch(/1 SaaS login/);
    expect(r.reportHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('one assertion, two sessions is reuse; the same login logged twice is not', async () => {
    const r = await reconcileSamlLogins([iss(m(0))], [login(m(1)), login(m(1) + 3000), login(m(3))]);
    expect(r.counts).toMatchObject({ matched: 1, reused: 1 });
  });

  it('matches by assertion ID when both logs carry it, and catches an ID issued to someone else', async () => {
    const issued = [{ ...iss(m(0)), assertionId: '_x1' }, { ...iss(m(0), 'bob@corp.com'), assertionId: '_x2' }];
    const r = await reconcileSamlLogins(issued, [login(m(1), 'alice@corp.com', 'saas', { assertionId: '_x1' }), login(m(2), 'admin@corp.com', 'saas', { assertionId: '_x2' }), login(m(3), 'alice@corp.com', 'saas', { assertionId: '_x1' })]);
    expect(r.counts).toMatchObject({ matched: 1, orphan: 1, reused: 1 });
    expect(r.findings.find((f) => f.state === 'orphan')!.because).toMatch(/different subject/);
  });

  it('gaps are their own state, never clean: unmapped apps and logins outside the export', async () => {
    const r = await reconcileSamlLogins([iss(m(0)), iss(m(10))], [login(m(1)), login(m(5), 'alice@corp.com', 'HR Portal'), login(m(500))]);
    expect(r.counts).toMatchObject({ matched: 1, 'unmapped-app': 1, 'outside-coverage': 1 });
    expect(r.verdict).toBe('gaps-only');
    const mapped = await reconcileSamlLogins([iss(m(0), 'alice@corp.com', 'HR (Okta)')], [login(m(1), 'ALICE@corp.com', 'HR Portal')], { apps: { 'HR (Okta)': 'hr', 'HR Portal': 'hr' } });
    expect(mapped.verdict).toBe('clean');
  });

  it('reads Okta and Entra exports and any CSV by field mapping', async () => {
    const okta = issuedFromOktaSystemLog([
      { uuid: 'u1', eventType: 'user.authentication.sso', outcome: { result: 'SUCCESS' }, published: '2026-10-19T09:00:00.000Z', actor: { alternateId: 'alice@corp.com' }, target: [{ type: 'AppInstance', displayName: 'Saas' }] },
      { uuid: 'u2', eventType: 'user.authentication.sso', outcome: { result: 'FAILURE' }, published: '2026-10-19T09:00:00.000Z', actor: { alternateId: 'eve@corp.com' }, target: [{ type: 'AppInstance', displayName: 'Saas' }] },
    ]);
    expect(okta).toEqual([{ at: T, subject: 'alice@corp.com', app: 'Saas', source: 'okta:u1' }]);
    const entra = issuedFromEntraSignIns([{ id: 'e1', createdDateTime: '2026-10-19T09:00:00Z', userPrincipalName: 'bob@corp.com', appDisplayName: 'Saas', status: { errorCode: 0 } }, { id: 'e2', createdDateTime: '2026-10-19T09:00:00Z', userPrincipalName: 'x@corp.com', appDisplayName: 'Saas', status: { errorCode: 50126 } }]);
    expect(entra.map((e) => e.subject)).toEqual(['bob@corp.com']);
    const csv = parseCsv('time,user,event,"note, quoted"\r\n2026-10-19T09:01:00Z,alice@corp.com,sso_login,"a ""b"""\n2026-10-19T09:02:00Z,eve@corp.com,password_login,\n');
    expect(csv[0]['note, quoted']).toBe('a "b"');
    const logins = loginsFromRecords(csv, { at: 'time', subject: 'user', app: { constant: 'saas' }, where: { event: 'sso_login' } });
    expect(logins).toHaveLength(1);
    expect((await reconcileSamlLogins([...okta, ...entra], logins)).verdict).toBe('clean');
  });

  it('sealed issuance batches: hashed subjects, signed, chained — a removed batch or edited row is visible', async () => {
    const node = await generateSigningKey();
    const b1 = await sealIssuedBatch([iss(m(0))], { salt: 's', previous: null, key: node });
    const b2 = await sealIssuedBatch([iss(m(60), 'bob@corp.com')], { salt: 's', previous: b1.batchHash, key: node });
    const b3 = await sealIssuedBatch([iss(m(120), 'carol@corp.com')], { salt: 's', previous: b2.batchHash, key: node });
    expect(JSON.stringify(b1)).not.toContain('alice');
    const ok = await openSealedBatches([b1, b2, b3], [node.publicKeyHex]);
    expect(ok.ok).toBe(true);
    expect((await openSealedBatches([b1, b3], [node.publicKeyHex])).because).toMatch(/chain broken/);
    expect((await openSealedBatches([b1, { ...b2, items: [] }, b3], [node.publicKeyHex])).because).toMatch(/changed after sealing/);
    expect((await openSealedBatches([b1], ['00'.repeat(32)])).because).toMatch(/not trusted/);
    const logins = await hashLogins([login(m(1)), login(m(61), 'bob@corp.com'), login(m(90), 'mallory@corp.com')], 's');
    const r = await reconcileSamlLogins(ok.issued, logins);
    expect(r.counts).toMatchObject({ matched: 2, orphan: 1 });
  });
});
