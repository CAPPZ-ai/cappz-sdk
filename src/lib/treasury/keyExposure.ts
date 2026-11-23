/**
 * COPE node crystallized.
 * Node ID: v16-02-00-key-exposure
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Key exposure on the XRP Ledger, and the two moves that shrink it: rotation and quickSweep.
 *
 * An XRPL address is a hash of a public key. The public key itself appears on the ledger only when the key
 * signs a transaction (SigningPubKey, or a Signers entry); receiving money reveals nothing. Shor's algorithm
 * recovers a secp256k1 or Ed25519 private key from its public key, so once quantum computers can run it, an
 * exposed key that can still sign is the attack surface, and a key whose public key was never published is not
 * (the attacker would have to invert the hash first). This module reads that from the ledger:
 *
 * - `keyExposure`: per account, a lifecycle state for the master key and the current regular key (never
 *   exposed, exposed since when, exposed but disabled, unknown because the history read was incomplete), the
 *   multi-signers seen, and an overall posture. Unknown is never reported as safe.
 * - `rotationTransaction` + `regularKeyFor`: move signing to a fresh regular key (SetRegularKey; the address,
 *   balances and trust lines stay). Regular keys come from a private root secret by HMAC (hardened: breaking
 *   one regular key reveals neither the root nor its siblings), one index per rotation.
 * - `quickSweepTransaction`: move what is above a working buffer to a vault address whose key has never signed.
 *   It refuses a vault whose exposure is not 'never-signed', so a sweep never lands somewhere already exposed.
 *
 * Trust boundaries: this shortens how long an exposed key can be attacked and keeps reserves behind keys that
 * were never published; it does not make the ledger's signatures post-quantum (that needs a ledger amendment).
 * The report says which. Transactions are returned unsigned for the owner's own signer.
 */
import { Wallet, deriveAddress, isValidClassicAddress, type ECDSA } from 'xrpl';
import { canonicalJson, sha256HexOf } from '../identity/canonical.ts';
import type { SignerSetup, ValidatedTx } from './vaultGuard.ts';

const LSF_DISABLE_MASTER = 0x00100000;
const DAY = 86_400_000;

export type MasterKeyState =
  | 'never-signed'        // no transaction in the history read was signed by the master key
  | 'exposed'             // the master key signed: its public key is on the ledger, and it can still sign
  | 'exposed-disabled'    // exposed, but lsfDisableMaster is set: a recovered master key cannot sign
  | 'unknown';            // the history read was incomplete and showed no master signature: not known to be safe

export type RegularKeyState = 'none' | 'never-signed' | 'exposed' | 'unknown';

export type ExposurePosture =
  | 'unexposed'           // nothing that can sign this account has published its public key
  | 'rotating'            // every key that can sign alone was exposed for less than the policy's maximum
  | 'stale-exposure'      // a key that can sign alone has been exposed longer than the maximum: rotate
  | 'master-exposed'      // the master key is exposed and still enabled: disable it behind a regular key
  | 'multisig'            // a signer list governs: see each signer's own exposure
  | 'unknown';

export interface ExposedKey { publicKey: string; address: string; firstSeen: string; lastSeen: string; firstTx: string; signatures: number }

export interface KeyExposureReport {
  kind: 'cappz-key-exposure/v1';
  account: string;
  posture: ExposurePosture;
  master: { state: MasterKeyState; exposure?: ExposedKey };
  regularKey: { address?: string; state: RegularKeyState; exposure?: ExposedKey; exposedDays?: number };
  signerList?: SignerSetup['signerList'];
  /** Accounts whose keys signed this account's transactions as multi-signers (each exposed its own key). */
  multiSigners: ExposedKey[];
  historyComplete: boolean;
  transactionsRead: number;
  maxExposureDays: number;
  findings: Array<{ code: string; message: string }>;
  /** What the ledger itself provides against a quantum attacker: today, classical signatures only. */
  ledgerSignatures: 'classical-only';
  reportHash: string;
}

const iso = (t: string) => new Date(t).toISOString();

function accrue(map: Map<string, ExposedKey>, publicKey: string, at: string, hash: string): void {
  const pk = publicKey.toUpperCase();
  const prev = map.get(pk);
  if (!prev) { map.set(pk, { publicKey: pk, address: deriveAddress(pk), firstSeen: at, lastSeen: at, firstTx: hash, signatures: 1 }); return; }
  prev.signatures++;
  if (at < prev.firstSeen) { prev.firstSeen = at; prev.firstTx = hash; }
  if (at > prev.lastSeen) prev.lastSeen = at;
}

/**
 * Exposure of one account from account_info (`setup`) and the validated transactions it sent (`txs`, any order).
 * `historyComplete` is false when account_tx returned a marker (older transactions not read).
 */
export async function keyExposure(o: {
  account: string;
  setup: SignerSetup;
  txs: readonly ValidatedTx[];
  historyComplete: boolean;
  maxExposureDays?: number;
  now?: number;
}): Promise<KeyExposureReport> {
  const now = o.now ?? Date.now();
  const maxExposureDays = o.maxExposureDays ?? 30;
  const singles = new Map<string, ExposedKey>();
  const signers = new Map<string, ExposedKey>();
  for (const v of o.txs) {
    if (v.tx.Account !== o.account) continue;
    const at = iso(v.closeTime);
    const spk = typeof v.tx.SigningPubKey === 'string' ? v.tx.SigningPubKey : '';
    if (spk) accrue(singles, spk, at, v.hash);
    for (const s of (v.tx.Signers as Array<{ Signer?: { SigningPubKey?: string } }> | undefined) ?? []) if (s.Signer?.SigningPubKey) accrue(signers, s.Signer.SigningPubKey, at, v.hash);
  }
  const masterDisabled = (o.setup.flags & LSF_DISABLE_MASTER) !== 0;
  const masterExp = [...singles.values()].find((k) => k.address === o.account);
  const master: KeyExposureReport['master'] = masterExp
    ? { state: masterDisabled ? 'exposed-disabled' : 'exposed', exposure: masterExp }
    : { state: o.historyComplete ? 'never-signed' : 'unknown' };
  const rkAddr = o.setup.regularKey;
  const rkExp = rkAddr ? [...singles.values()].find((k) => k.address === rkAddr) : undefined;
  const regularKey: KeyExposureReport['regularKey'] = !rkAddr
    ? { state: 'none' }
    : rkExp
      ? { address: rkAddr, state: 'exposed', exposure: rkExp, exposedDays: Math.floor((now - Date.parse(rkExp.firstSeen)) / DAY) }
      : { address: rkAddr, state: o.historyComplete ? 'never-signed' : 'unknown' };

  const findings: KeyExposureReport['findings'] = [];
  let posture: ExposurePosture;
  if (master.state === 'exposed') {
    posture = 'master-exposed';
    findings.push({ code: 'master-exposed', message: `The master key signed (first ${master.exposure!.firstSeen}, tx ${master.exposure!.firstTx}) and is still enabled: set a regular key, then disable the master key (AccountSet asfDisableMaster), so a key recovered from the ledger cannot sign.` });
  } else if (o.setup.signerList) {
    posture = 'multisig';
    findings.push({ code: 'multisig', message: `A signer list (quorum ${o.setup.signerList.quorum}) governs. ${signers.size} signer key(s) are exposed by multi-signed transactions; check each signer account's own exposure.` });
  } else if (regularKey.state === 'exposed' && (regularKey.exposedDays ?? 0) > maxExposureDays) {
    posture = 'stale-exposure';
    findings.push({ code: 'rotate-regular-key', message: `The regular key ${rkAddr} has been exposed for ${regularKey.exposedDays} days (maximum ${maxExposureDays}): rotate to a fresh regular key (SetRegularKey).` });
  } else if (master.state === 'unknown' || regularKey.state === 'unknown') {
    posture = 'unknown';
    findings.push({ code: 'history-incomplete', message: 'Older transactions were not read, so a key may have signed before them: read the full history before relying on "never signed".' });
  } else if (regularKey.state === 'exposed' || master.state === 'exposed-disabled') {
    posture = regularKey.state === 'exposed' ? 'rotating' : 'unexposed';
  } else {
    posture = 'unexposed';
  }
  if (master.state === 'exposed-disabled' && !rkAddr && !o.setup.signerList) findings.push({ code: 'no-signer', message: 'The master key is disabled and there is no regular key or signer list: the account cannot sign.' });
  if (posture === 'unexposed' && master.state === 'never-signed' && !rkAddr) findings.push({ code: 'receive-only', message: 'No key of this account has ever signed: a good quickSweep vault while it stays receive-only.' });

  const body = {
    kind: 'cappz-key-exposure/v1' as const, account: o.account, posture, master, regularKey,
    ...(o.setup.signerList ? { signerList: o.setup.signerList } : {}),
    multiSigners: [...signers.values()], historyComplete: o.historyComplete, transactionsRead: o.txs.length,
    maxExposureDays, findings, ledgerSignatures: 'classical-only' as const,
  };
  return { ...body, reportHash: await sha256HexOf(canonicalJson(body)) };
}

/**
 * The n-th regular key for an account, from a private 32-byte root secret: entropy =
 * HMAC-SHA256(secret, "cappz-regular-key/v1|<network>|<account>|<n>")[0..16], an Ed25519 XRPL key. Hardened: the
 * HMAC runs over the private secret, so a key recovered from its public key reveals nothing about the root or the
 * next key. Keep the root offline (or derive it from the recovery seed, never from an account's private key).
 */
export async function regularKeyFor(secretHex: string, network: string, account: string, index: number): Promise<Wallet> {
  if (!/^[0-9a-f]{64}$/i.test(secretHex)) throw new Error('regular key root must be 64 hex characters (32 random bytes)');
  if (!Number.isInteger(index) || index < 0) throw new Error('rotation index must be a whole number');
  const raw = Uint8Array.from(secretHex.match(/../g)!, (x) => parseInt(x, 16));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`cappz-regular-key/v1|${network}|${account}|${index}`)));
  return Wallet.fromEntropy(mac.slice(0, 16), { algorithm: 'ed25519' as ECDSA });
}

/** Unsigned SetRegularKey moving signing to `newRegularKey` (sign it with the current regular key or the master key). */
export function rotationTransaction(account: string, newRegularKey: string): Record<string, unknown> {
  if (!isValidClassicAddress(account) || !isValidClassicAddress(newRegularKey)) throw new Error('rotation: invalid address');
  if (newRegularKey === account) throw new Error('rotation: the regular key must differ from the account');
  return { TransactionType: 'SetRegularKey', Account: account, RegularKey: newRegularKey };
}

/** Unsigned AccountSet disabling the master key (only once a regular key or signer list can sign). */
export function disableMasterTransaction(account: string): Record<string, unknown> {
  return { TransactionType: 'AccountSet', Account: account, SetFlag: 4 /* asfDisableMaster */ };
}

export type SweepRefusal = 'vault-exposed' | 'vault-unknown' | 'same-account' | 'nothing-above-buffer' | 'invalid-address';

/**
 * quickSweep: an unsigned XRP Payment moving everything above `bufferDrops` (and the account reserve, and the fee)
 * from a working account to a vault whose key has never signed. Refused, with the reason, when the vault's
 * exposure report is not 'unexposed' with a never-signed master key and no regular key — a vault that already
 * published a key is not a safe place to sweep to.
 */
export function quickSweepTransaction(o: {
  account: string;
  balanceDrops: string;
  reserveDrops: string;
  bufferDrops: string;
  feeDrops?: string;
  vault: KeyExposureReport;
  destinationTag?: number;
}): { tx: Record<string, unknown>; amountDrops: string } | { refused: SweepRefusal; message: string } {
  if (!isValidClassicAddress(o.account) || !isValidClassicAddress(o.vault.account)) return { refused: 'invalid-address', message: 'invalid address' };
  if (o.vault.account === o.account) return { refused: 'same-account', message: 'the vault must be another account' };
  if (o.vault.posture === 'unknown' || !o.vault.historyComplete) return { refused: 'vault-unknown', message: 'the vault\'s full history was not read: its key may already be exposed' };
  if (o.vault.posture !== 'unexposed' || o.vault.master.state !== 'never-signed' || o.vault.regularKey.state !== 'none') {
    return { refused: 'vault-exposed', message: `the vault is ${o.vault.posture} (master ${o.vault.master.state}, regular key ${o.vault.regularKey.state}): sweep to an address whose keys never signed` };
  }
  const fee = BigInt(o.feeDrops ?? '12');
  const amount = BigInt(o.balanceDrops) - BigInt(o.reserveDrops) - BigInt(o.bufferDrops) - fee;
  if (amount <= 0n) return { refused: 'nothing-above-buffer', message: 'the balance does not exceed reserve + buffer + fee' };
  return {
    amountDrops: amount.toString(),
    tx: { TransactionType: 'Payment', Account: o.account, Destination: o.vault.account, Amount: amount.toString(), Fee: fee.toString(), ...(o.destinationTag !== undefined ? { DestinationTag: o.destinationTag } : {}) },
  };
}
