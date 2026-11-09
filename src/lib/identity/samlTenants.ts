/**
 * COPE node crystallized.
 * Node ID: v15-37-00-saml-tenants
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Onboarding and configuration checks for SAML Guard, single or multi-tenant:
 *
 *   idpFromMetadata   read an IdP's SAML metadata (what every IdP exports for an SP):
 *                     entity ID, signing certificates, SSO URLs — no retyping, no copy errors
 *   lintSamlTenants   the configuration doctor: every rule in docs/SAML_GUARD.md "Configuring it
 *                     properly" as a check with a severity and a fix; errors block enforce
 *
 * The doctor's errors are the misconfigurations behind real incidents: a tenant
 * whose login URL or SP entity is shared with another (a response for one is
 * accepted at both), a pinned certificate shared between tenants, no usable pin
 * (nothing to verify with), a pin for the wrong tenant, the signature left to an
 * SP whose check nobody has tested while enforcing.
 */

import { acceptedPins, certificateSha256, parseStrictXml, type IdpPin, type SamlTenant, type XmlEl } from './samlGuard.ts';
import { inspectCertificate } from './x509Chain.ts';

const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DSIG = 'http://www.w3.org/2000/09/xmldsig#';

export interface IdpMetadata {
  entityId: string;
  /** base64 DER of every certificate the IdP declares for signing (use="signing" or no use). */
  signingCertificates: Array<{ certificate: string; sha256: string; notAfter?: string; subject?: string }>;
  ssoUrls: Array<{ binding: string; location: string }>;
  wantAuthnRequestsSigned: boolean;
  /** Present when the metadata itself is signed (verify it out of band, or fetch it over HTTPS from the IdP). */
  signedMetadata: boolean;
}

const walk = (el: XmlEl, f: (e: XmlEl) => void) => { f(el); for (const c of el.children) walk(c, f); };

/** Read an IdP's SAML 2.0 metadata (EntityDescriptor, or an EntitiesDescriptor holding exactly one IdP). */
export async function idpFromMetadata(xml: string): Promise<IdpMetadata> {
  const root = parseStrictXml(xml, { maxBytes: 4 * 1024 * 1024, maxDepth: 64, maxElements: 50_000 }, { skipComments: true });
  const entities: XmlEl[] = [];
  walk(root, (e) => { if (e.ns === MD && e.local === 'EntityDescriptor' && e.children.some((c) => c.ns === MD && c.local === 'IDPSSODescriptor')) entities.push(e); });
  if (entities.length !== 1) throw new Error(`metadata holds ${entities.length} identity providers; export the one for this tenant`);
  const ed = entities[0];
  const idp = ed.children.find((c) => c.ns === MD && c.local === 'IDPSSODescriptor')!;
  const certs: IdpMetadata['signingCertificates'] = [];
  for (const kd of idp.children.filter((c) => c.ns === MD && c.local === 'KeyDescriptor')) {
    if (kd.attrs.use && kd.attrs.use !== 'signing') continue;
    const found: string[] = []; walk(kd, (e) => { if (e.ns === DSIG && e.local === 'X509Certificate') found.push(e.text.replace(/\s+/g, '')); });
    for (const c of found) {
      if (certs.some((x) => x.certificate === c)) continue;
      let notAfter: string | undefined;
      try { notAfter = (await inspectCertificate(Uint8Array.from(atob(c), (ch) => ch.charCodeAt(0)))).notAfter.toISOString(); } catch { /* unreadable: still pinned by hash */ }
      certs.push({ certificate: c, sha256: await certificateSha256(c), notAfter });
    }
  }
  if (!certs.length) throw new Error('metadata declares no signing certificate');
  return {
    entityId: ed.attrs.entityID,
    signingCertificates: certs,
    ssoUrls: idp.children.filter((c) => c.ns === MD && c.local === 'SingleSignOnService').map((c) => ({ binding: c.attrs.Binding, location: c.attrs.Location })),
    wantAuthnRequestsSigned: idp.attrs.WantAuthnRequestsSigned === 'true',
    signedMetadata: ed.children.some((c) => c.ns === DSIG && c.local === 'Signature') || root.children.some((c) => c.ns === DSIG && c.local === 'Signature'),
  };
}

export type LintSeverity = 'error' | 'warn' | 'info';
export interface LintFinding { severity: LintSeverity; tenant: string | '*'; code: string; message: string; fix: string }
export interface LintReport { ok: boolean; errors: number; warnings: number; findings: LintFinding[] }

/**
 * The configuration doctor. `ok` is false when any error remains: do not enforce a tenant with errors.
 * `pins` are the operator-signed pins (each tenant's own `pins` are used when omitted).
 */
export async function lintSamlTenants(tenants: readonly SamlTenant[], o: { pins?: readonly IdpPin[]; trustedPinSigners?: readonly string[]; now?: number; expiringDays?: number; multiTenant?: boolean } = {}): Promise<LintReport> {
  const now = o.now ?? Date.now();
  const soon = (o.expiringDays ?? 30) * 86400_000;
  const multi = o.multiTenant ?? tenants.length > 1;
  const f: LintFinding[] = [];
  const add = (severity: LintSeverity, tenant: string, code: string, message: string, fix: string) => f.push({ severity, tenant, code, message, fix });

  if (!tenants.length) add('error', '*', 'no-tenants', 'no tenant is configured', 'add one: saml-wizard add-tenant --id <id> --metadata <idp-metadata.xml> --acs <url> --sp-entity <id>');
  const seen = { acs: new Map<string, string>(), sp: new Map<string, string>(), idp: new Map<string, string[]>(), cert: new Map<string, string[]> () };
  for (const t of tenants) {
    const id = t.id;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) add('error', id, 'tenant-id', `tenant id "${id}" is not a short lowercase id`, 'use letters, digits, - and _ (it is used in pins, logs and paths)');
    for (const k of ['idpEntityId', 'spEntityId'] as const) if (!t[k]) add('error', id, `missing-${k}`, `${k} is empty`, k === 'idpEntityId' ? 'take it from the IdP metadata (entityID)' : 'the entity ID this SaaS registered with the customer\'s IdP for this tenant');
    if (!t.acsUrls?.length) add('error', id, 'missing-acs', 'no ACS URL', 'the URL the IdP posts this tenant\'s responses to');
    for (const u of t.acsUrls ?? []) {
      let url: URL | null = null; try { url = new URL(u); } catch { add('error', id, 'acs-url', `ACS URL ${u} is not a URL`, 'use the full https URL'); }
      if (url && url.protocol !== 'https:') add('error', id, 'acs-not-https', `ACS URL ${u} is not https`, 'assertions are bearer tokens: only accept them over TLS');
      const other = seen.acs.get(u); if (other) add('error', id, 'acs-shared', `ACS URL ${u} is also tenant ${other}'s`, 'give every tenant its own ACS URL (path or host): the URL is how the guard knows which IdP must have signed'); else seen.acs.set(u, id);
    }
    if (t.spEntityId) { const other = seen.sp.get(t.spEntityId); if (other && multi) add('error', id, 'sp-entity-shared', `SP entity ${t.spEntityId} is also tenant ${other}'s`, 'use one SP entity ID per tenant, so the audience check separates tenants'); else seen.sp.set(t.spEntityId, id); }
    if (t.idpEntityId) seen.idp.set(t.idpEntityId, [...(seen.idp.get(t.idpEntityId) ?? []), id]);

    const pins = (o.pins ?? t.pins ?? []).filter((p) => p.idpEntityId === t.idpEntityId);
    const trusted = o.trustedPinSigners ?? t.trustedPinSigners ?? [];
    if (!trusted.length) add('error', id, 'no-trusted-signer', 'no operator key is trusted to sign pins', 'list the operator\'s public key in trustedPinSigners');
    const { accepted, refused } = await acceptedPins(pins, trusted, now, multi ? id : undefined);
    for (const r of refused) add('error', id, 'pin-refused', `pin ${r.pin.certSha256.slice(0, 12)}… refused: ${r.because}`, r.because === 'expired' ? 'add a pin for the IdP\'s current certificate (saml-wizard rotate)' : r.because.startsWith('pin is for') || r.because === 'pin names no tenant' ? `re-pin for this tenant: saml-wizard add-tenant/rotate --id ${id}` : 'sign the pin with a trusted operator key');
    for (const p of (o.pins ?? []).filter((x) => multi && x.tenantId === id && x.idpEntityId !== t.idpEntityId)) add('warn', id, 'pin-other-idp', `pin ${p.certSha256.slice(0, 12)}… is for ${p.idpEntityId}, not this tenant's IdP`, 'remove it, or correct idpEntityId');
    if (!accepted.length) add('error', id, 'no-pin', 'no usable certificate pin', `pin the IdP's signing certificate: saml-wizard add-tenant --id ${id} --metadata <file>`);
    for (const p of accepted) {
      if (Date.parse(p.expiresAt) - now < soon) add('warn', id, 'pin-expiring', `pin ${p.certSha256.slice(0, 12)}… expires ${p.expiresAt}`, 'pin the IdP\'s next certificate before then (saml-wizard rotate); the old pin keeps working until it expires');
      seen.cert.set(p.certSha256, [...(seen.cert.get(p.certSha256) ?? []), id]);
    }
    const sig = t.verifySignature ? 'custom' : t.signature ?? 'builtin';
    if (sig === 'builtin' && accepted.length && !accepted.some((p) => p.certificate) && !t.requireEmbeddedCertificate) add('warn', id, 'pin-without-certificate', 'pins carry only a hash (v1): the built-in verifier needs the IdP to embed its certificate', 're-pin with saml-wizard (v2 pins carry the certificate)');
    if (sig === 'left-to-sp') add(t.mode === 'enforce' ? 'error' : 'warn', id, 'signature-left-to-sp', 'the XML signature is left to the SaaS\'s own SAML library', 'use signature: "builtin" — an SP whose signature check is broken then still refuses forged responses');
    if (t.allowUnsolicited !== false) add('warn', id, 'unsolicited-allowed', 'IdP-initiated logins are accepted (no InResponseTo to tie a response to a login attempt)', 'set allowUnsolicited: false once users start login at the SaaS (SP-initiated); keep it only for IdP app tiles you need');
    if ((t.maxLifetimeSec ?? 600) > 600) add('warn', id, 'long-lifetime', `assertions may live ${t.maxLifetimeSec} s`, 'keep maxLifetimeSec at 600 or less (IdPs issue 5 min assertions)');
    if ((t.clockSkewSec ?? 120) > 300) add('warn', id, 'large-skew', `clock skew ${t.clockSkewSec} s`, 'fix the clocks (NTP) and keep clockSkewSec at 120–300');
    if (t.encryptedAssertions !== 'refuse') add('info', id, 'encrypted-pass', 'encrypted assertions are passed to the SaaS with only the envelope checked', 'set encryptedAssertions: "refuse" if this IdP never encrypts');
    if (!t.requireSignedAssertion) add('info', id, 'assertion-signature-optional', 'a signed Response containing the assertion is enough', 'set requireSignedAssertion: true if the IdP signs assertions (Okta, Entra, ADFS do by default)');
    if (t.mode === 'enforce') add('info', id, 'mode-in-config', 'enforce is set in the configuration file', 'prefer the signed mode record (saml-wizard enforce), which cites the shadow report it was decided on');
  }
  for (const [idp, ts] of seen.idp) if (ts.length > 1) add('warn', ts.join(','), 'idp-shared', `tenants ${ts.join(', ')} trust the same IdP ${idp}`, 'only the audience and ACS checks separate them: confirm each tenant has its own SP entity and ACS URL, and that the IdP issues per-application audiences');
  for (const [sha, ts] of seen.cert) if (ts.length > 1) add('warn', ts.join(','), 'cert-shared', `tenants ${ts.join(', ')} pin the same certificate ${sha.slice(0, 12)}…`, 'a key that signs for one tenant signs for all of them; normal for one IdP shared on purpose, a red flag otherwise');
  const errors = f.filter((x) => x.severity === 'error').length;
  return { ok: errors === 0, errors, warnings: f.filter((x) => x.severity === 'warn').length, findings: f };
}
