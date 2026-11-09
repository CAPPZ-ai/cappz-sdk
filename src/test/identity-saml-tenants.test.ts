import { describe, it, expect } from 'vitest';
import fx from './fixtures/saml-signed.json';
import { createSamlGuard, declareIdpPin, signTenantMode, replaySamlTenantModes, type SamlTenant, type SamlMultiReport } from '../lib/identity/samlGuard';
import { exclusiveC14n } from '../lib/identity/samlXmlDsig';
import { parseStrictXml } from '../lib/identity/samlGuard';
import { idpFromMetadata, lintSamlTenants } from '../lib/identity/samlTenants';
import { generateSigningKey } from '../lib/sync/helloSignature';

// Fixtures: signed by signxml (lxml C14N), an independent implementation — see the generator note in the docs.
const NOW = Date.parse('2026-11-09T12:00:00Z');
const ACME_ACS = 'https://saas.example.com/saml/acs/acme';
const GLOBEX_ACS = 'https://saas.example.com/saml/acs/globex';

async function setup(extra: Partial<SamlTenant> = {}) {
  const operator = await generateSigningKey();
  const pinAcme = await declareIdpPin({ idpEntityId: 'https://idp.acme.example/saml', certificate: fx.certs.acme, expiresAt: '2027-11-09T00:00:00Z', tenantId: 'acme' }, operator);
  const pinGlobex = await declareIdpPin({ idpEntityId: 'https://idp.globex.example/saml', certificate: fx.certs.globex, expiresAt: '2027-11-09T00:00:00Z', tenantId: 'globex' }, operator);
  const pins = [pinAcme, pinGlobex];
  const common = { pins, trustedPinSigners: [operator.publicKeyHex], allowUnsolicited: true };
  const tenants: SamlTenant[] = [
    { id: 'acme', idpEntityId: 'https://idp.acme.example/saml', spEntityId: 'https://saas.example.com/saml/acme', acsUrls: [ACME_ACS], ...common, ...extra },
    { id: 'globex', idpEntityId: 'https://idp.globex.example/saml', spEntityId: 'https://saas.example.com/saml/globex', acsUrls: [GLOBEX_ACS], ...common },
  ];
  return { operator, tenants, pins };
}
const post = (acs: string, xml: string) => new Request(acs, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ SAMLResponse: btoa(xml) }).toString() });
const laxSp = async () => new Response(null, { status: 302, headers: { location: '/', 'set-cookie': 'sid=1' } }); // an SP that accepts anything

describe('15.37.0 built-in XML signature verification (exclusive C14N, RSA/ECDSA, pinned keys)', () => {
  it('verifies responses signed by an independent implementation: assertion- and response-signed RSA, RSA-SHA512, ECDSA P-256', async () => {
    const { tenants } = await setup();
    const g = createSamlGuard({ tenants, mode: 'enforce', upstream: laxSp, now: () => NOW });
    for (const k of ['acmeAssertionSigned', 'acmeResponseSigned', 'acmeSha512'] as const) expect(await g.checkFor('acme', fx[k])).toMatchObject({ allowed: true, signature: 'verified', certificate: 'pinned', tenant: 'acme' });
    expect(await g.checkFor('globex', fx.globexEcdsa)).toMatchObject({ allowed: true, signature: 'verified' });
  });

  it('a changed byte anywhere under the signature fails the digest; a swapped signature fails verification', async () => {
    const { tenants } = await setup();
    const g = createSamlGuard({ tenants, mode: 'enforce', upstream: laxSp, now: () => NOW });
    expect((await g.checkFor('acme', fx.acmeAssertionSigned.replace('alice@acme.example', 'admin@acme.example'))).reason).toBe('bad-digest');
    expect((await g.checkFor('acme', fx.acmeAssertionSigned.replace('admin &amp; &lt;owner&gt;', 'admin'))).reason).toBe('bad-digest');
    const sv = /<ds:SignatureValue>([^<]+)</.exec(fx.acmeSha512)![1];
    expect((await g.checkFor('acme', fx.acmeAssertionSigned.replace(/<ds:SignatureValue>[^<]+</, `<ds:SignatureValue>${sv}<`))).reason).toBe('bad-signature');
  });

  it('a broken SP that accepts any signature is still covered: a forged signature is refused before it', async () => {
    const { tenants } = await setup();
    const g = createSamlGuard({ tenants, mode: 'enforce', upstream: laxSp, now: () => NOW });
    const forged = fx.acmeAssertionSigned.replace(/<ds:DigestValue>[^<]+</, '<ds:DigestValue>AAAA<');
    expect((await g.handle(post(ACME_ACS, forged))).status).toBe(403);
  });

  it('canonical form: namespaces used below are re-declared, attributes sorted, text escaped, empty elements expanded', () => {
    const el = parseStrictXml('<a:r xmlns:a="u:a" xmlns:b="u:b" z="1" b:y="2" a="&quot;"><a:e/>x &amp; &lt;y&gt;\n</a:r>');
    expect(exclusiveC14n(el)).toBe('<a:r xmlns:a="u:a" xmlns:b="u:b" a="&quot;" z="1" b:y="2"><a:e></a:e>x &amp; &lt;y&gt;\n</a:r>');
    expect(exclusiveC14n(el.children[0])).toBe('<a:e xmlns:a="u:a"></a:e>');
  });
});

describe('15.37.0 multi-tenant SAML Guard', () => {
  it("customer B's validly signed assertion cannot log into customer A: refused as cross-tenant", async () => {
    const { tenants } = await setup();
    const g = createSamlGuard({ tenants, mode: 'enforce', upstream: laxSp, now: () => NOW });
    const res = await g.handle(post(ACME_ACS, fx.globexIntoAcme));
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe('cross-tenant');
    const v = await g.checkFor('acme', fx.globexIntoAcme);
    expect(v.detail).toMatch(/names tenant globex, posted to tenant acme/);
    expect((await g.handle(post(GLOBEX_ACS, fx.acmeAssertionSigned))).status).toBe(403);
    const rep = await g.report() as SamlMultiReport;
    expect(rep.tenants.acme.crossTenant).toBe(1);
    expect(rep.tenants.globex.crossTenant).toBe(1);
  });

  it('the tenant comes from the login URL, never from the response; an unmatched ACS host is refused', async () => {
    const { tenants } = await setup();
    const seen: Request[] = [];
    const g = createSamlGuard({ tenants, mode: 'enforce', upstream: async (r) => { seen.push(r); return new Response('ok'); }, now: () => NOW });
    expect((await g.handle(post(ACME_ACS, fx.acmeAssertionSigned))).status).toBe(200);
    expect(seen[0].headers.get('cappz-saml-tenant')).toBe('acme');
    expect(seen[0].headers.get('cappz-saml-signature')).toBe('verified');
    // Same path on another host, when tenants are told apart by host: no tenant, refused.
    const hostTenants = tenants.map((t, i) => ({ ...t, acsUrls: [`https://${t.id}.saas.example.com/saml/acs`] }));
    const h = createSamlGuard({ tenants: hostTenants, mode: 'enforce', upstream: laxSp, now: () => NOW });
    const r = await h.handle(post('https://evil.saas.example.com/saml/acs', fx.acmeAssertionSigned));
    expect(r.status).toBe(403);
    expect((await r.json()).reason).toBe('unknown-tenant');
    expect(() => createSamlGuard({ tenants: [tenants[0], { ...tenants[1], acsUrls: [ACME_ACS] }], mode: 'shadow', upstream: laxSp })).toThrow(/two tenants/);
  });

  it('pins are per tenant: acme\'s certificate pinned for globex does not verify at acme', async () => {
    const { tenants, operator } = await setup();
    const wrong = await declareIdpPin({ idpEntityId: 'https://idp.acme.example/saml', certificate: fx.certs.acme, expiresAt: '2027-01-01T00:00:00Z', tenantId: 'globex' }, operator);
    const t2 = tenants.map((t) => ({ ...t, pins: [wrong, ...t.pins!.filter((p) => p.tenantId !== 'acme')] }));
    const g = createSamlGuard({ tenants: t2, mode: 'enforce', upstream: laxSp, now: () => NOW });
    const v = await g.checkFor('acme', fx.acmeAssertionSigned);
    expect(v.allowed).toBe(false);
    expect(['unpinned-certificate', 'cross-tenant']).toContain(v.reason);
  });

  it('per-tenant shadow → enforce, by operator-signed records that cite the report; unsigned or foreign records do nothing', async () => {
    const { tenants, operator } = await setup();
    const stranger = await generateSigningKey();
    let records = [await signTenantMode({ tenantId: 'acme', mode: 'enforce', reason: 'gate passed', reportHash: 'ab'.repeat(32), at: '2026-11-09T11:00:00Z' }, operator)];
    records.push(await signTenantMode({ tenantId: 'globex', mode: 'enforce', reason: 'not mine', at: '2026-11-09T11:00:00Z' }, stranger));
    const replay = async () => Object.fromEntries(Object.entries((await replaySamlTenantModes(records, [operator.publicKeyHex])).modes).map(([k, r]) => [k, r.mode]));
    const g = createSamlGuard({ tenants, mode: 'shadow', tenantModes: replay, upstream: laxSp, now: () => NOW });
    expect((await g.handle(post(ACME_ACS, fx.globexIntoAcme))).status).toBe(403);   // acme enforces
    expect((await g.handle(post(GLOBEX_ACS, fx.acmeAssertionSigned))).status).toBe(302); // globex still shadows (the stranger's record is ignored)
    const rep = await g.report() as SamlMultiReport;
    expect(rep.tenants.globex.spAcceptedGuardRefused).toEqual({ 'cross-tenant': 1 });
    expect(rep.tenants.acme.mode).toBe('enforce');
    records = [...records, await signTenantMode({ tenantId: 'acme', mode: 'shadow', reason: 'rollback: IdP certificate rotation', at: '2026-11-09T11:30:00Z' }, operator)];
    expect((await g.handle(post(ACME_ACS, fx.globexIntoAcme))).status).toBe(302);
    await expect(signTenantMode({ tenantId: 'acme', mode: 'enforce', reason: ' ' }, operator)).rejects.toThrow(/report hash/);
  });
});

describe('15.37.0 onboarding: IdP metadata and the configuration doctor', () => {
  it('reads entity ID, signing certificates (not encryption ones) and SSO URLs from IdP metadata', async () => {
    const md = await idpFromMetadata(fx.metadataAcme);
    expect(md.entityId).toBe('https://idp.acme.example/saml');
    expect(md.signingCertificates).toHaveLength(1);
    expect(md.signingCertificates[0].notAfter).toBe('2035-12-30T00:00:00.000Z');
    expect(md.ssoUrls[0]).toEqual({ binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect', location: 'https://idp.acme.example/sso' });
    await expect(idpFromMetadata('<md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"/>')).rejects.toThrow(/0 identity providers/);
  });

  it('a clean multi-tenant setup has no errors; shared login URLs, wrong-tenant pins, http and left-to-sp in enforce are errors', async () => {
    const { tenants, operator } = await setup({ allowUnsolicited: false, requireSignedAssertion: true, encryptedAssertions: 'refuse' });
    const clean = await lintSamlTenants(tenants, { now: NOW });
    expect(clean.errors).toBe(0);
    expect(clean.findings.filter((f) => f.tenant === 'acme').map((f) => f.code)).not.toContain('signature-left-to-sp');
    const wrongTenant = await declareIdpPin({ idpEntityId: tenants[1].idpEntityId, certificate: fx.certs.globex, expiresAt: '2027-11-09T00:00:00Z', tenantId: 'acme' }, operator);
    const bad: SamlTenant[] = [
      { ...tenants[0], acsUrls: ['http://saas.example.com/saml/acs/acme'], signature: 'left-to-sp', mode: 'enforce' },
      { ...tenants[1], acsUrls: ['http://saas.example.com/saml/acs/acme'], spEntityId: tenants[0].spEntityId, pins: [wrongTenant] },
    ];
    const r = await lintSamlTenants(bad, { now: NOW });
    const codes = r.findings.filter((f) => f.severity === 'error').map((f) => `${f.tenant}:${f.code}`);
    expect(r.ok).toBe(false);
    expect(codes).toEqual(expect.arrayContaining(['acme:acs-not-https', 'globex:acs-shared', 'globex:sp-entity-shared', 'acme:signature-left-to-sp', 'globex:pin-refused', 'globex:no-pin']));
    const expiring = await lintSamlTenants([tenants[0]], { now: Date.parse('2027-10-20T00:00:00Z'), multiTenant: true });
    expect(expiring.findings.map((f) => f.code)).toContain('pin-expiring');
  });
});
