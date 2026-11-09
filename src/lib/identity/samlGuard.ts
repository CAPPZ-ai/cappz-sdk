/**
 * COPE node crystallized.
 * Node ID: v15-36-00-saml-guard
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * SAML Guard: a second, independent check in front of a SAML service provider
 * (the assertion consumer service, ACS) that you host or can put a proxy in
 * front of. Most SAML authentication bypasses of 2024–26 were not broken
 * cryptography but ambiguity: two parsers reading the same XML differently
 * (signature wrapping, namespace confusion, comments splitting a NameID), or
 * an SP that verified the signature and then never checked that the assertion
 * was for it (audience, recipient, destination, issuer, time, replay). The
 * guard refuses ambiguity instead of interpreting it:
 *
 *   - exactly one Assertion (or EncryptedAssertion), a direct child of the
 *     Response; no DOCTYPE, entities, comments, CDATA or processing
 *     instructions; no duplicate IDs or attributes; no prefix redeclared to
 *     another namespace; bounded size and depth;
 *   - every ds:Signature sits directly in the element it signs and has
 *     exactly one Reference whose URI is that element's own ID; only
 *     enveloped-signature + exclusive/inclusive C14N without comments;
 *     RSA/ECDSA with SHA-256 or stronger (no SHA-1, no HMAC);
 *   - an embedded signing certificate must match a pin the operator's wallet
 *     signed (declareIdpPin): the certificate is a projection, the wallet's
 *     declaration is the trust;
 *   - Issuer, Destination, Recipient and Audience equal the configuration;
 *     NotBefore / NotOnOrAfter / IssueInstant within skew and a short
 *     maximum lifetime; InResponseTo matches a request this SP sent (seen on
 *     its redirect, one use) unless unsolicited responses are allowed;
 *     an assertion ID is accepted once.
 *
 * v15-37-00: the signature is verified too, by default (`signature:
 * 'builtin'`, samlXmlDsig.ts): exclusive C14N and RSA/ECDSA on the same tree
 * the guard checked, with the key of a pinned certificate only — so even an
 * SP whose own signature check is broken is covered. The SP keeps its check
 * (both must pass). 'left-to-sp' or a plugged-in `verifySignature` remain,
 * and the verdict says which checked it.
 *
 * Multi-tenant SaaS (v15-37-00): one guard serves many customers, each with
 * its own IdP, ACS URL, SP entity, pins (signed for that tenant only), replay
 * cache, outstanding requests, shadow report and mode. The tenant is chosen by
 * the login URL the response is posted to — never by what the response says —
 * and a response that names another tenant's IdP, SP, ACS or certificate is
 * refused as 'cross-tenant': customer A's validly signed assertion cannot log
 * into customer B.
 *
 * Adopt it the way a legacy verifier is retired: shadow first (the SP stays
 * authoritative; every response the SP accepted but the guard refused is a
 * finding, reported per reason), then enforce when the report's gate passes.
 * In shadow mode a refusal the SP accepted is exactly the incident class —
 * the SP took a login it should not have.
 */

import { inflateSync } from 'fflate';
import { buf, canonicalJson, sha256, sha256HexOf, toHex, utf8 } from './canonical.ts';
import { signCanonical, verifyCanonical, type SigningKey } from '../sync/helloSignature.ts';
import { createShadowComparison, type CostAssumptions, type LegacyVerdict, type ShadowState } from './shadowCompare.ts';
import { readBounded } from './edgeVerify.ts';
import { verifyEnvelopedSignature } from './samlXmlDsig.ts';

export const SAML_NS = {
  protocol: 'urn:oasis:names:tc:SAML:2.0:protocol',
  assertion: 'urn:oasis:names:tc:SAML:2.0:assertion',
  dsig: 'http://www.w3.org/2000/09/xmldsig#',
} as const;

const SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success';
const BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';

/** Signature algorithms accepted (SHA-256 or stronger, asymmetric only). */
export const SAML_SIGNATURE_ALGORITHMS = [
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha384', 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512',
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256', 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha384', 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha512',
  'http://www.w3.org/2007/05/xmldsig-more#sha256-rsa-MGF1',
] as const;
export const SAML_DIGEST_ALGORITHMS = ['http://www.w3.org/2001/04/xmlenc#sha256', 'http://www.w3.org/2001/04/xmldsig-more#sha384', 'http://www.w3.org/2001/04/xmlenc#sha512'] as const;
const C14N = ['http://www.w3.org/2001/10/xml-exc-c14n#', 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315', 'http://www.w3.org/2006/12/xml-c14n11'];
const TRANSFORMS = ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', ...C14N];

// ─── Strict XML reader ────────────────────────────────────────────

export interface XmlEl {
  ns: string; local: string; qname: string; attrs: Record<string, string>; children: XmlEl[]; text: string; parent?: XmlEl;
  /** Children and text in document order (for canonicalization). */
  nodes: Array<XmlEl | string>;
  /** Namespace bindings in scope at this element ('' = default). */
  scope: Map<string, string>;
}

export class SamlRefusal extends Error { constructor(public reason: SamlReason, detail?: string) { super(detail ? `${reason}: ${detail}` : reason); } }

export interface XmlLimits { maxBytes: number; maxDepth: number; maxElements: number }
export const DEFAULT_XML_LIMITS: XmlLimits = { maxBytes: 256 * 1024, maxDepth: 48, maxElements: 4000 };

const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

function decodeText(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);?/g, (m, e: string) => {
    if (!m.endsWith(';')) throw new SamlRefusal('malformed-xml', 'bare &');
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff) throw new SamlRefusal('malformed-xml', 'character reference');
      return String.fromCodePoint(cp);
    }
    const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
    if (!(e in named)) throw new SamlRefusal('entity', e);
    return named[e];
  });
}

/**
 * Parse XML refusing every construct SAML does not need and attackers use: DOCTYPE/entities, comments,
 * CDATA, processing instructions (other than the declaration), duplicate attributes, undeclared prefixes,
 * and a prefix redeclared to a different namespace anywhere in the document.
 */
export function parseStrictXml(xml: string, limits: XmlLimits = DEFAULT_XML_LIMITS, o: { skipComments?: boolean } = {}): XmlEl {
  if (utf8(xml).length > limits.maxBytes) throw new SamlRefusal('too-large');
  let i = 0;
  // XML 1.0 §2.11: line ends are normalized to \n before anything else (C14N sees \n only).
  const s = xml.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (s.startsWith('<?xml')) { const e = s.indexOf('?>'); if (e < 0) throw new SamlRefusal('malformed-xml'); i = e + 2; }
  const prefixUri = new Map<string, string>(); // every binding ever seen: one prefix, one namespace
  const stack: Array<{ el: XmlEl; scope: Map<string, string> }> = [];
  let root: XmlEl | undefined; let count = 0;
  const resolve = (scope: Map<string, string>, prefix: string) => {
    if (prefix === 'xml') return XML_NS;
    const u = scope.get(prefix);
    if (u === undefined) { if (prefix === '') return ''; throw new SamlRefusal('namespace', `undeclared prefix ${prefix}`); }
    return u;
  };
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    const text = lt < 0 ? s.slice(i) : s.slice(i, lt);
    if (text.length) {
      if (!stack.length) { if (text.trim()) throw new SamlRefusal('malformed-xml', 'text outside the root'); }
      else { const t = decodeText(text); const top = stack[stack.length - 1].el; top.text += t; top.nodes.push(t); }
    }
    if (lt < 0) break;
    const head = s.slice(lt, lt + 9);
    if (head.startsWith('<!--')) {
      if (!o.skipComments) throw new SamlRefusal('comment');
      const e = s.indexOf('-->', lt + 4); if (e < 0) throw new SamlRefusal('malformed-xml', 'unterminated comment');
      i = e + 3; continue;
    }
    if (head.startsWith('<![CDATA[')) throw new SamlRefusal('cdata');
    if (head.startsWith('<!')) throw new SamlRefusal('doctype');
    if (head.startsWith('<?')) throw new SamlRefusal('processing-instruction');
    const gt = findTagEnd(s, lt);
    if (gt < 0) throw new SamlRefusal('malformed-xml', 'unterminated tag');
    const raw = s.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      const top = stack.pop();
      if (!top || top.el.qname !== name) throw new SamlRefusal('malformed-xml', `mismatched </${name}>`);
      continue;
    }
    if (root && !stack.length) throw new SamlRefusal('malformed-xml', 'second root element');
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const m = /^([^\s/>]+)/.exec(body);
    if (!m || !NAME.test(m[1])) throw new SamlRefusal('malformed-xml', 'element name');
    const qname = m[1];
    const rawAttrs: Record<string, string> = {};
    const attrRe = /\s+([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/y;
    let at = qname.length;
    while (at < body.length) {
      if (/^\s*$/.test(body.slice(at))) break;
      attrRe.lastIndex = at;
      const a = attrRe.exec(body);
      if (!a || !NAME.test(a[1])) throw new SamlRefusal('malformed-xml', 'attribute');
      if (a[1] in rawAttrs) throw new SamlRefusal('duplicate-attribute', a[1]);
      const v = a[3] ?? a[4];
      if (v.includes('<')) throw new SamlRefusal('malformed-xml', '< in attribute');
      rawAttrs[a[1]] = decodeText(v.replace(/[\t\n]/g, ' ')); // §3.3.3: literal whitespace → space; character references kept
      at = attrRe.lastIndex;
    }
    const scope = new Map(stack.length ? stack[stack.length - 1].scope : []);
    for (const [k, v] of Object.entries(rawAttrs)) {
      if (k !== 'xmlns' && !k.startsWith('xmlns:')) continue;
      const prefix = k === 'xmlns' ? '' : k.slice(6);
      const seen = prefixUri.get(prefix);
      if (seen !== undefined && seen !== v) throw new SamlRefusal('namespace', `prefix "${prefix}" bound to two namespaces`);
      prefixUri.set(prefix, v);
      scope.set(prefix, v);
    }
    const [prefix, local] = qname.includes(':') ? qname.split(':') as [string, string] : ['', qname];
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawAttrs)) {
      if (k === 'xmlns' || k.startsWith('xmlns:')) continue;
      if (k.includes(':')) resolve(scope, k.split(':')[0]); // declared, or refused
      attrs[k] = v;
    }
    const el: XmlEl = { ns: resolve(scope, prefix), local, qname, attrs, children: [], text: '', nodes: [], scope };
    if (++count > limits.maxElements) throw new SamlRefusal('too-large', 'elements');
    if (stack.length) { el.parent = stack[stack.length - 1].el; el.parent.children.push(el); el.parent.nodes.push(el); } else root = el;
    if (!selfClosing) { stack.push({ el, scope }); if (stack.length > limits.maxDepth) throw new SamlRefusal('too-large', 'depth'); }
  }
  if (stack.length || !root) throw new SamlRefusal('malformed-xml', 'unclosed element');
  return root;
}

function findTagEnd(s: string, from: number): number {
  let q: string | null = null;
  for (let j = from + 1; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') return j; else if (c === '<') return -1;
  }
  return -1;
}

const walk = (el: XmlEl, f: (e: XmlEl) => void) => { f(el); for (const c of el.children) walk(c, f); };
const kids = (el: XmlEl, ns: string, local: string) => el.children.filter((c) => c.ns === ns && c.local === local);
function one(el: XmlEl, ns: string, local: string, reason: SamlReason, optional = false): XmlEl | undefined {
  const k = kids(el, ns, local);
  if (k.length > 1 || (!optional && k.length === 0)) throw new SamlRefusal(reason, `${k.length} × ${local} in ${el.local}`);
  return k[0];
}
/** Text content only when an element has no element children (a NameID or Issuer split by markup is refused). */
function leafText(el: XmlEl, reason: SamlReason): string {
  if (el.children.length) throw new SamlRefusal(reason, `${el.local} has element content`);
  return el.text.trim();
}

// ─── Operator-signed IdP certificate pins ─────────────────────────

/**
 * The operator's wallet says: this IdP signs with this certificate, until expiresAt — and (v2) for this
 * tenant only, carrying the certificate itself so the guard can verify signatures with it. A pin for one
 * tenant never verifies a response at another tenant's login.
 */
export interface IdpPin { v: 1 | 2; idpEntityId: string; certSha256: string; expiresAt: string; signerKey: string; signature: string; tenantId?: string; certificate?: string }

const pinText = (p: Omit<IdpPin, 'signature'>) => canonicalJson(p.v === 1
  ? { v: 1, kind: 'cappz.saml.idp-pin', idpEntityId: p.idpEntityId, certSha256: p.certSha256.toLowerCase(), expiresAt: p.expiresAt, signerKey: p.signerKey }
  : { v: 2, kind: 'cappz.saml.idp-pin', idpEntityId: p.idpEntityId, certSha256: p.certSha256.toLowerCase(), expiresAt: p.expiresAt, signerKey: p.signerKey, tenantId: p.tenantId ?? null, certificate: p.certificate ?? null });

const bareCert = (pemOrBase64: string) => pemOrBase64.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');

export async function declareIdpPin(p: { idpEntityId: string; certificate: string; expiresAt: string; tenantId?: string }, key: SigningKey): Promise<IdpPin> {
  const certificate = bareCert(p.certificate);
  const unsigned = { v: 2 as const, idpEntityId: p.idpEntityId, certSha256: await certificateSha256(certificate), expiresAt: p.expiresAt, signerKey: key.publicKeyHex, ...(p.tenantId ? { tenantId: p.tenantId } : {}), certificate };
  return { ...unsigned, signature: await signCanonical(pinText(unsigned), key) };
}

/** sha256 of a certificate's DER, from PEM or bare base64 (as in ds:X509Certificate). */
export async function certificateSha256(pemOrBase64: string): Promise<string> {
  return toHex(await sha256(Uint8Array.from(atob(bareCert(pemOrBase64)), (c) => c.charCodeAt(0))));
}

/**
 * Pins that verify against a trusted operator key, have not expired and belong to `tenantId` (multi-tenant:
 * a pin must name the tenant; single-tenant: any pin for the IdP).
 */
export async function acceptedPins(pins: readonly IdpPin[], trustedSignerKeys: readonly string[], now = Date.now(), tenantId?: string): Promise<{ accepted: IdpPin[]; refused: Array<{ pin: IdpPin; because: string }> }> {
  const accepted: IdpPin[] = []; const refused: Array<{ pin: IdpPin; because: string }> = [];
  for (const pin of pins) {
    if (tenantId !== undefined && pin.tenantId !== tenantId) { refused.push({ pin, because: pin.tenantId ? `pin is for tenant ${pin.tenantId}` : 'pin names no tenant' }); continue; }
    if (!trustedSignerKeys.includes(pin.signerKey)) { refused.push({ pin, because: 'signer not trusted' }); continue; }
    if (!(Date.parse(pin.expiresAt) > now)) { refused.push({ pin, because: 'expired' }); continue; }
    const { signature, ...unsigned } = pin;
    if (!(await verifyCanonical(pinText(unsigned), signature, pin.signerKey).catch(() => false))) { refused.push({ pin, because: 'bad signature' }); continue; }
    if (pin.certificate && (await certificateSha256(pin.certificate).catch(() => '')) !== pin.certSha256.toLowerCase()) { refused.push({ pin, because: 'certificate does not match its hash' }); continue; }
    accepted.push(pin);
  }
  return { accepted, refused };
}

// ─── The check ────────────────────────────────────────────────────

export type SamlReason =
  | 'malformed-xml' | 'too-large' | 'doctype' | 'entity' | 'comment' | 'cdata' | 'processing-instruction' | 'duplicate-attribute' | 'namespace'
  | 'not-a-response' | 'status-not-success' | 'assertion-count' | 'assertion-misplaced' | 'duplicate-id' | 'missing-id'
  | 'unsigned' | 'signature-misplaced' | 'reference-mismatch' | 'transform' | 'weak-algorithm' | 'unpinned-certificate' | 'bad-signature' | 'bad-digest' | 'signature-unsupported' | 'no-pinned-key'
  | 'issuer' | 'destination' | 'recipient' | 'audience' | 'subject' | 'conditions' | 'not-yet-valid' | 'expired' | 'stale' | 'lifetime-too-long'
  | 'in-response-to' | 'unsolicited' | 'unknown-request' | 'replayed' | 'replay-cache-full' | 'encrypted-refused' | 'no-saml-response'
  | 'cross-tenant' | 'unknown-tenant';

/** Reasons that mean the response was wrong or hostile, not that the guard is misconfigured. */
export const SAML_ATTACK_REASONS: readonly SamlReason[] = [
  'doctype', 'entity', 'comment', 'cdata', 'processing-instruction', 'duplicate-attribute', 'namespace', 'assertion-count', 'assertion-misplaced',
  'duplicate-id', 'unsigned', 'signature-misplaced', 'reference-mismatch', 'transform', 'weak-algorithm', 'bad-signature', 'bad-digest',
  'expired', 'stale', 'lifetime-too-long', 'in-response-to', 'unknown-request', 'replayed', 'cross-tenant',
];

export interface SamlGuardConfig {
  /** The IdP's entity ID: Issuer of the Response (when present) and of the Assertion. */
  idpEntityId: string;
  /** This SP's entity ID: must appear in the assertion's AudienceRestriction. */
  spEntityId: string;
  /** ACS URLs this SP answers on: Destination and SubjectConfirmationData Recipient must be one of them. */
  acsUrls: readonly string[];
  /** Operator-signed certificate pins (declareIdpPin) and the operator keys trusted to sign them. */
  pins?: readonly IdpPin[];
  trustedPinSigners?: readonly string[];
  /** Multi-tenant: the tenant this configuration is for; pins must name it. */
  tenantId?: string;
  /**
   * The cryptographic signature check. 'builtin' (default since 15.37.0): exclusive C14N + RSA/ECDSA with a
   * pinned certificate, on the same tree the guard checked. 'left-to-sp': structure only, the SP's library
   * verifies (a broken SP signature check then passes — the doctor flags it). verifySignature overrides both.
   */
  signature?: 'builtin' | 'left-to-sp';
  /** Refuse a response whose signature embeds no certificate (default false: pinned certificates are used). */
  requireEmbeddedCertificate?: boolean;
  /** Require the Assertion itself to be signed (default false: a signed Response containing it also counts). */
  requireSignedAssertion?: boolean;
  /** EncryptedAssertion: 'pass-to-sp' checks the Response envelope and leaves the assertion to the SP (default); 'refuse'. */
  encryptedAssertions?: 'pass-to-sp' | 'refuse';
  /** IdP-initiated responses (no InResponseTo). Default true; set false once SP-initiated login is the norm. */
  allowUnsolicited?: boolean;
  clockSkewSec?: number;
  /** Longest NotBefore→NotOnOrAfter accepted (default 10 min). */
  maxLifetimeSec?: number;
  /** IssueInstant older than this is stale (default 5 min). */
  maxAgeSec?: number;
  /** Custom cryptographic check (e.g. a vetted XML-DSig library), instead of the built-in one. */
  verifySignature?: (xml: string, signed: { element: 'Response' | 'Assertion'; id: string; certificate?: string }) => Promise<boolean>;
  /** Salt for subject hashes in verdicts and reports (no NameID leaves the guard). */
  subjectSalt?: string;
  maxReplayEntries?: number;
  limits?: XmlLimits;
}

/** What the response claimed about where it came from and where it goes (for cross-tenant classification). */
export interface SamlObserved { issuers: string[]; audiences: string[]; destination?: string; recipient?: string; certificateSha256s: string[] }

export interface SamlVerdict {
  allowed: boolean;
  reason?: SamlReason;
  detail?: string;
  tenant?: string;
  assertion: 'plain' | 'encrypted' | 'unknown';
  signature: 'verified' | 'left-to-sp' | 'bad-signature' | 'not-checked';
  solicited: 'matched' | 'unsolicited' | 'unknown-request' | 'not-checked';
  certificate: 'pinned' | 'not-embedded' | 'unpinned' | 'not-checked';
  assertionId?: string;
  inResponseTo?: string;
  subjectHash?: string;
  notOnOrAfter?: string;
  observed?: SamlObserved;
}

interface Store { outstanding: Map<string, number>; seen: Map<string, number> }

const time = (v: string | undefined, reason: SamlReason): number | undefined => {
  if (v === undefined) return undefined;
  const t = Date.parse(v);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v) || !Number.isFinite(t)) throw new SamlRefusal(reason, `time ${v}`);
  return t;
};

const softText = (el: XmlEl | undefined) => (el && !el.children.length ? el.text.trim() : undefined);
async function observe(root: XmlEl, a: XmlEl): Promise<SamlObserved> {
  const o: SamlObserved = { issuers: [], audiences: [], destination: root.attrs.Destination, certificateSha256s: [] };
  for (const el of [root, a]) { const i = softText(el.children.find((c) => c.ns === SAML_NS.assertion && c.local === 'Issuer')); if (i) o.issuers.push(i); }
  walk(a, (e) => {
    if (e.ns === SAML_NS.assertion && e.local === 'Audience') { const t = softText(e); if (t) o.audiences.push(t); }
    if (e.ns === SAML_NS.assertion && e.local === 'SubjectConfirmationData' && e.attrs.Recipient) o.recipient ??= e.attrs.Recipient;
  });
  const certs: string[] = []; walk(root, (e) => { if (e.ns === SAML_NS.dsig && e.local === 'X509Certificate') { const t = softText(e); if (t) certs.push(t); } });
  for (const c of certs) { const h = await certificateSha256(c).catch(() => ''); if (h) o.certificateSha256s.push(h); }
  return o;
}

export function createSamlChecker(cfg: SamlGuardConfig, store: Store = { outstanding: new Map(), seen: new Map() }) {
  const skew = (cfg.clockSkewSec ?? 120) * 1000;
  const maxLife = (cfg.maxLifetimeSec ?? 600) * 1000;
  const maxAge = (cfg.maxAgeSec ?? 300) * 1000;
  const maxReplay = cfg.maxReplayEntries ?? 500_000;
  const sigMode = cfg.signature ?? 'builtin';
  let pinCache: { at: number; pins: IdpPin[] } | null = null;

  async function pinned(now: number): Promise<IdpPin[]> {
    if (pinCache && now - pinCache.at < 60_000) return pinCache.pins;
    const { accepted } = await acceptedPins((cfg.pins ?? []).filter((p) => p.idpEntityId === cfg.idpEntityId), cfg.trustedPinSigners ?? [], now, cfg.tenantId);
    pinCache = { at: now, pins: accepted };
    return accepted;
  }

  function sweep(now: number) {
    for (const [k, exp] of store.seen) if (exp < now) store.seen.delete(k);
    for (const [k, at] of store.outstanding) if (now - at > 15 * 60_000) store.outstanding.delete(k);
  }

  /** Record an AuthnRequest ID this SP sent (the guard sees it on the SP's redirect). */
  function expectRequest(id: string, now = Date.now()) { if (/^[A-Za-z_][\w.-]{0,255}$/.test(id)) { if (store.outstanding.size > 100_000) sweep(now); store.outstanding.set(id, now); } }

  async function check(xml: string, now = Date.now()): Promise<SamlVerdict> {
    const v: SamlVerdict = { allowed: false, tenant: cfg.tenantId, assertion: 'unknown', signature: 'not-checked', solicited: 'not-checked', certificate: 'not-checked' };
    try {
      const root = parseStrictXml(xml, cfg.limits);
      await inspect(root, xml, v, now);
      v.allowed = true;
      if (v.assertionId) store.seen.set(`${cfg.idpEntityId}|${v.assertionId}`, (v.notOnOrAfter ? Date.parse(v.notOnOrAfter) : now + maxLife) + skew);
      if (v.inResponseTo && v.solicited === 'matched') store.outstanding.delete(v.inResponseTo);
    } catch (e) {
      if (!(e instanceof SamlRefusal)) throw e;
      v.allowed = false; v.reason = e.reason; v.detail = e.message;
    }
    return v;
  }

  async function inspect(root: XmlEl, xml: string, v: SamlVerdict, now: number) {
    if (root.ns !== SAML_NS.protocol || root.local !== 'Response') throw new SamlRefusal('not-a-response', `${root.ns} ${root.local}`);

    // One assertion, in the one place: wrapping attacks add a second (or hide one in Extensions/Object).
    const assertions: XmlEl[] = []; const ids = new Set<string>(); const signatures: XmlEl[] = [];
    walk(root, (e) => {
      if (e.local === 'Assertion' || e.local === 'EncryptedAssertion') assertions.push(e);
      if (e.local === 'Signature') signatures.push(e);
      for (const k of ['ID', 'Id', 'id']) if (k in e.attrs) { if (ids.has(e.attrs[k])) throw new SamlRefusal('duplicate-id', e.attrs[k]); ids.add(e.attrs[k]); }
    });
    if (assertions.length !== 1) throw new SamlRefusal('assertion-count', String(assertions.length));
    const a = assertions[0];
    if (a.parent !== root || a.ns !== SAML_NS.assertion) throw new SamlRefusal('assertion-misplaced', `${a.parent?.local} ${a.ns}`);
    v.observed = await observe(root, a);
    const responseId = root.attrs.ID; if (!responseId) throw new SamlRefusal('missing-id', 'Response');

    const status = one(root, SAML_NS.protocol, 'Status', 'status-not-success')!;
    const code = one(status, SAML_NS.protocol, 'StatusCode', 'status-not-success')!;
    if (code.attrs.Value !== SUCCESS) throw new SamlRefusal('status-not-success', code.attrs.Value);

    const rIssuer = one(root, SAML_NS.assertion, 'Issuer', 'issuer', true);
    if (rIssuer && leafText(rIssuer, 'issuer') !== cfg.idpEntityId) throw new SamlRefusal('issuer', 'Response');
    if (!root.attrs.Destination || !cfg.acsUrls.includes(root.attrs.Destination)) throw new SamlRefusal('destination', root.attrs.Destination ?? 'missing');
    const issued = time(root.attrs.IssueInstant, 'stale');
    if (issued === undefined || issued > now + skew || now - issued > maxAge + skew) throw new SamlRefusal('stale', root.attrs.IssueInstant);

    // Solicited: InResponseTo names a request this SP (this tenant) sent and has not used yet.
    const irt = root.attrs.InResponseTo;
    if (irt) {
      v.inResponseTo = irt;
      if (store.outstanding.size || cfg.allowUnsolicited === false) {
        const sentAt = store.outstanding.get(irt);
        if (sentAt === undefined || now - sentAt > 15 * 60_000) { v.solicited = 'unknown-request'; throw new SamlRefusal('unknown-request', irt); }
        v.solicited = 'matched';
      }
    } else {
      v.solicited = 'unsolicited';
      if (cfg.allowUnsolicited === false) throw new SamlRefusal('unsolicited');
    }

    // Signatures: each directly inside the element it signs, one Reference to that element's own ID.
    const signed = new Map<XmlEl, XmlEl>(); const embedded: string[] = [];
    for (const sig of signatures) {
      if (sig.ns !== SAML_NS.dsig) throw new SamlRefusal('signature-misplaced', `Signature in ${sig.ns}`);
      const owner = sig.parent!;
      if (owner !== root && owner !== a) throw new SamlRefusal('signature-misplaced', `in ${owner.local}`);
      if (signed.has(owner)) throw new SamlRefusal('signature-misplaced', `two signatures on ${owner.local}`);
      const si = one(sig, SAML_NS.dsig, 'SignedInfo', 'reference-mismatch')!;
      const c14n = one(si, SAML_NS.dsig, 'CanonicalizationMethod', 'transform')!;
      if (!C14N.includes(c14n.attrs.Algorithm)) throw new SamlRefusal('transform', c14n.attrs.Algorithm);
      const sm = one(si, SAML_NS.dsig, 'SignatureMethod', 'weak-algorithm')!;
      if (!(SAML_SIGNATURE_ALGORITHMS as readonly string[]).includes(sm.attrs.Algorithm)) throw new SamlRefusal('weak-algorithm', sm.attrs.Algorithm);
      const refs = kids(si, SAML_NS.dsig, 'Reference');
      const ownerId = owner.attrs.ID;
      if (refs.length !== 1 || !ownerId || refs[0].attrs.URI !== `#${ownerId}`) throw new SamlRefusal('reference-mismatch', `${refs.map((r) => r.attrs.URI).join(',')} vs #${ownerId}`);
      const tr = one(refs[0], SAML_NS.dsig, 'Transforms', 'transform', true);
      for (const t of tr?.children ?? []) if (t.ns !== SAML_NS.dsig || t.local !== 'Transform' || !TRANSFORMS.includes(t.attrs.Algorithm) || t.children.some((c) => c.local !== 'InclusiveNamespaces')) throw new SamlRefusal('transform', t.attrs.Algorithm ?? t.local);
      const dm = one(refs[0], SAML_NS.dsig, 'DigestMethod', 'weak-algorithm')!;
      if (!(SAML_DIGEST_ALGORITHMS as readonly string[]).includes(dm.attrs.Algorithm)) throw new SamlRefusal('weak-algorithm', dm.attrs.Algorithm);
      const certs: XmlEl[] = []; walk(sig, (e) => { if (e.ns === SAML_NS.dsig && e.local === 'X509Certificate') certs.push(e); });
      for (const c of certs) embedded.push(leafText(c, 'unpinned-certificate').replace(/\s+/g, ''));
      signed.set(owner, sig);
    }
    if (!signed.has(a) && (cfg.requireSignedAssertion || !signed.has(root))) throw new SamlRefusal('unsigned', cfg.requireSignedAssertion ? 'assertion not signed' : 'neither response nor assertion signed');

    const pins = await pinned(now);
    const pinnedShas = new Set(pins.map((p) => p.certSha256.toLowerCase()));
    const keys = new Set(pins.flatMap((p) => (p.certificate ? [p.certificate] : [])));
    if (embedded.length) {
      for (const c of embedded) {
        if (!pinnedShas.has(await certificateSha256(c).catch(() => ''))) { v.certificate = 'unpinned'; throw new SamlRefusal('unpinned-certificate'); }
        keys.add(c); // pinned by hash (a v1 pin carries no certificate): its key may verify
      }
      v.certificate = 'pinned';
    } else {
      v.certificate = 'not-embedded';
      if (cfg.requireEmbeddedCertificate) throw new SamlRefusal('unpinned-certificate', 'no certificate embedded');
    }

    if (cfg.verifySignature) {
      for (const [owner] of signed) {
        const ok = await cfg.verifySignature(xml, { element: owner === root ? 'Response' : 'Assertion', id: owner.attrs.ID, certificate: embedded[0] }).catch(() => false);
        if (!ok) { v.signature = 'bad-signature'; throw new SamlRefusal('bad-signature', owner.local); }
      }
      v.signature = 'verified';
    } else if (sigMode === 'builtin') {
      for (const [, sig] of signed) {
        const r = await verifyEnvelopedSignature(sig, [...keys]);
        if (!r.ok) {
          v.signature = 'bad-signature';
          throw new SamlRefusal(r.reason === 'unsupported' ? 'signature-unsupported' : r.reason === 'no-key' ? 'no-pinned-key' : r.reason, r.detail);
        }
      }
      v.signature = 'verified';
    } else v.signature = 'left-to-sp';

    if (a.local === 'EncryptedAssertion') {
      v.assertion = 'encrypted';
      if (cfg.encryptedAssertions === 'refuse') throw new SamlRefusal('encrypted-refused');
      return;
    }
    v.assertion = 'plain';
    await inspectAssertion(a, v, now, irt);
  }

  async function inspectAssertion(a: XmlEl, v: SamlVerdict, now: number, irt: string | undefined) {
    const id = a.attrs.ID; if (!id) throw new SamlRefusal('missing-id', 'Assertion');
    v.assertionId = id;
    const issuer = one(a, SAML_NS.assertion, 'Issuer', 'issuer')!;
    if (leafText(issuer, 'issuer') !== cfg.idpEntityId) throw new SamlRefusal('issuer', 'Assertion');
    const ai = time(a.attrs.IssueInstant, 'stale');
    if (ai === undefined || ai > now + skew || now - ai > maxAge + skew) throw new SamlRefusal('stale', a.attrs.IssueInstant);

    const subject = one(a, SAML_NS.assertion, 'Subject', 'subject')!;
    const nameId = one(subject, SAML_NS.assertion, 'NameID', 'subject')!;
    const name = leafText(nameId, 'subject');
    if (!name) throw new SamlRefusal('subject', 'empty NameID');
    v.subjectHash = await sha256HexOf(`${cfg.subjectSalt ?? ''}|${name.toLowerCase()}`);
    const scs = kids(subject, SAML_NS.assertion, 'SubjectConfirmation').filter((c) => c.attrs.Method === BEARER);
    if (scs.length !== 1) throw new SamlRefusal('subject', `${scs.length} bearer confirmations`);
    const scd = one(scs[0], SAML_NS.assertion, 'SubjectConfirmationData', 'recipient')!;
    if (!scd.attrs.Recipient || !cfg.acsUrls.includes(scd.attrs.Recipient)) throw new SamlRefusal('recipient', scd.attrs.Recipient ?? 'missing');
    const scdEnd = time(scd.attrs.NotOnOrAfter, 'expired');
    if (scdEnd === undefined || scdEnd <= now - skew) throw new SamlRefusal('expired', 'SubjectConfirmationData');
    if (scd.attrs.InResponseTo !== irt && !(irt === undefined && scd.attrs.InResponseTo === undefined)) throw new SamlRefusal('in-response-to', `${scd.attrs.InResponseTo} vs ${irt}`);

    const cond = one(a, SAML_NS.assertion, 'Conditions', 'conditions')!;
    const nb = time(cond.attrs.NotBefore, 'not-yet-valid');
    const na = time(cond.attrs.NotOnOrAfter, 'expired');
    if (na === undefined) throw new SamlRefusal('conditions', 'no NotOnOrAfter');
    if (nb !== undefined && nb > now + skew) throw new SamlRefusal('not-yet-valid');
    if (na <= now - skew) throw new SamlRefusal('expired', 'Conditions');
    if (Math.max(na, scdEnd) - (nb ?? ai) > maxLife) throw new SamlRefusal('lifetime-too-long', `${Math.round((Math.max(na, scdEnd) - (nb ?? ai)) / 1000)} s`);
    v.notOnOrAfter = new Date(Math.max(na, scdEnd)).toISOString();
    const restrictions = kids(cond, SAML_NS.assertion, 'AudienceRestriction');
    if (!restrictions.length) throw new SamlRefusal('audience', 'no AudienceRestriction');
    // Every AudienceRestriction must name this SP (SAML core 2.5.1.4: all must be satisfied).
    for (const r of restrictions) if (!kids(r, SAML_NS.assertion, 'Audience').some((x) => leafText(x, 'audience') === cfg.spEntityId)) throw new SamlRefusal('audience');

    const key = `${cfg.idpEntityId}|${id}`;
    const seen = store.seen.get(key);
    if (seen !== undefined && seen >= now) throw new SamlRefusal('replayed', id);
    if (store.seen.size >= maxReplay) { sweep(now); if (store.seen.size >= maxReplay) throw new SamlRefusal('replay-cache-full'); }
  }

  return { check, expectRequest, store, config: cfg };
}

// ─── Bindings ─────────────────────────────────────────────────────

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
export function decodeSamlResponse(b64: string): string | null {
  const s = b64.replace(/[\r\n ]/g, '');
  if (!s || s.length % 4 !== 0 || !B64.test(s)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))); } catch { return null; }
}

/** An AuthnRequest in an HTTP-Redirect binding URL (SAMLRequest = base64(deflate-raw(xml))): its ID, Issuer (SP entity) and ACS URL. */
export function authnRequestFromUrl(url: string): { id: string; issuer?: string; acsUrl?: string } | null {
  try {
    const q = new URL(url).searchParams.get('SAMLRequest');
    if (!q) return null;
    const xml = new TextDecoder().decode(inflateSync(Uint8Array.from(atob(q), (c) => c.charCodeAt(0))));
    const root = parseStrictXml(xml, { maxBytes: 64 * 1024, maxDepth: 16, maxElements: 200 });
    if (root.ns !== SAML_NS.protocol || root.local !== 'AuthnRequest' || !root.attrs.ID) return null;
    return { id: root.attrs.ID, issuer: softText(root.children.find((c) => c.ns === SAML_NS.assertion && c.local === 'Issuer')), acsUrl: root.attrs.AssertionConsumerServiceURL };
  } catch { return null; }
}
/** The ID of an AuthnRequest in an HTTP-Redirect binding URL. */
export const authnRequestIdFromUrl = (url: string): string | null => authnRequestFromUrl(url)?.id ?? null;

/** The SP's own verdict on a POST to its ACS: X-Legacy-Verdict if it sets one; else 4xx/5xx deny, a session cookie allow. */
export function spVerdict(res: Response, header = 'x-legacy-verdict'): LegacyVerdict {
  const h = res.headers.get(header)?.trim().toLowerCase();
  if (h === 'allow' || h === 'deny') return h;
  if (res.status >= 400) return 'deny';
  if (res.headers.get('set-cookie')) return 'allow';
  return 'missing';
}

// ─── Tenant modes, governed ───────────────────────────────────────

/** An operator-signed change of a tenant's mode; enforce cites the shadow report it was decided on. */
export interface SamlTenantModeRecord { v: 1; kind: 'cappz.saml.tenant-mode'; tenantId: string; mode: 'shadow' | 'enforce'; at: string; reason: string; reportHash: string | null; signerKey: string; signature: string }

const modeText = (r: Omit<SamlTenantModeRecord, 'signature'>) => canonicalJson(r);

export async function signTenantMode(r: { tenantId: string; mode: 'shadow' | 'enforce'; reason: string; reportHash?: string | null; at?: string }, key: SigningKey): Promise<SamlTenantModeRecord> {
  if (r.mode === 'enforce' && !r.reportHash && !r.reason.trim()) throw new Error('enforce needs the shadow report hash, or a reason');
  const unsigned = { v: 1 as const, kind: 'cappz.saml.tenant-mode' as const, tenantId: r.tenantId, mode: r.mode, at: r.at ?? new Date().toISOString(), reason: r.reason, reportHash: r.reportHash ?? null, signerKey: key.publicKeyHex };
  return { ...unsigned, signature: await signCanonical(modeText(unsigned), key) };
}

/** Replay signed mode records from trusted operators (in time order): each tenant's current mode with the record that set it. */
export async function replaySamlTenantModes(records: readonly SamlTenantModeRecord[], trustedKeys: readonly string[]): Promise<{ modes: Record<string, SamlTenantModeRecord>; refused: number }> {
  const modes: Record<string, SamlTenantModeRecord> = {}; let refused = 0;
  for (const r of [...records].sort((x, y) => Date.parse(x.at) - Date.parse(y.at))) {
    const { signature, ...unsigned } = r;
    if (r?.kind !== 'cappz.saml.tenant-mode' || !trustedKeys.includes(r.signerKey) || !(await verifyCanonical(modeText(unsigned), signature, r.signerKey).catch(() => false))) { refused++; continue; }
    modes[r.tenantId] = r;
  }
  return { modes, refused };
}

// ─── The guard in front of one or many ACSs ───────────────────────

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'host', 'content-length', 'expect'];
const VERDICT_HEADERS = ['cappz-saml-verdict', 'cappz-saml-subject-hash', 'cappz-saml-assertion', 'cappz-saml-signature', 'cappz-saml-tenant'];

export interface SamlGatePolicy { minResponses: number; minDays: number; /** Refusals the SP also accepted that need no explanation (hostile by construction). */ acceptedStricterReasons: readonly string[] }
export const DEFAULT_SAML_GATE: SamlGatePolicy = { minResponses: 500, minDays: 7, acceptedStricterReasons: SAML_ATTACK_REASONS };

/** One customer of a multi-tenant SaaS: its own IdP, its own ACS URL(s) and SP entity, its own pins and mode. */
export interface SamlTenant extends Omit<SamlGuardConfig, 'tenantId'> { id: string; mode?: 'shadow' | 'enforce' }

export interface SamlGuardOptions {
  /** One IdP, one SP (15.36 shape). */
  config?: SamlGuardConfig;
  /** A multi-tenant SaaS: each tenant chosen by the ACS URL the response is posted to. */
  tenants?: readonly SamlTenant[];
  /** Default mode: 'shadow' (the SP stays authoritative; the guard records) or 'enforce' (refusals never reach the SP). */
  mode: 'shadow' | 'enforce';
  /** Current per-tenant modes (replaySamlTenantModes over the operator's signed records); read per request. */
  tenantModes?: () => Record<string, 'shadow' | 'enforce'> | Promise<Record<string, 'shadow' | 'enforce'>>;
  /** The SP: base URL or a fetch function. */
  upstream: string | ((req: Request) => Promise<Response>);
  /** Single-tenant: ACS paths on this host (default: the paths of config.acsUrls). */
  acsPaths?: readonly string[];
  /** Behind a reverse proxy: take the scheme from X-Forwarded-Proto (default true — bind the guard to loopback). */
  trustForwardedProto?: boolean;
  gate?: SamlGatePolicy;
  shadowState?: ShadowState;
  /** Multi-tenant: saved shadow state per tenant id. */
  shadowStates?: Record<string, ShadowState>;
  /** Multi-tenant: saved cross-tenant attempt counts per tenant id. */
  crossTenantCounts?: Record<string, number>;
  cost?: CostAssumptions;
  /** Called for every checked response (audit log, TX writer, alerting): verdicts carry hashes, never the NameID. */
  onVerdict?: (v: SamlVerdict & { mode: 'shadow' | 'enforce'; sp?: LegacyVerdict; at: string }) => void | Promise<void>;
  maxBodyBytes?: number;
  now?: () => number;
}

export interface SamlGateReport {
  responses: number; days: number;
  counts: Record<string, number>;
  /** Responses the SP accepted that the guard refused, by reason: each is a login the SP should not have taken (or a guard misconfiguration). */
  spAcceptedGuardRefused: Record<string, number>;
  /** Responses the SP refused that the guard passed: fine while the SP stays in the path (it verifies the signature). */
  spRefusedGuardPassed: number;
  latencyMs: { guard: { p50: number; p95: number; p99: number } };
  enforce: { ready: boolean; because: string[] };
  reportHash: string;
}

export interface SamlMultiReport {
  tenants: Record<string, SamlGateReport & { mode: 'shadow' | 'enforce'; crossTenant: number }>;
  /** Responses posted to an ACS path no tenant's URL matched. */
  unknownTenant: number;
  reportHash: string;
}

export function createSamlGuard(o: SamlGuardOptions) {
  const now = o.now ?? Date.now;
  const multi = !!o.tenants;
  const tenants: SamlTenant[] = o.tenants ? [...o.tenants] : o.config ? [{ ...o.config, id: o.config.tenantId ?? 'default' }] : [];
  if (!tenants.length) throw new Error('SAML Guard needs config or tenants');
  const ids = new Set<string>();
  for (const t of tenants) { if (ids.has(t.id)) throw new Error(`tenant ${t.id} listed twice`); ids.add(t.id); }
  const gate = o.gate ?? DEFAULT_SAML_GATE;
  const per = new Map(tenants.map((t) => [t.id, {
    tenant: t,
    checker: createSamlChecker({ ...t, ...(multi ? { tenantId: t.id } : {}) }),
    compare: createShadowComparison({ state: multi ? o.shadowStates?.[t.id] : o.shadowState, now, policy: { minRequests: gate.minResponses, minDays: gate.minDays, acceptedStricterReasons: gate.acceptedStricterReasons, minDenials: 0 } }),
    crossTenant: o.crossTenantCounts?.[t.id] ?? 0,
  }]));
  // Login URL → tenant. Exact URL first; a path only when no other tenant shares it (host-based tenancy needs Host passed through).
  const byUrl = new Map<string, string>(); const byPath = new Map<string, string[]>();
  for (const t of tenants) for (const u of t.acsUrls) {
    if (byUrl.has(u)) throw new Error(`ACS URL ${u} belongs to two tenants`);
    byUrl.set(u, t.id); const p = new URL(u).pathname; byPath.set(p, [...(byPath.get(p) ?? []), t.id]);
  }
  if (!multi && o.acsPaths) for (const p of o.acsPaths) byPath.set(p, [tenants[0].id]);
  let unknownTenant = 0;
  const maxBody = o.maxBodyBytes ?? 512 * 1024;
  const fetchUp = typeof o.upstream === 'function' ? o.upstream : (r: Request) => fetch(r);

  function tenantFor(req: Request, url: URL): { id: string | null; isAcs: boolean } {
    const proto = (o.trustForwardedProto ?? true) ? req.headers.get('x-forwarded-proto')?.split(',')[0].trim() : undefined;
    const full = `${proto ? `${proto}:` : url.protocol}//${url.host}${url.pathname}`;
    const exact = byUrl.get(full);
    if (exact) return { id: exact, isAcs: true };
    const onPath = byPath.get(url.pathname);
    if (!onPath) return { id: null, isAcs: false };
    return { id: onPath.length === 1 ? onPath[0] : null, isAcs: true };
  }

  /** A refusal whose response names another tenant's IdP, SP, ACS or pinned certificate is the cross-tenant login. */
  async function classify(v: SamlVerdict, own: SamlTenant, count = true): Promise<SamlVerdict> {
    if (!multi || v.allowed || !v.observed || !['issuer', 'audience', 'recipient', 'destination', 'unpinned-certificate', 'bad-signature', 'no-pinned-key'].includes(v.reason ?? '')) return v;
    const ob = v.observed;
    for (const t of tenants) {
      if (t.id === own.id) continue;
      const theirShas = new Set((t.pins ?? []).filter((p) => p.tenantId === t.id).map((p) => p.certSha256.toLowerCase()));
      const hit = (ob.issuers.includes(t.idpEntityId) && t.idpEntityId !== own.idpEntityId) || (ob.audiences.includes(t.spEntityId) && !ob.audiences.includes(own.spEntityId))
        || (!!ob.destination && t.acsUrls.includes(ob.destination)) || (!!ob.recipient && t.acsUrls.includes(ob.recipient))
        || ob.certificateSha256s.some((h) => theirShas.has(h));
      if (hit) { if (count) per.get(own.id)!.crossTenant++; return { ...v, reason: 'cross-tenant', detail: `${v.reason}: the response names tenant ${t.id}, posted to tenant ${own.id}` }; }
    }
    return v;
  }

  function forwardRequest(req: Request, body: Uint8Array | null, extra: Record<string, string> = {}): Request {
    const url = new URL(req.url);
    const target = typeof o.upstream === 'string' ? new URL(url.pathname + url.search, o.upstream).toString() : req.url;
    const h = new Headers();
    req.headers.forEach((v, k) => { if (!HOP_BY_HOP.includes(k) && !VERDICT_HEADERS.includes(k)) h.set(k, v); });
    if (typeof o.upstream === 'string') h.set('x-forwarded-host', req.headers.get('x-forwarded-host') ?? url.host);
    for (const [k, v] of Object.entries(extra)) h.set(k, v);
    return new Request(target, { method: req.method, headers: h, body: body && body.length && req.method !== 'GET' && req.method !== 'HEAD' ? buf(body) : undefined, redirect: 'manual' });
  }

  /** Learn AuthnRequest IDs from the SP's redirects to the IdP — per tenant (by its SP entity or ACS URL), so InResponseTo cannot cross tenants. */
  function learn(res: Response, hint: string | null) {
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      const r = authnRequestFromUrl(loc);
      if (r) {
        const t = tenants.find((x) => (r.issuer && x.spEntityId === r.issuer) || (r.acsUrl && x.acsUrls.includes(r.acsUrl)))?.id ?? (multi ? hint : tenants[0].id);
        if (t) per.get(t)!.checker.expectRequest(r.id, now());
      }
    }
    return res;
  }

  async function modeOf(id: string): Promise<'shadow' | 'enforce'> {
    const m = o.tenantModes ? (await o.tenantModes())[id] : undefined;
    return m ?? per.get(id)!.tenant.mode ?? o.mode;
  }

  async function tenantReport(id: string): Promise<SamlGateReport> {
    const p = per.get(id)!;
    const r = await p.compare.report(o.cost ?? { instanceUsdPerHour: 0, vcpus: 1, label: 'not priced' });
    const s = p.compare.state();
    const because: string[] = [];
    if (r.requests < gate.minResponses) because.push(`${r.requests} of ${gate.minResponses} SAML responses seen`);
    if (r.days < gate.minDays) because.push(`${r.days.toFixed(2)} of ${gate.minDays} days observed`);
    if (r.counts['legacy-missing']) because.push(`${r.counts['legacy-missing']} SP answers without a readable verdict (set X-Legacy-Verdict, or check the SP sets its session cookie on success)`);
    const unexplained = Object.entries(s.stricterReasons).filter(([k]) => !gate.acceptedStricterReasons.includes(k));
    if (unexplained.length) because.push(`the SP accepted responses the guard refused for configuration reasons — confirm each is a real finding (the SP does not check it) or fix the guard's configuration: ${unexplained.map(([k, c]) => `${k} ×${c}`).join(', ')}`);
    const body = {
      responses: r.requests, days: r.days,
      counts: { agree: r.counts.agree, 'sp-accepted-guard-refused': r.counts['cappz-stricter'], 'sp-refused-guard-passed': r.counts['cappz-looser'], 'sp-verdict-missing': r.counts['legacy-missing'] },
      spAcceptedGuardRefused: { ...s.stricterReasons }, spRefusedGuardPassed: r.counts['cappz-looser'],
      latencyMs: { guard: { p50: r.latencyMs.cappz.p50, p95: r.latencyMs.cappz.p95, p99: r.latencyMs.cappz.p99 } },
      enforce: { ready: because.length === 0, because: because.length ? because : ['every gate passed: switch the guard to enforce (the SP keeps its own check)'] },
    };
    return { ...body, reportHash: await sha256HexOf(canonicalJson(body)) };
  }

  async function report(): Promise<SamlGateReport | SamlMultiReport> {
    if (!multi) return tenantReport(tenants[0].id);
    const out: SamlMultiReport['tenants'] = {};
    for (const t of tenants) out[t.id] = { ...(await tenantReport(t.id)), mode: await modeOf(t.id), crossTenant: per.get(t.id)!.crossTenant };
    const body = { tenants: out, unknownTenant };
    return { ...body, reportHash: await sha256HexOf(canonicalJson(body)) };
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/cappz/saml/report') return Response.json(await report());
    const { id, isAcs } = tenantFor(req, url);
    if (req.method !== 'POST' || !isAcs) {
      const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBounded(req, maxBody);
      if (body === null && req.method !== 'GET' && req.method !== 'HEAD') return new Response('request too large', { status: 413 });
      return learn(await fetchUp(forwardRequest(req, body)), id);
    }
    const body = await readBounded(req, maxBody);
    if (body === null) return new Response('request too large', { status: 413 });
    const at = new Date(now()).toISOString();
    if (!id) {
      unknownTenant++;
      const v: SamlVerdict = { allowed: false, reason: 'unknown-tenant', detail: `${url.host}${url.pathname} matches no tenant's ACS URL`, assertion: 'unknown', signature: 'not-checked', solicited: 'not-checked', certificate: 'not-checked' };
      await o.onVerdict?.({ ...v, mode: o.mode, at });
      if (o.mode === 'enforce') return Response.json({ error: 'SAML response refused', reason: v.reason }, { status: 403 });
      return fetchUp(forwardRequest(req, body));
    }
    const p = per.get(id)!;
    const mode = await modeOf(id);
    const started = performance.now();
    const form = new URLSearchParams(new TextDecoder().decode(body));
    const raw = form.getAll('SAMLResponse');
    const xml = raw.length === 1 ? decodeSamlResponse(raw[0]) : null;
    const v = await classify(xml === null
      ? { allowed: false, tenant: id, reason: raw.length > 1 ? 'assertion-count' : 'no-saml-response', detail: raw.length > 1 ? 'two SAMLResponse fields' : undefined, assertion: 'unknown', signature: 'not-checked', solicited: 'not-checked', certificate: 'not-checked' }
      : await p.checker.check(xml, now()), p.tenant);
    const guardMs = performance.now() - started;
    const headers: Record<string, string> = { 'cappz-saml-verdict': v.allowed ? 'pass' : `refuse; reason=${v.reason}`, 'cappz-saml-assertion': v.assertion, 'cappz-saml-signature': v.signature };
    if (multi) headers['cappz-saml-tenant'] = id;
    if (v.subjectHash) headers['cappz-saml-subject-hash'] = v.subjectHash;

    if (mode === 'enforce') {
      await o.onVerdict?.({ ...v, mode, at });
      if (!v.allowed) return Response.json({ error: 'SAML response refused', reason: v.reason }, { status: 403, headers: { 'cappz-saml-verdict': headers['cappz-saml-verdict'] } });
      return learn(await fetchUp(forwardRequest(req, body, headers)), id);
    }
    // Shadow: the SP decides; the guard records what it would have done.
    const res = await fetchUp(forwardRequest(req, body));
    const sp = spVerdict(res);
    p.compare.record({ cappz: { allowed: v.allowed, reason: v.reason ?? 'pass' }, cappzMs: guardMs, legacy: sp, path: url.pathname });
    await o.onVerdict?.({ ...v, mode, sp, at });
    return learn(res, id);
  }

  /** Check one response offline for a tenant (wizard `test`, CI): nothing is recorded in the shadow report. */
  async function checkFor(tenantId: string, xml: string, at = now()): Promise<SamlVerdict> {
    const p = per.get(tenantId); if (!p) throw new Error(`no tenant ${tenantId}`);
    return classify(await createSamlChecker({ ...p.tenant, ...(multi ? { tenantId } : {}) }).check(xml, at), p.tenant, false);
  }

  const single = per.get(tenants[0].id)!;
  return {
    handle, report, checkFor,
    check: single.checker.check, expectRequest: single.checker.expectRequest, state: () => single.compare.state(),
    states: () => Object.fromEntries([...per].map(([k, p]) => [k, p.compare.state()])),
    tenants: () => tenants.map((t) => t.id),
    crossTenantCounts: () => Object.fromEntries([...per].map(([k, p]) => [k, p.crossTenant])),
  };
}
