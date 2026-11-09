/**
 * COPE node crystallized.
 * Node ID: v15-37-00-saml-xmldsig
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * The cryptographic half of SAML Guard: verify an enveloped XML signature on
 * the very tree the guard checked (no second parser, so no parser
 * differential inside the guard), with the key of a pinned certificate —
 * never a key the response brings along unpinned.
 *
 * Deliberately narrow: Exclusive XML Canonicalization 1.0 (with an optional
 * InclusiveNamespaces PrefixList) — what Okta, Microsoft Entra, ADFS, Google,
 * PingFederate, Keycloak and Shibboleth emit by default — over documents the
 * strict reader already accepted (no comments, PIs, CDATA or DTD, so none of
 * C14N's hard cases arise); enveloped-signature transform; RSA PKCS#1 v1.5
 * and ECDSA (P-256/P-384, raw r||s per RFC 6931) with SHA-256/384/512.
 * Anything else is 'unsupported', which the guard treats as a refusal: an
 * algorithm the verifier cannot check is not a pass.
 *
 * Tested against an independent implementation (signxml on lxml) in
 * src/test/fixtures/saml-signed.json.
 */

import { buf } from './canonical.ts';
import { inspectCertificate, OIDS } from './x509Chain.ts';
import type { XmlEl } from './samlGuard.ts';

const DSIG = 'http://www.w3.org/2000/09/xmldsig#';

const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

const SIG_HASH: Record<string, { kind: 'rsa' | 'ecdsa'; hash: string }> = {
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256': { kind: 'rsa', hash: 'SHA-256' },
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha384': { kind: 'rsa', hash: 'SHA-384' },
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512': { kind: 'rsa', hash: 'SHA-512' },
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256': { kind: 'ecdsa', hash: 'SHA-256' },
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha384': { kind: 'ecdsa', hash: 'SHA-384' },
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha512': { kind: 'ecdsa', hash: 'SHA-512' },
};
const DIGEST: Record<string, string> = {
  'http://www.w3.org/2001/04/xmlenc#sha256': 'SHA-256',
  'http://www.w3.org/2001/04/xmldsig-more#sha384': 'SHA-384',
  'http://www.w3.org/2001/04/xmlenc#sha512': 'SHA-512',
};
const CURVES: Record<string, { name: string; size: number }> = { [OIDS.p256]: { name: 'P-256', size: 32 }, [OIDS.p384]: { name: 'P-384', size: 48 } };

const escText = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
const escAttr = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');
const prefixOf = (qname: string) => (qname.includes(':') ? qname.slice(0, qname.indexOf(':')) : '');

/**
 * Exclusive XML Canonicalization 1.0 of `apex` (and its descendants), leaving out `omit` (the enveloped
 * signature). `inclusive` is the InclusiveNamespaces PrefixList ('#default' for the default namespace).
 */
export function exclusiveC14n(apex: XmlEl, o: { omit?: XmlEl; inclusive?: readonly string[] } = {}): string {
  const inclusive = new Set((o.inclusive ?? []).map((p) => (p === '#default' ? '' : p)));
  const out: string[] = [];
  const render = (el: XmlEl, rendered: Map<string, string>) => {
    const used = new Set<string>([prefixOf(el.qname)]);
    for (const k of Object.keys(el.attrs)) { const p = prefixOf(k); if (p && p !== 'xml') used.add(p); }
    for (const p of inclusive) if (el.scope.has(p)) used.add(p);
    const decls: Array<[string, string]> = [];
    const next = new Map(rendered);
    for (const p of used) {
      const uri = p === 'xml' ? XML_NS : el.scope.get(p) ?? '';
      if (p === 'xml') continue;
      if (p === '') {
        // The default namespace: emitted when it differs from what an output ancestor rendered (xmlns="" undoes one).
        if ((rendered.get('') ?? '') === uri) continue;
      } else if (rendered.get(p) === uri) continue;
      decls.push([p, uri]); next.set(p, uri);
    }
    decls.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const attrs = Object.entries(el.attrs).map(([k, v]) => {
      const p = prefixOf(k);
      return { k, v, ns: p ? (p === 'xml' ? XML_NS : el.scope.get(p) ?? '') : '', local: p ? k.slice(p.length + 1) : k };
    }).sort((a, b) => (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : a.local < b.local ? -1 : a.local > b.local ? 1 : 0));
    out.push(`<${el.qname}`);
    for (const [p, uri] of decls) out.push(p ? ` xmlns:${p}="${escAttr(uri)}"` : ` xmlns="${escAttr(uri)}"`);
    for (const a of attrs) out.push(` ${a.k}="${escAttr(a.v)}"`);
    out.push('>');
    for (const n of el.nodes) {
      if (typeof n === 'string') out.push(escText(n));
      else if (n !== o.omit) render(n, next);
    }
    out.push(`</${el.qname}>`);
  };
  render(apex, new Map());
  return out.join('');
}

export type DsigResult = { ok: true; certificateSha256: string } | { ok: false; reason: 'bad-digest' | 'bad-signature' | 'unsupported' | 'no-key'; detail: string };

const b64 = (s: string) => Uint8Array.from(atob(s.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
const child = (el: XmlEl, local: string) => el.children.find((c) => c.ns === DSIG && c.local === local);
const inclusiveOf = (el: XmlEl | undefined) => el?.children.find((c) => c.local === 'InclusiveNamespaces' && c.ns === EXC_C14N)?.attrs.PrefixList?.split(/\s+/).filter(Boolean);

/**
 * Verify the enveloped signature `sig` (a ds:Signature inside the element it signs) with one of the
 * pinned certificates (base64 DER). The guard has already checked placement, the single Reference and the
 * algorithm allowlist; this checks the digest of the canonical owner and the signature over SignedInfo.
 */
export async function verifyEnvelopedSignature(sig: XmlEl, pinnedCertificates: readonly string[]): Promise<DsigResult> {
  const owner = sig.parent; const si = child(sig, 'SignedInfo');
  if (!owner || !si) return { ok: false, reason: 'unsupported', detail: 'no SignedInfo' };
  const c14n = child(si, 'CanonicalizationMethod'); const sm = child(si, 'SignatureMethod'); const ref = child(si, 'Reference');
  if (c14n?.attrs.Algorithm !== EXC_C14N) return { ok: false, reason: 'unsupported', detail: `canonicalization ${c14n?.attrs.Algorithm} (built-in verifier: exclusive C14N only)` };
  const alg = SIG_HASH[sm?.attrs.Algorithm ?? ''];
  if (!alg || !ref) return { ok: false, reason: 'unsupported', detail: `signature method ${sm?.attrs.Algorithm}` };
  const transforms = child(ref, 'Transforms')?.children ?? [];
  let refInclusive: string[] | undefined; let enveloped = false;
  for (const t of transforms) {
    if (t.attrs.Algorithm === ENVELOPED) enveloped = true;
    else if (t.attrs.Algorithm === EXC_C14N) refInclusive = inclusiveOf(t);
    else return { ok: false, reason: 'unsupported', detail: `transform ${t.attrs.Algorithm}` };
  }
  if (!enveloped) return { ok: false, reason: 'unsupported', detail: 'not an enveloped signature' };
  const dm = DIGEST[child(ref, 'DigestMethod')?.attrs.Algorithm ?? ''];
  const dv = child(ref, 'DigestValue')?.text.trim(); const sv = child(sig, 'SignatureValue')?.text.trim();
  if (!dm || !dv || !sv) return { ok: false, reason: 'unsupported', detail: 'digest method, digest value or signature value missing' };

  const digest = new Uint8Array(await crypto.subtle.digest(dm, buf(new TextEncoder().encode(exclusiveC14n(owner, { omit: sig, inclusive: refInclusive })))));
  let want: Uint8Array; try { want = b64(dv); } catch { return { ok: false, reason: 'bad-digest', detail: 'digest value not base64' }; }
  if (want.length !== digest.length || !want.every((x, i) => x === digest[i])) return { ok: false, reason: 'bad-digest', detail: 'the signed element was changed after signing' };

  const signedInfo = new TextEncoder().encode(exclusiveC14n(si, { inclusive: inclusiveOf(c14n) }));
  let signature: Uint8Array; try { signature = b64(sv); } catch { return { ok: false, reason: 'bad-signature', detail: 'signature value not base64' }; }
  if (!pinnedCertificates.length) return { ok: false, reason: 'no-key', detail: 'no pinned certificate to verify with' };
  for (const c of pinnedCertificates) {
    let cert; try { cert = await inspectCertificate(b64(c)); } catch { continue; }
    try {
      if (alg.kind === 'rsa' && cert.keyAlgorithmOid === OIDS.rsaEncryption) {
        const key = await crypto.subtle.importKey('spki', buf(cert.spki), { name: 'RSASSA-PKCS1-v1_5', hash: alg.hash }, false, ['verify']);
        if (await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, buf(signature), buf(signedInfo))) return { ok: true, certificateSha256: cert.sha256 };
      } else if (alg.kind === 'ecdsa' && cert.keyAlgorithmOid === OIDS.ecPublicKey) {
        const curve = CURVES[cert.keyParameterOid ?? ''];
        if (!curve || signature.length !== 2 * curve.size) continue;
        const key = await crypto.subtle.importKey('spki', buf(cert.spki), { name: 'ECDSA', namedCurve: curve.name }, false, ['verify']);
        if (await crypto.subtle.verify({ name: 'ECDSA', hash: alg.hash }, key, buf(signature), buf(signedInfo))) return { ok: true, certificateSha256: cert.sha256 };
      }
    } catch { /* malformed key: try the next pin */ }
  }
  return { ok: false, reason: 'bad-signature', detail: 'no pinned certificate verifies this signature' };
}
