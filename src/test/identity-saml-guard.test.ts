import { describe, it, expect } from 'vitest';
import { deflateSync } from 'fflate';
import { createSamlChecker, createSamlGuard, declareIdpPin, acceptedPins, parseStrictXml, authnRequestIdFromUrl, decodeSamlResponse, SamlRefusal, type SamlGuardConfig } from '../lib/identity/samlGuard';
import { generateSigningKey } from '../lib/sync/helloSignature';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const iso = (dMs: number) => new Date(NOW + dMs).toISOString();
const ACS = 'https://app.example.com/saml/acs';
const CERT = btoa('pretend-der-certificate-bytes');
const OTHER_CERT = btoa('attacker-certificate');

const sig = (ref: string, o: { alg?: string; digest?: string; cert?: string; refs?: string[]; transform?: string } = {}) =>
  `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo><ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/><ds:SignatureMethod Algorithm="${o.alg ?? 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'}"/>` +
  (o.refs ?? [ref]).map((r) => `<ds:Reference URI="#${r}"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/><ds:Transform Algorithm="${o.transform ?? 'http://www.w3.org/2001/10/xml-exc-c14n#'}"/></ds:Transforms><ds:DigestMethod Algorithm="${o.digest ?? 'http://www.w3.org/2001/04/xmlenc#sha256'}"/><ds:DigestValue>AAAA</ds:DigestValue></ds:Reference>`).join('') +
  `</ds:SignedInfo><ds:SignatureValue>AAAA</ds:SignatureValue>${o.cert === undefined ? '' : `<ds:KeyInfo><ds:X509Data><ds:X509Certificate>${o.cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>`}</ds:Signature>`;

interface Opts { aid?: string; nameId?: string; audience?: string; recipient?: string; destination?: string; issuer?: string; irt?: string; nb?: number; na?: number; issued?: number; assertionSig?: string | null; extra?: string; inner?: string; status?: string }
function response(o: Opts = {}): string {
  const aid = o.aid ?? '_a1';
  const irt = o.irt ? ` InResponseTo="${o.irt}"` : '';
  const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${aid}" Version="2.0" IssueInstant="${iso(o.issued ?? -5_000)}"><saml:Issuer>${o.issuer ?? 'https://idp.example.com'}</saml:Issuer>` +
    `${o.assertionSig === null ? '' : o.assertionSig ?? sig(aid, { cert: CERT })}` +
    `<saml:Subject><saml:NameID>${o.nameId ?? 'alice@example.com'}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData Recipient="${o.recipient ?? ACS}" NotOnOrAfter="${iso(o.na ?? 300_000)}"${irt}/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(o.nb ?? -10_000)}" NotOnOrAfter="${iso(o.na ?? 300_000)}"><saml:AudienceRestriction><saml:Audience>${o.audience ?? 'https://app.example.com'}</saml:Audience></saml:AudienceRestriction></saml:Conditions>${o.inner ?? ''}</saml:Assertion>`;
  return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r1" Version="2.0" IssueInstant="${iso(-5_000)}" Destination="${o.destination ?? ACS}"${irt}>` +
    `<saml:Issuer>${o.issuer ?? 'https://idp.example.com'}</saml:Issuer><samlp:Status><samlp:StatusCode Value="${o.status ?? 'urn:oasis:names:tc:SAML:2.0:status:Success'}"/></samlp:Status>${o.extra ?? ''}${assertion}</samlp:Response>`;
}

async function setup(extra: Partial<SamlGuardConfig> = {}) {
  const operator = await generateSigningKey();
  const pin = await declareIdpPin({ idpEntityId: 'https://idp.example.com', certificate: CERT, expiresAt: iso(86400_000) }, operator);
  const cfg: SamlGuardConfig = { idpEntityId: 'https://idp.example.com', spEntityId: 'https://app.example.com', acsUrls: [ACS], pins: [pin], trustedPinSigners: [operator.publicKeyHex], ...extra };
  return { cfg, checker: createSamlChecker(cfg), operator };
}

describe('15.36.0 SAML Guard — strict XML', () => {
  it('refuses DOCTYPE, comments, CDATA, PIs, unknown entities, duplicate attributes and namespace rebinding', () => {
    const r = (x: string) => { try { parseStrictXml(x); return 'ok'; } catch (e) { return (e as SamlRefusal).reason; } };
    expect(r('<!DOCTYPE x [<!ENTITY a "b">]><x/>')).toBe('doctype');
    expect(r('<x><!-- c --></x>')).toBe('comment');
    expect(r('<x><![CDATA[a]]></x>')).toBe('cdata');
    expect(r('<x><?php ?></x>')).toBe('processing-instruction');
    expect(r('<x>&xxe;</x>')).toBe('entity');
    expect(r('<x a="1" a="2"/>')).toBe('duplicate-attribute');
    expect(r('<a:x xmlns:a="u1"><a:y xmlns:a="u2"/></a:x>')).toBe('namespace');
    expect(r('<a:x/>')).toBe('namespace');
    expect(r('<x><y></x>')).toBe('malformed-xml');
    expect(r('<?xml version="1.0"?><x a="&amp;&#65;">t</x>')).toBe('ok');
  });
});

describe('15.36.0 SAML Guard — the response', () => {
  it('passes a well-formed, pinned, fresh response for this SP and refuses its replay', async () => {
    const { checker } = await setup();
    const v = await checker.check(response(), NOW);
    expect(v).toMatchObject({ allowed: true, assertion: 'plain', certificate: 'pinned', signature: 'left-to-sp', solicited: 'unsolicited', assertionId: '_a1' });
    expect(v.subjectHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await checker.check(response(), NOW + 1000)).reason).toBe('replayed');
  });

  it('refuses signature wrapping: a second assertion, an assertion in Extensions, a Reference to another ID', async () => {
    const { checker } = await setup();
    const evil = `<saml:Assertion ID="_evil" Version="2.0" IssueInstant="${iso(0)}"><saml:Issuer>https://idp.example.com</saml:Issuer></saml:Assertion>`;
    expect((await checker.check(response({ extra: evil }), NOW)).reason).toBe('assertion-count');
    expect((await checker.check(response({ extra: `<samlp:Extensions>${evil}</samlp:Extensions>`, aid: '_a2' }), NOW)).reason).toBe('assertion-count');
    expect((await checker.check(response({ aid: '_a3', assertionSig: sig('_other', { cert: CERT }) }), NOW)).reason).toBe('reference-mismatch');
    expect((await checker.check(response({ aid: '_a4', assertionSig: sig('_a4', { cert: CERT, refs: ['_a4', '_r1'] }) }), NOW)).reason).toBe('reference-mismatch');
    expect((await checker.check(response({ aid: '_r1' }), NOW)).reason).toBe('duplicate-id');
  });

  it('refuses a NameID split by comments or markup (the truncation trick)', async () => {
    const { checker } = await setup();
    expect((await checker.check(response({ nameId: 'admin@example.com<!---->.evil.com' }), NOW)).reason).toBe('comment');
    expect((await checker.check(response({ nameId: 'admin@example.com<x/>.evil' }), NOW)).reason).toBe('subject');
  });

  it('checks issuer, destination, recipient, audience, status — the "valid signature, wrong place" class', async () => {
    const { checker } = await setup();
    expect((await checker.check(response({ aid: '_b1', audience: 'https://other-saas.example' }), NOW)).reason).toBe('audience');
    expect((await checker.check(response({ aid: '_b2', recipient: 'https://other-saas.example/acs' }), NOW)).reason).toBe('recipient');
    expect((await checker.check(response({ aid: '_b3', destination: 'https://other-saas.example/acs' }), NOW)).reason).toBe('destination');
    expect((await checker.check(response({ aid: '_b4', issuer: 'https://evil-idp.example' }), NOW)).reason).toBe('issuer');
    expect((await checker.check(response({ aid: '_b5', status: 'urn:oasis:names:tc:SAML:2.0:status:Requester' }), NOW)).reason).toBe('status-not-success');
  });

  it('checks time: expired, not yet valid, too long a lifetime, stale', async () => {
    const { checker } = await setup();
    expect((await checker.check(response({ aid: '_c1', na: -200_000 }), NOW)).reason).toBe('expired');
    expect((await checker.check(response({ aid: '_c2', nb: 600_000, na: 700_000 }), NOW)).reason).toBe('not-yet-valid');
    expect((await checker.check(response({ aid: '_c3', na: 8 * 3600_000 }), NOW)).reason).toBe('lifetime-too-long');
    expect((await checker.check(response({ aid: '_c4', issued: -3600_000 }), NOW)).reason).toBe('stale');
  });

  it('refuses unsigned, SHA-1, HMAC, comment-preserving C14N, unpinned certificates and expired or foreign pins', async () => {
    const { checker, cfg } = await setup();
    expect((await checker.check(response({ aid: '_d1', assertionSig: null }), NOW)).reason).toBe('unsigned');
    expect((await checker.check(response({ aid: '_d2', assertionSig: sig('_d2', { alg: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1' }) }), NOW)).reason).toBe('weak-algorithm');
    expect((await checker.check(response({ aid: '_d3', assertionSig: sig('_d3', { alg: 'http://www.w3.org/2000/09/xmldsig#hmac-sha1' }) }), NOW)).reason).toBe('weak-algorithm');
    expect((await checker.check(response({ aid: '_d4', assertionSig: sig('_d4', { digest: 'http://www.w3.org/2000/09/xmldsig#sha1' }) }), NOW)).reason).toBe('weak-algorithm');
    expect((await checker.check(response({ aid: '_d5', assertionSig: sig('_d5', { transform: 'http://www.w3.org/2001/10/xml-exc-c14n#WithComments' }) }), NOW)).reason).toBe('transform');
    expect((await checker.check(response({ aid: '_d6', assertionSig: sig('_d6', { cert: OTHER_CERT }) }), NOW)).reason).toBe('unpinned-certificate');
    const stranger = await generateSigningKey();
    const foreign = await declareIdpPin({ idpEntityId: cfg.idpEntityId, certificate: OTHER_CERT, expiresAt: iso(86400_000) }, stranger);
    const expired = { ...cfg.pins![0], expiresAt: iso(-1) };
    const { accepted, refused } = await acceptedPins([foreign, expired, cfg.pins![0]], cfg.trustedPinSigners!, NOW);
    expect(accepted).toHaveLength(1);
    expect(refused.map((r) => r.because).sort()).toEqual(['expired', 'signer not trusted']);
    expect((await acceptedPins([{ ...cfg.pins![0], certSha256: '00'.repeat(32) }], cfg.trustedPinSigners!, NOW)).refused[0].because).toBe('bad signature');
  });

  it('matches InResponseTo against requests the SP sent, once; refuses unsolicited when told to', async () => {
    const { checker } = await setup({ allowUnsolicited: false });
    expect((await checker.check(response({ aid: '_e1' }), NOW)).reason).toBe('unsolicited');
    expect((await checker.check(response({ aid: '_e2', irt: '_req1' }), NOW)).reason).toBe('unknown-request');
    checker.expectRequest('_req1', NOW - 1000);
    expect(await checker.check(response({ aid: '_e3', irt: '_req1' }), NOW)).toMatchObject({ allowed: true, solicited: 'matched' });
    expect((await checker.check(response({ aid: '_e4', irt: '_req1' }), NOW)).reason).toBe('unknown-request');
  });

  it('a plugged-in signature verifier decides the cryptographic half', async () => {
    const { checker } = await setup({ verifySignature: async (_x, s) => s.id !== '_f2' });
    expect((await checker.check(response({ aid: '_f1' }), NOW)).signature).toBe('verified');
    expect((await checker.check(response({ aid: '_f2' }), NOW)).reason).toBe('bad-signature');
  });
});

describe('15.36.0 SAML Guard — in front of an ACS', () => {
  const post = (xml: string) => new Request(ACS, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ SAMLResponse: btoa(xml), RelayState: '/' }).toString() });

  it('shadow: the SP decides; a response the SP accepted but the guard refused is a finding, by reason', async () => {
    const { cfg } = await setup();
    let t = NOW;
    const sp = async () => new Response(null, { status: 302, headers: { location: '/', 'set-cookie': 'sid=1' } }); // a lax SP accepts everything
    const g = createSamlGuard({ config: cfg, mode: 'shadow', upstream: sp, now: () => t, gate: { minResponses: 2, minDays: 0, acceptedStricterReasons: ['assertion-count'] } });
    expect((await g.handle(post(response({ aid: '_g1' })))).status).toBe(302);
    expect((await g.handle(post(response({ aid: '_g2', audience: 'https://other-saas.example' })))).status).toBe(302);
    t += 1000;
    const rep = await (await g.handle(new Request('https://app.example.com/cappz/saml/report'))).json();
    expect(rep.counts.agree).toBe(1);
    expect(rep.spAcceptedGuardRefused).toEqual({ audience: 1 });
    expect(rep.enforce.ready).toBe(false);
    expect(rep.enforce.because.join(' ')).toMatch(/audience ×1/);
    expect(rep.reportHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('enforce: refused responses never reach the SP; passes carry verdict headers, client-sent ones are stripped', async () => {
    const { cfg } = await setup();
    const seen: Request[] = [];
    const sp = async (r: Request) => { seen.push(r); return new Response('ok'); };
    const g = createSamlGuard({ config: cfg, mode: 'enforce', upstream: sp, now: () => NOW });
    const bad = await g.handle(post(response({ aid: '_h1', recipient: 'https://x/acs' })));
    expect(bad.status).toBe(403);
    expect(seen).toHaveLength(0);
    const forged = post(response({ aid: '_h2' })); forged.headers.set('cappz-saml-verdict', 'pass');
    expect((await g.handle(forged)).status).toBe(200);
    expect(seen[0].headers.get('cappz-saml-verdict')).toBe('pass');
    expect(seen[0].headers.get('cappz-saml-subject-hash')).toMatch(/^[0-9a-f]{64}$/);
    const two = new Request(ACS, { method: 'POST', body: `SAMLResponse=${encodeURIComponent(btoa(response({ aid: '_h3' })))}&SAMLResponse=x` });
    expect((await g.handle(two)).status).toBe(403);
    // a request without a header spoof still has it stripped on non-ACS paths
    const other = new Request('https://app.example.com/home', { headers: { 'cappz-saml-verdict': 'pass' } });
    await g.handle(other);
    expect(seen[seen.length - 1].headers.get('cappz-saml-verdict')).toBeNull();
  });

  it('learns AuthnRequest IDs from the SP redirect (HTTP-Redirect binding)', async () => {
    const req = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_req9" Version="2.0" IssueInstant="${iso(0)}"/>`;
    const q = btoa(String.fromCharCode(...deflateSync(new TextEncoder().encode(req))));
    const loc = `https://idp.example.com/sso?SAMLRequest=${encodeURIComponent(q)}`;
    expect(authnRequestIdFromUrl(loc)).toBe('_req9');
    const { cfg } = await setup({ allowUnsolicited: false });
    const sp = async (r: Request) => (new URL(r.url).pathname === '/login' ? new Response(null, { status: 302, headers: { location: loc } }) : new Response('ok'));
    const g = createSamlGuard({ config: cfg, mode: 'enforce', upstream: sp, now: () => NOW });
    await g.handle(new Request('https://app.example.com/login'));
    expect((await g.handle(post(response({ aid: '_i1', irt: '_req9' })))).status).toBe(200);
  });

  it('decodes only strict base64', () => {
    expect(decodeSamlResponse('not base64!')).toBeNull();
    expect(decodeSamlResponse(btoa('<x/>'))).toBe('<x/>');
  });
});
