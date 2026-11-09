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
 * The cryptographic signature check stays with the SP's own SAML library
 * unless a verifier is plugged in (`verifySignature`), and the verdict says
 * which ('left-to-sp' | 'verified'): both checks must pass, so an attacker has
 * to fool two different parsers, and the guard's half never trusts content it
 * cannot place unambiguously.
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

export interface XmlEl { ns: string; local: string; qname: string; attrs: Record<string, string>; children: XmlEl[]; text: string; parent?: XmlEl }

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
export function parseStrictXml(xml: string, limits: XmlLimits = DEFAULT_XML_LIMITS): XmlEl {
  if (utf8(xml).length > limits.maxBytes) throw new SamlRefusal('too-large');
  let i = 0;
  const s = xml.replace(/^\uFEFF/, '');
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
      else stack[stack.length - 1].el.text += decodeText(text);
    }
    if (lt < 0) break;
    const head = s.slice(lt, lt + 9);
    if (head.startsWith('<!--')) throw new SamlRefusal('comment');
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
      rawAttrs[a[1]] = decodeText(v);
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
    const el: XmlEl = { ns: resolve(scope, prefix), local, qname, attrs, children: [], text: '' };
    if (++count > limits.maxElements) throw new SamlRefusal('too-large', 'elements');
    if (stack.length) { el.parent = stack[stack.length - 1].el; el.parent.children.push(el); } else root = el;
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

/** The operator's wallet says: this IdP signs with this certificate (sha256 of its DER), until expiresAt. */
export interface IdpPin { v: 1; idpEntityId: string; certSha256: string; expiresAt: string; signerKey: string; signature: string }

const pinText = (p: Omit<IdpPin, 'signature'>) => canonicalJson({ v: p.v, kind: 'cappz.saml.idp-pin', idpEntityId: p.idpEntityId, certSha256: p.certSha256.toLowerCase(), expiresAt: p.expiresAt, signerKey: p.signerKey });

export async function declareIdpPin(p: { idpEntityId: string; certificate: string; expiresAt: string }, key: SigningKey): Promise<IdpPin> {
  const unsigned = { v: 1 as const, idpEntityId: p.idpEntityId, certSha256: await certificateSha256(p.certificate), expiresAt: p.expiresAt, signerKey: key.publicKeyHex };
  return { ...unsigned, signature: await signCanonical(pinText(unsigned), key) };
}

/** sha256 of a certificate's DER, from PEM or bare base64 (as in ds:X509Certificate). */
export async function certificateSha256(pemOrBase64: string): Promise<string> {
  const b64 = pemOrBase64.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  return toHex(await sha256(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
}

/** Pins that verify against a trusted operator key and have not expired. */
export async function acceptedPins(pins: readonly IdpPin[], trustedSignerKeys: readonly string[], now = Date.now()): Promise<{ accepted: IdpPin[]; refused: Array<{ pin: IdpPin; because: string }> }> {
  const accepted: IdpPin[] = []; const refused: Array<{ pin: IdpPin; because: string }> = [];
  for (const pin of pins) {
    if (!trustedSignerKeys.includes(pin.signerKey)) { refused.push({ pin, because: 'signer not trusted' }); continue; }
    if (!(Date.parse(pin.expiresAt) > now)) { refused.push({ pin, because: 'expired' }); continue; }
    const { signature, ...unsigned } = pin;
    if (!(await verifyCanonical(pinText(unsigned), signature, pin.signerKey).catch(() => false))) { refused.push({ pin, because: 'bad signature' }); continue; }
    accepted.push(pin);
  }
  return { accepted, refused };
}

// ─── The check ────────────────────────────────────────────────────

export type SamlReason =
  | 'malformed-xml' | 'too-large' | 'doctype' | 'entity' | 'comment' | 'cdata' | 'processing-instruction' | 'duplicate-attribute' | 'namespace'
  | 'not-a-response' | 'status-not-success' | 'assertion-count' | 'assertion-misplaced' | 'duplicate-id' | 'missing-id'
  | 'unsigned' | 'signature-misplaced' | 'reference-mismatch' | 'transform' | 'weak-algorithm' | 'unpinned-certificate' | 'bad-signature'
  | 'issuer' | 'destination' | 'recipient' | 'audience' | 'subject' | 'conditions' | 'not-yet-valid' | 'expired' | 'stale' | 'lifetime-too-long'
  | 'in-response-to' | 'unsolicited' | 'unknown-request' | 'replayed' | 'replay-cache-full' | 'encrypted-refused' | 'no-saml-response';

/** Reasons that mean the response was wrong or hostile, not that the guard is misconfigured. */
export const SAML_ATTACK_REASONS: readonly SamlReason[] = [
  'doctype', 'entity', 'comment', 'cdata', 'processing-instruction', 'duplicate-attribute', 'namespace', 'assertion-count', 'assertion-misplaced',
  'duplicate-id', 'unsigned', 'signature-misplaced', 'reference-mismatch', 'transform', 'weak-algorithm', 'bad-signature',
  'expired', 'stale', 'lifetime-too-long', 'in-response-to', 'unknown-request', 'replayed',
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
  /** Refuse a response whose signature embeds no certificate (default false: the SP's configured certificate is used). */
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
  /** Optional cryptographic signature check (e.g. a vetted XML-DSig library). Without it, the SP's own check is relied on. */
  verifySignature?: (xml: string, signed: { element: 'Response' | 'Assertion'; id: string; certificate?: string }) => Promise<boolean>;
  /** Salt for subject hashes in verdicts and reports (no NameID leaves the guard). */
  subjectSalt?: string;
  maxReplayEntries?: number;
  limits?: XmlLimits;
}

export interface SamlVerdict {
  allowed: boolean;
  reason?: SamlReason;
  detail?: string;
  assertion: 'plain' | 'encrypted' | 'unknown';
  signature: 'verified' | 'left-to-sp' | 'bad-signature' | 'not-checked';
  solicited: 'matched' | 'unsolicited' | 'unknown-request' | 'not-checked';
  certificate: 'pinned' | 'not-embedded' | 'unpinned' | 'not-checked';
  assertionId?: string;
  inResponseTo?: string;
  subjectHash?: string;
  notOnOrAfter?: string;
}

interface Store { outstanding: Map<string, number>; seen: Map<string, number> }

const time = (v: string | undefined, reason: SamlReason): number | undefined => {
  if (v === undefined) return undefined;
  const t = Date.parse(v);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v) || !Number.isFinite(t)) throw new SamlRefusal(reason, `time ${v}`);
  return t;
};

export function createSamlChecker(cfg: SamlGuardConfig, store: Store = { outstanding: new Map(), seen: new Map() }) {
  const skew = (cfg.clockSkewSec ?? 120) * 1000;
  const maxLife = (cfg.maxLifetimeSec ?? 600) * 1000;
  const maxAge = (cfg.maxAgeSec ?? 300) * 1000;
  const maxReplay = cfg.maxReplayEntries ?? 500_000;
  let pinCache: { at: number; shas: Set<string> } | null = null;

  async function pinnedShas(now: number): Promise<Set<string>> {
    if (pinCache && now - pinCache.at < 60_000) return pinCache.shas;
    const { accepted } = await acceptedPins((cfg.pins ?? []).filter((p) => p.idpEntityId === cfg.idpEntityId), cfg.trustedPinSigners ?? [], now);
    pinCache = { at: now, shas: new Set(accepted.map((p) => p.certSha256.toLowerCase())) };
    return pinCache.shas;
  }

  function sweep(now: number) {
    for (const [k, exp] of store.seen) if (exp < now) store.seen.delete(k);
    for (const [k, at] of store.outstanding) if (now - at > 15 * 60_000) store.outstanding.delete(k);
  }

  /** Record an AuthnRequest ID this SP sent (the guard sees it on the SP's redirect). */
  function expectRequest(id: string, now = Date.now()) { if (/^[A-Za-z_][\w.-]{0,255}$/.test(id)) { if (store.outstanding.size > 100_000) sweep(now); store.outstanding.set(id, now); } }

  async function check(xml: string, now = Date.now()): Promise<SamlVerdict> {
    const v: SamlVerdict = { allowed: false, assertion: 'unknown', signature: 'not-checked', solicited: 'not-checked', certificate: 'not-checked' };
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
    const responseId = root.attrs.ID; if (!responseId) throw new SamlRefusal('missing-id', 'Response');

    const status = one(root, SAML_NS.protocol, 'Status', 'status-not-success')!;
    const code = one(status, SAML_NS.protocol, 'StatusCode', 'status-not-success')!;
    if (code.attrs.Value !== SUCCESS) throw new SamlRefusal('status-not-success', code.attrs.Value);

    const rIssuer = one(root, SAML_NS.assertion, 'Issuer', 'issuer', true);
    if (rIssuer && leafText(rIssuer, 'issuer') !== cfg.idpEntityId) throw new SamlRefusal('issuer', 'Response');
    if (!root.attrs.Destination || !cfg.acsUrls.includes(root.attrs.Destination)) throw new SamlRefusal('destination', root.attrs.Destination ?? 'missing');
    const issued = time(root.attrs.IssueInstant, 'stale');
    if (issued === undefined || issued > now + skew || now - issued > maxAge + skew) throw new SamlRefusal('stale', root.attrs.IssueInstant);

    // Solicited: InResponseTo names a request this SP sent and has not used yet.
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

    if (embedded.length) {
      const pins = await pinnedShas(now);
      for (const c of embedded) if (!pins.has(await certificateSha256(c).catch(() => ''))) { v.certificate = 'unpinned'; throw new SamlRefusal('unpinned-certificate'); }
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

  return { check, expectRequest, store };
}

// ─── Bindings ─────────────────────────────────────────────────────

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
export function decodeSamlResponse(b64: string): string | null {
  const s = b64.replace(/[\r\n ]/g, '');
  if (!s || s.length % 4 !== 0 || !B64.test(s)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))); } catch { return null; }
}

/** The ID of an AuthnRequest in an HTTP-Redirect binding URL (SAMLRequest = base64(deflate-raw(xml))). */
export function authnRequestIdFromUrl(url: string): string | null {
  try {
    const q = new URL(url).searchParams.get('SAMLRequest');
    if (!q) return null;
    const xml = new TextDecoder().decode(inflateSync(Uint8Array.from(atob(q), (c) => c.charCodeAt(0))));
    const root = parseStrictXml(xml, { maxBytes: 64 * 1024, maxDepth: 16, maxElements: 200 });
    return root.ns === SAML_NS.protocol && root.local === 'AuthnRequest' && root.attrs.ID ? root.attrs.ID : null;
  } catch { return null; }
}

/** The SP's own verdict on a POST to its ACS: X-Legacy-Verdict if it sets one; else 4xx/5xx deny, a session cookie allow. */
export function spVerdict(res: Response, header = 'x-legacy-verdict'): LegacyVerdict {
  const h = res.headers.get(header)?.trim().toLowerCase();
  if (h === 'allow' || h === 'deny') return h;
  if (res.status >= 400) return 'deny';
  if (res.headers.get('set-cookie')) return 'allow';
  return 'missing';
}

// ─── The guard in front of an ACS ─────────────────────────────────

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'host', 'content-length', 'expect'];
const VERDICT_HEADERS = ['cappz-saml-verdict', 'cappz-saml-subject-hash', 'cappz-saml-assertion', 'cappz-saml-signature'];

export interface SamlGatePolicy { minResponses: number; minDays: number; /** Refusals the SP also accepted that need no explanation (hostile by construction). */ acceptedStricterReasons: readonly string[] }
export const DEFAULT_SAML_GATE: SamlGatePolicy = { minResponses: 500, minDays: 7, acceptedStricterReasons: SAML_ATTACK_REASONS };

export interface SamlGuardOptions {
  config: SamlGuardConfig;
  /** 'shadow': the SP stays authoritative and the guard records; 'enforce': refused responses never reach the SP. */
  mode: 'shadow' | 'enforce';
  /** The SP: base URL or a fetch function. */
  upstream: string | ((req: Request) => Promise<Response>);
  /** ACS paths on this host (default: the paths of config.acsUrls). */
  acsPaths?: readonly string[];
  gate?: SamlGatePolicy;
  shadowState?: ShadowState;
  cost?: CostAssumptions;
  /** Called for every checked response (audit log, TX writer): verdicts carry hashes, never the NameID. */
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

export function createSamlGuard(o: SamlGuardOptions) {
  const now = o.now ?? Date.now;
  const checker = createSamlChecker(o.config);
  const gate = o.gate ?? DEFAULT_SAML_GATE;
  const compare = createShadowComparison({ state: o.shadowState, now, policy: { minRequests: gate.minResponses, minDays: gate.minDays, acceptedStricterReasons: gate.acceptedStricterReasons, minDenials: 0 } });
  const acsPaths = new Set(o.acsPaths ?? o.config.acsUrls.map((u) => new URL(u).pathname));
  const maxBody = o.maxBodyBytes ?? 512 * 1024;
  const fetchUp = typeof o.upstream === 'function' ? o.upstream : (r: Request) => fetch(r);

  function forwardRequest(req: Request, body: Uint8Array | null, extra: Record<string, string> = {}): Request {
    const url = new URL(req.url);
    const target = typeof o.upstream === 'string' ? new URL(url.pathname + url.search, o.upstream).toString() : req.url;
    const h = new Headers();
    req.headers.forEach((v, k) => { if (!HOP_BY_HOP.includes(k) && !VERDICT_HEADERS.includes(k)) h.set(k, v); });
    for (const [k, v] of Object.entries(extra)) h.set(k, v);
    return new Request(target, { method: req.method, headers: h, body: body && body.length && req.method !== 'GET' && req.method !== 'HEAD' ? buf(body) : undefined, redirect: 'manual' });
  }

  /** Learn AuthnRequest IDs from the SP's redirects to the IdP, so InResponseTo can be matched. */
  function learn(res: Response) {
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) { const id = authnRequestIdFromUrl(loc); if (id) checker.expectRequest(id, now()); }
    return res;
  }

  async function report(): Promise<SamlGateReport> {
    const r = await compare.report(o.cost ?? { instanceUsdPerHour: 0, vcpus: 1, label: 'not priced' });
    const s = compare.state();
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

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/cappz/saml/report') return Response.json(await report());
    if (req.method !== 'POST' || !acsPaths.has(url.pathname)) {
      const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBounded(req, maxBody);
      if (body === null && req.method !== 'GET' && req.method !== 'HEAD') return new Response('request too large', { status: 413 });
      return learn(await fetchUp(forwardRequest(req, body)));
    }
    const body = await readBounded(req, maxBody);
    if (body === null) return new Response('request too large', { status: 413 });
    const started = performance.now();
    const form = new URLSearchParams(new TextDecoder().decode(body));
    const raw = form.getAll('SAMLResponse');
    const xml = raw.length === 1 ? decodeSamlResponse(raw[0]) : null;
    const v: SamlVerdict = xml === null
      ? { allowed: false, reason: raw.length > 1 ? 'assertion-count' : 'no-saml-response', detail: raw.length > 1 ? 'two SAMLResponse fields' : undefined, assertion: 'unknown', signature: 'not-checked', solicited: 'not-checked', certificate: 'not-checked' }
      : await checker.check(xml, now());
    const guardMs = performance.now() - started;
    const at = new Date(now()).toISOString();
    const headers: Record<string, string> = { 'cappz-saml-verdict': v.allowed ? 'pass' : `refuse; reason=${v.reason}`, 'cappz-saml-assertion': v.assertion, 'cappz-saml-signature': v.signature };
    if (v.subjectHash) headers['cappz-saml-subject-hash'] = v.subjectHash;

    if (o.mode === 'enforce') {
      await o.onVerdict?.({ ...v, mode: 'enforce', at });
      if (!v.allowed) return Response.json({ error: 'SAML response refused', reason: v.reason }, { status: 403, headers: { 'cappz-saml-verdict': headers['cappz-saml-verdict'] } });
      return learn(await fetchUp(forwardRequest(req, body, headers)));
    }
    // Shadow: the SP decides; the guard records what it would have done.
    const res = await fetchUp(forwardRequest(req, body));
    const sp = spVerdict(res);
    compare.record({ cappz: { allowed: v.allowed, reason: v.reason ?? 'pass' }, cappzMs: guardMs, legacy: sp, path: url.pathname });
    await o.onVerdict?.({ ...v, mode: 'shadow', sp, at });
    return learn(res);
  }

  return { handle, report, check: checker.check, expectRequest: checker.expectRequest, state: compare.state };
}
