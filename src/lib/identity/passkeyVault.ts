/**
 * COPE node crystallized.
 * Node ID: v15-16-00-passkey-vault
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Wallet keys wrapped by a passkey. The WebAuthn PRF extension asks the
 * authenticator — Secure Enclave, Android TEE / StrongBox, Windows TPM — to
 * compute an HMAC with a secret that never leaves it, after user verification.
 * That output, through HKDF, becomes an AES-256-GCM key (non-extractable)
 * that encrypts the wallet key. Only the ciphertext and a random salt are
 * stored; the wrapping key exists for the length of one call. No server holds
 * anything that decrypts it, and a copied database is useless without the
 * authenticator and the person's fingerprint, face or PIN.
 *
 * The same passkey can sign notarization receipts: enrolment returns its
 * P-256 public key for a KeyZ 'signing' declaration.
 */
import { decodeCbor } from './cbor';
import { buf, fromBase64Url, toBase64Url, utf8 } from './canonical';
import { coseKeyToP256, parseAuthenticatorData, type WebAuthnPort } from './webauthn';

export const PASSKEY_VAULT_LABEL = 'cappz.passkey-vault.v1';

export interface PasskeyWrap {
  v: 1;
  kind: 'passkey-prf';
  credentialId: string;   // base64url
  rpId: string;
  prfSalt: string;        // base64url, 32 random bytes
  iv: string;             // base64url, 12 random bytes
  ciphertext: string;     // base64url, AES-256-GCM
  /** What the ciphertext is bound to (associated data), e.g. the wallet address. */
  context: string;
  createdAt: string;
}

export interface PasskeyEnrolment {
  credentialId: string;
  rpId: string;
  /** SEC1 P-256 public key (hex), for a KeyZ 'signing' declaration. */
  publicKey: string;
  /** The authenticator reported PRF support; without it no wrap can be made. */
  prfSupported: boolean;
  /** The attestation object as returned (base64url), for webauthnAttestation checks. */
  attestationObject: string;
  clientDataJSON: string;
  /** The challenge this registration answered (base64url): pass it to verifyRegistration. */
  challenge: string;
}

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: BufferSource } } };

/** Create a platform passkey with the PRF extension, user verification required. */
export async function enrolPasskey(
  webauthn: WebAuthnPort,
  o: { rpId: string; rpName: string; userId: Uint8Array; userName: string; displayName?: string; attestation?: AttestationConveyancePreference; excludeCredentialIds?: string[] },
): Promise<PasskeyEnrolment> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const cred = await webauthn.create({
    challenge: challenge as BufferSource,
    rp: { id: o.rpId, name: o.rpName },
    user: { id: o.userId as BufferSource, name: o.userName, displayName: o.displayName ?? o.userName },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'required' },
    attestation: o.attestation ?? 'none',
    excludeCredentials: (o.excludeCredentialIds ?? []).map((id) => ({ type: 'public-key' as const, id: fromBase64Url(id) as BufferSource })),
    extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    timeout: 60_000,
  });
  if (!cred) throw new Error('passkey: enrolment was cancelled');
  const res = cred.response as AuthenticatorAttestationResponse;
  const att = decodeCbor(new Uint8Array(res.attestationObject));
  const authData = att instanceof Map ? att.get('authData') : undefined;
  if (!(authData instanceof Uint8Array)) throw new Error('passkey: attestation object has no authenticator data');
  const parsed = parseAuthenticatorData(authData);
  if (!parsed.credential) throw new Error('passkey: no credential in authenticator data');
  return {
    credentialId: toBase64Url(new Uint8Array(cred.rawId)),
    rpId: o.rpId,
    publicKey: coseKeyToP256(parsed.credential.publicKey),
    prfSupported: (cred.getClientExtensionResults() as PrfResults).prf?.enabled === true,
    attestationObject: toBase64Url(new Uint8Array(res.attestationObject)),
    clientDataJSON: toBase64Url(new Uint8Array(res.clientDataJSON)),
    challenge: toBase64Url(challenge),
  };
}

async function wrappingKey(prfOutput: Uint8Array, prfSalt: Uint8Array, credentialId: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', buf(prfOutput), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(prfSalt), info: buf(utf8(`${PASSKEY_VAULT_LABEL}|${credentialId}`)) },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}
const aad = (w: { credentialId: string; context: string }) => buf(utf8(`${PASSKEY_VAULT_LABEL}|${w.credentialId}|${w.context}`));

/** One user-verified PRF evaluation per credential, in a single prompt. */
async function prf(webauthn: WebAuthnPort, rpId: string, salts: Map<string, Uint8Array>): Promise<{ credentialId: string; output: Uint8Array }> {
  const ids = [...salts.keys()];
  const extensions = ids.length === 1
    ? { prf: { eval: { first: salts.get(ids[0]) } } }
    : { prf: { evalByCredential: Object.fromEntries(ids.map((id) => [id, { first: salts.get(id) }])) } };
  const cred = await webauthn.get({
    challenge: crypto.getRandomValues(new Uint8Array(32)) as BufferSource,
    rpId,
    allowCredentials: ids.map((id) => ({ type: 'public-key' as const, id: fromBase64Url(id) as BufferSource })),
    userVerification: 'required',
    extensions: extensions as AuthenticationExtensionsClientInputs,
    timeout: 60_000,
  });
  if (!cred) throw new Error('passkey: unlock was cancelled');
  const first = (cred.getClientExtensionResults() as PrfResults).prf?.results?.first;
  if (!first) throw new Error('passkey: this authenticator or browser does not support the PRF extension');
  const output = first instanceof ArrayBuffer ? new Uint8Array(first) : new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  if (output.length < 32) throw new Error('passkey: PRF output too short');
  return { credentialId: toBase64Url(new Uint8Array(cred.rawId)), output: output.slice() };
}

/** Encrypt `secret` under a passkey. `context` (e.g. the wallet address) is bound as associated data. */
export async function wrapWithPasskey(secret: Uint8Array, passkey: { credentialId: string; rpId: string }, context: string, webauthn: WebAuthnPort, now = new Date()): Promise<PasskeyWrap> {
  const prfSalt = crypto.getRandomValues(new Uint8Array(32));
  const { output } = await prf(webauthn, passkey.rpId, new Map([[passkey.credentialId, prfSalt]]));
  try {
    const key = await wrappingKey(output, prfSalt, passkey.credentialId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const w = { credentialId: passkey.credentialId, context };
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: aad(w) }, key, buf(secret)));
    return { v: 1, kind: 'passkey-prf', credentialId: passkey.credentialId, rpId: passkey.rpId, prfSalt: toBase64Url(prfSalt), iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext), context, createdAt: now.toISOString() };
  } finally {
    output.fill(0);
  }
}

/**
 * Decrypt with whichever of the wraps' passkeys the person uses (one prompt).
 * Returns null when the authenticator answered but the ciphertext does not
 * open (tampered record or a different passkey); throws when no passkey was
 * used or PRF is unsupported.
 */
export async function unwrapWithPasskey(wraps: readonly PasskeyWrap[], webauthn: WebAuthnPort): Promise<{ secret: Uint8Array; credentialId: string } | null> {
  const usable = wraps.filter((w) => w.v === 1 && w.kind === 'passkey-prf');
  if (!usable.length) throw new Error('passkey: no passkey wraps to unlock');
  const rpId = usable[0].rpId;
  if (usable.some((w) => w.rpId !== rpId)) throw new Error('passkey: wraps from different relying parties');
  const salts = new Map(usable.map((w) => [w.credentialId, fromBase64Url(w.prfSalt)]));
  const { credentialId, output } = await prf(webauthn, rpId, salts);
  const w = usable.find((x) => x.credentialId === credentialId);
  try {
    if (!w) return null;
    const key = await wrappingKey(output, salts.get(credentialId)!, credentialId);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(fromBase64Url(w.iv)), additionalData: aad(w) }, key, buf(fromBase64Url(w.ciphertext)));
    return { secret: new Uint8Array(plain), credentialId };
  } catch {
    return null;
  } finally {
    output.fill(0);
  }
}
