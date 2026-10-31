import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decodeCbor, type CborValue } from '../lib/identity/cbor';
import { inspectCertificate } from '../lib/identity/x509Chain';
import { verifyRegistration, APPLE_WEBAUTHN_ROOTS, GOOGLE_HARDWARE_ATTESTATION_ROOTS, type RegistrationExpectations } from '../lib/identity/webauthnAttestation';
import { enrolPasskey } from '../lib/identity/passkeyVault';
import { SoftAuthenticator, encodeCbor } from './helpers/softAuthenticator';

interface Case { source: string; name: string; attestationObject: string; clientDataJSON: string; challenge: string; origin: string; rpId: string; expectVerified: boolean }
const fixtures = JSON.parse(readFileSync(path.resolve(__dirname, 'fixtures/webauthn-attestations.json'), 'utf8')) as { cases: Case[] };
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));
const pinned = new Set([...APPLE_WEBAUTHN_ROOTS, ...GOOGLE_HARDWARE_ATTESTATION_ROOTS].map((r) => r.sha256));

/** A moment inside every certificate's validity: the latest notBefore plus a minute. */
async function momentFor(c: Case): Promise<Date> {
  const att = decodeCbor(b64(c.attestationObject)) as Map<string, CborValue>;
  const x5c = (att.get('attStmt') as Map<string, CborValue>).get('x5c') as Uint8Array[] | undefined;
  if (!x5c) return new Date();
  const certs = await Promise.all(x5c.map((d) => inspectCertificate(d)));
  return new Date(Math.max(...certs.map((x) => x.notBefore.getTime())) + 60_000);
}
const expectations = async (c: Case): Promise<RegistrationExpectations> => ({ challenge: b64(c.challenge), rpId: c.rpId, origins: [c.origin], requireUserVerification: false, now: await momentFor(c) });

/** Re-encode the attestation object with a change applied. */
function reencode(c: Case, change: (att: Map<CborValue, CborValue>) => void): string {
  const att = decodeCbor(b64(c.attestationObject)) as Map<CborValue, CborValue>;
  change(att);
  return Buffer.from(encodeCbor(att as never)).toString('base64url');
}

describe('v15-16-00 WebAuthn attestation on captured registrations', () => {
  for (const c of fixtures.cases) {
    it(`${c.source.replace('verifyAttestation', '').replace('.test.ts', '')}: ${c.name}`, async () => {
      const r = await verifyRegistration(c, await expectations(c));
      const fmt = (decodeCbor(b64(c.attestationObject)) as Map<string, CborValue>).get('fmt');
      expect(r.format).toBe(fmt);
      if (!c.expectVerified) {
        // The capture SimpleWebAuthn rejects (unknown root): never anchored here either.
        expect(r.trust).not.toBe('chain');
        return;
      }
      expect(r.check, r.because).toBe('valid');
      if (fmt === 'apple' || fmt === 'android-key') {
        expect(r.trust, r.because).toBe('chain');
        expect(pinned.has(r.anchor!)).toBe(true);
      } else {
        // TPM and packed roots are not shipped: consistent, signed, but unanchored.
        expect(r.trust, r.because).toBe('unanchored');
      }
      if (fmt === 'android-key') expect(['tee', 'strongbox']).toContain(r.securityLevel);
    });
  }

  it('every format refuses a different challenge, a flipped signature, and altered authenticator data', async () => {
    for (const c of fixtures.cases.filter((x) => x.expectVerified)) {
      const e = await expectations(c);
      expect((await verifyRegistration(c, { ...e, challenge: new Uint8Array(32) })).check).toBe('wrong-challenge');
      expect((await verifyRegistration(c, { ...e, origins: ['https://evil.example'] })).check).toBe('wrong-origin');
      const fmt = (decodeCbor(b64(c.attestationObject)) as Map<string, CborValue>).get('fmt');
      if (fmt !== 'apple') {
        const flipped = reencode(c, (att) => { const st = att.get('attStmt') as Map<CborValue, CborValue>; const s = (st.get('sig') as Uint8Array).slice(); s[s.length - 5] ^= 1; st.set('sig', s); });
        expect((await verifyRegistration({ ...c, attestationObject: flipped }, e)).check, `${c.name} sig`).not.toBe('valid');
      }
      // Change the signature counter: the statement no longer covers this authenticator data.
      const altered = reencode(c, (att) => { const a = (att.get('authData') as Uint8Array).slice(); a[36] ^= 1; att.set('authData', a); });
      const r = await verifyRegistration({ ...c, attestationObject: altered }, e);
      expect(['bad-signature', 'nonce-mismatch'], `${c.name}: ${r.check} ${r.because}`).toContain(r.check);
    }
  }, 60_000);

  it('a chain is only anchored inside its validity period', async () => {
    const apple = fixtures.cases.find((c) => c.source.includes('Apple'))!;
    const r = await verifyRegistration(apple, { ...(await expectations(apple)), now: new Date('2045-06-01') });
    expect(r.trust).not.toBe('chain');
  });
});

describe('v15-16-00 attestation from the software authenticator', () => {
  const RP = 'cappz.ai';
  const user = { rpId: RP, rpName: 'CAPPZ', userId: new Uint8Array([7]), userName: 'u' };
  it("'none' is trust none; packed self attestation is trust self; both give the P-256 key for KeyZ", async () => {
    for (const [mode, trust] of [['none', 'none'], ['packed-self', 'self']] as const) {
      const auth = new SoftAuthenticator({ attestation: mode });
      const p = await enrolPasskey(auth, { ...user, attestation: 'direct' });
      const r = await verifyRegistration(p, { challenge: b64(p.challenge), rpId: RP, origins: ['https://cappz.ai'] });
      expect(r, r.because).toMatchObject({ check: 'valid', trust, publicKey: p.publicKey, userVerified: true });
    }
  });

  it('user verification is required unless the caller opts out', async () => {
    const auth = new SoftAuthenticator({ userVerified: false });
    const p = await enrolPasskey(auth, user);
    const challenge = b64(JSON.parse(Buffer.from(p.clientDataJSON, 'base64url').toString()).challenge);
    expect((await verifyRegistration(p, { challenge, rpId: RP, origins: ['https://cappz.ai'] })).check).toBe('user-not-verified');
    expect((await verifyRegistration(p, { challenge, rpId: 'other.example', origins: ['https://cappz.ai'] })).check).toBe('wrong-rp');
  });
});
