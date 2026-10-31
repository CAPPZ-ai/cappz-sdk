/**
 * COPE node crystallized.
 * Node ID: v15-16-00-notary-device-signature
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * A notarization receipt proves which wallet anchored a leaf. A device
 * signature adds which enrolled device — and, with a passkey, that a person
 * unlocked it — by signing the receipt's statement with a P-256 key that
 * stays in hardware:
 *
 *   webauthn-es256  a passkey (Secure Enclave, Android TEE / StrongBox,
 *                   Windows TPM) signs through WebAuthn; the statement hash is
 *                   the challenge, so the assertion is bound to this receipt
 *   p256            any other P-256 key that signs the statement directly: a
 *                   native shell's Secure Enclave / StrongBox key, or a
 *                   non-extractable WebCrypto key (software, not hardware)
 *
 * The wallet vouches for the device key with a KeyZ declaration (purpose
 * 'signing', algorithm 'p256'), so verification is offline: the signature,
 * then evaluateKey for the declaring wallet. Revoked, expired and undeclared
 * keys are different answers, never a bare false.
 */
import { canonicalJson, sha256, toBase64Url, utf8 } from '../identity/canonical';
import { evaluateKey, type KeyEvidence, type KeyTrust } from '../identity/keyDeclaration';
import { fromBase64Url, p256Uncompressed, verifyEs256, verifyWebAuthnAssertion, type AssertionCheck, type WebAuthnPort } from '../identity/webauthn';

/**
 * What a device signs. One receipt: its leaf (with salt; batch receipts add
 * root and index). A whole batch, signed once: no leaf, the anchored root and
 * count — each file's receipt then proves inclusion under that root.
 */
export interface NotaryStatementInput {
  leaf?: string;
  salt?: string;
  anchor_account: string;
  timestamp_utc: string;
  root?: string;
  index?: number;
  count?: number;
}

export function notaryStatement(r: NotaryStatementInput): string {
  if (!r.leaf) {
    if (!r.root || !Number.isSafeInteger(r.count)) throw new Error('device statement: a batch statement needs root and count');
    return canonicalJson({ kind: 'cappz.notary.device-batch-statement', v: 1, root: r.root.toUpperCase(), count: r.count, anchor_account: r.anchor_account, timestamp_utc: r.timestamp_utc });
  }
  return canonicalJson({
    kind: 'cappz.notary.device-statement', v: 1,
    leaf: r.leaf.toUpperCase(), salt: r.salt ?? null, anchor_account: r.anchor_account, timestamp_utc: r.timestamp_utc,
    ...(r.root ? { root: r.root.toUpperCase(), index: r.index ?? null } : {}),
  });
}

interface SignatureBase { walletAddress: string; publicKey: string; signedAt: string }
export type NotaryDeviceSignature =
  | (SignatureBase & { scheme: 'p256'; signature: string /* base64url r||s */ })
  | (SignatureBase & { scheme: 'webauthn-es256'; credentialId: string; rpId: string; authenticatorData: string; clientDataJSON: string; signature: string /* base64url DER */ });

/** Sign with a P-256 key that signs bytes directly (WebCrypto CryptoKey, or a native shell's key). */
export async function signNotaryStatement(
  r: NotaryStatementInput,
  key: { walletAddress: string; publicKey: string; sign(message: Uint8Array): Promise<Uint8Array> },
  now = new Date(),
): Promise<NotaryDeviceSignature> {
  const raw = await key.sign(utf8(notaryStatement(r)));
  if (raw.length !== 64) throw new Error('device signature: expected a 64-byte r||s ES256 signature');
  return { scheme: 'p256', walletAddress: key.walletAddress, publicKey: key.publicKey.toLowerCase(), signedAt: now.toISOString(), signature: toBase64Url(raw) };
}

/** A non-extractable WebCrypto P-256 key as a signer (software-protected; prefer a passkey for hardware). */
export function webCryptoSigner(privateKey: CryptoKey): (message: Uint8Array) => Promise<Uint8Array> {
  return async (message) => new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, message as BufferSource));
}

/** Sign with a passkey: the authenticator signs over the statement hash, after user verification. */
export async function signNotaryStatementWithPasskey(
  r: NotaryStatementInput,
  passkey: { walletAddress: string; publicKey: string; credentialId: string; rpId: string },
  webauthn: WebAuthnPort,
  now = new Date(),
): Promise<NotaryDeviceSignature> {
  const challenge = await sha256(utf8(notaryStatement(r)));
  const cred = await webauthn.get({
    challenge: challenge as BufferSource,
    rpId: passkey.rpId,
    allowCredentials: [{ type: 'public-key', id: fromBase64Url(passkey.credentialId) as BufferSource }],
    userVerification: 'required',
    timeout: 60_000,
  });
  if (!cred) throw new Error('device signature: no passkey assertion');
  const res = cred.response as AuthenticatorAssertionResponse;
  return {
    scheme: 'webauthn-es256', walletAddress: passkey.walletAddress, publicKey: passkey.publicKey.toLowerCase(), signedAt: now.toISOString(),
    credentialId: toBase64Url(new Uint8Array(cred.rawId)), rpId: passkey.rpId,
    authenticatorData: toBase64Url(new Uint8Array(res.authenticatorData)),
    clientDataJSON: toBase64Url(new Uint8Array(res.clientDataJSON)),
    signature: toBase64Url(new Uint8Array(res.signature)),
  };
}

/** The compressed and uncompressed hex encodings of a P-256 point. */
function p256Forms(publicKeyHex: string): string[] {
  const full = p256Uncompressed(publicKeyHex);
  const compressed = new Uint8Array(33);
  compressed[0] = 0x02 | (full[64] & 1);
  compressed.set(full.subarray(1, 33), 1);
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return [hex(full), hex(compressed)].filter((f) => f !== publicKeyHex.toLowerCase());
}

export type DeviceSignatureState =
  | 'trusted'          // signature valid and the key is declared (or delegated) by the wallet for signing
  | 'untrusted-key'    // signature valid, but the wallet has not declared this key for signing (see keyTrust)
  | 'bad-signature'
  | AssertionCheck     // passkey-specific failures (wrong origin, challenge, user not verified, …)
  | 'malformed';

export interface DeviceSignatureCheck {
  state: DeviceSignatureState;
  /** The passkey reported user verification (biometric / PIN). */
  userVerified?: boolean;
  keyTrust?: KeyTrust;
}

/**
 * Check a device signature on a receipt. `origins` lists the web origins a
 * passkey assertion may come from (e.g. ['https://cappz.ai']).
 */
export async function verifyNotaryDeviceSignature(
  r: NotaryStatementInput,
  sig: NotaryDeviceSignature,
  o: { evidence: KeyEvidence; origins?: readonly string[]; now?: number },
): Promise<DeviceSignatureCheck> {
  let statement: Uint8Array;
  try { p256Uncompressed(sig.publicKey); statement = utf8(notaryStatement(r)); } catch { return { state: 'malformed' }; }
  let userVerified: boolean | undefined;
  if (sig.scheme === 'p256') {
    let raw: Uint8Array;
    try { raw = fromBase64Url(sig.signature); } catch { return { state: 'malformed' }; }
    if (raw.length !== 64) return { state: 'malformed' };
    if (!(await verifyEs256(sig.publicKey, statement, raw))) return { state: 'bad-signature' };
  } else if (sig.scheme === 'webauthn-es256') {
    const a = await verifyWebAuthnAssertion(sig, {
      publicKey: sig.publicKey, challenge: await sha256(statement), rpId: sig.rpId, origins: o.origins ?? [`https://${sig.rpId}`],
    });
    if (a.check !== 'valid') return { state: a.check, userVerified: a.userVerified };
    userVerified = a.userVerified;
  } else {
    return { state: 'malformed' };
  }
  // A declaration may name the point compressed or uncompressed: either names this key.
  let keyTrust = await evaluateKey(sig.walletAddress, sig.publicKey, 'signing', o.evidence, o.now);
  for (const form of p256Forms(sig.publicKey)) {
    if (keyTrust.state !== 'undeclared') break;
    keyTrust = await evaluateKey(sig.walletAddress, form, 'signing', o.evidence, o.now);
  }
  const declared = keyTrust.state === 'declared' || keyTrust.state === 'delegated';
  return { state: declared ? 'trusted' : 'untrusted-key', userVerified, keyTrust };
}
