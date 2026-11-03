/**
 * COPE node crystallized. Node ID: v15-15-00-marketplace-public-log.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * The marketplace's shared, public event log. Each person's wallet keeps its
 * own copy (marketLedger, device sync); this log is how everyone else sees it.
 * One partition of the existing hosted mirror (chainlet_blocks, query_hash
 * PUBLIC_LOG_PARTITION; migration v15_15_00_marketplace_public_log) — no new
 * table. A command is published there first and written to the wallet only
 * if publishing succeeds, so a party never holds a market action nobody else
 * can see.
 *
 * Attribution is server-checked: the mirror accepts an entry only when its
 * `author` is the hash of the signed-in account (authorHashOf), operator
 * entries need the moderator or admin role, and timestamps cannot be
 * back-dated. Readers then bind each party to the first author that wrote for
 * it (attributePublicLog) and set aside entries for that party from anyone
 * else — reported, never silently dropped. That is "attested by the mirror",
 * not "signed by a wallet": the two are different trust states.
 */
import { sha256Hex } from '../governance/PrinciplesChainlet';
import type { MarketTx, MarketTxLike } from './ledger';
import { MARKETPLACE_EVENT_LOG, MARKETPLACE_POW_ROOT, partyAddress } from './MarketplacePaths';

export const PUBLIC_LOG_PARTITION = `pub:${MARKETPLACE_EVENT_LOG}`;
const OPERATOR_PREFIX = `${MARKETPLACE_POW_ROOT}/operators/`;
/** Entries the payments function writes for Stripe (service role; no signed-in account can write this author). */
export const PROCESSOR_SOURCE = `${MARKETPLACE_POW_ROOT}/processors/stripe`;
export const PROCESSOR_AUTHOR = 'processor:stripe';

/** One published entry: the TX, its server-checked author, and the party it acts for (null for operator entries). */
export interface PublicEntry { tx: MarketTxLike; author: string; actingParty: string | null; receivedAt: string }

/** Minimal mirror port (the app passes its hosted client; tests pass a fake). */
export interface PublicLogPort {
  insert(rows: Array<Record<string, unknown>>): Promise<{ error: { message: string } | null }>;
  /** Entries received at or after `since` (server time), oldest first. */
  select(since: string | null, limit: number): Promise<{ data: Array<{ metadata: unknown; created_at: string }> | null; error: { message: string } | null }>;
}

/** The author hash the mirror checks: sha256('cappz-marketplace-author|' + account id), hex. */
export const authorHashOf = (accountId: string) => sha256Hex(`cappz-marketplace-author|${accountId}`);

/** Publish one command's TXs as one insert (all or nothing). */
export async function publishToPublicLog(port: PublicLogPort, txs: readonly MarketTx[], author: string, actingParty: string | null): Promise<void> {
  if (!txs.length) return;
  const rows = await Promise.all(txs.map(async (tx, i) => {
    const hash = await sha256Hex(JSON.stringify(tx));
    return {
      block_hash: hash, previous_hash: '', merkle_root: hash, block_number: i, transaction_count: 1,
      timestamp: tx.timestamp, query_hash: PUBLIC_LOG_PARTITION, hd_address: tx.targetAddress,
      transactions: { type: 'public_market_tx', eventType: tx.eventType, txId: tx.txId },
      anchor_block: { publicLog: true }, metadata: { publicTx: { tx, author, actingParty } },
    };
  }));
  const { error } = await port.insert(rows);
  if (error) throw new Error(`Could not publish to the shared market (nothing was saved): ${error.message}`);
}

const PAGE = 1000;

/** Pull entries received since `since` (server time), paging until a short page. */
export async function pullPublicLog(port: PublicLogPort, since: string | null): Promise<PublicEntry[]> {
  const out: PublicEntry[] = [];
  let cursor = since;
  for (let i = 0; i < 50; i++) {
    const { data, error } = await port.select(cursor, PAGE);
    if (error) throw new Error(`Could not read the shared market: ${error.message}`);
    const rows = data ?? [];
    for (const r of rows) {
      const m = (r.metadata as { publicTx?: { tx?: MarketTxLike; author?: string; actingParty?: string | null } } | null)?.publicTx;
      if (m?.tx?.txId && typeof m.author === 'string') out.push({ tx: m.tx, author: m.author, actingParty: m.actingParty ?? null, receivedAt: r.created_at });
    }
    if (rows.length < PAGE) break;
    cursor = rows[rows.length - 1].created_at;
  }
  return out;
}

export interface Attribution {
  accepted: MarketTxLike[];
  /** Entries set aside, with the reason (shown to operators). */
  rejected: Array<{ txId: string; eventType: string; reason: string }>;
  /** party id → author hash that owns it. */
  owners: Map<string, string>;
}

/**
 * Bind parties to authors and keep only entries a party's own author wrote. Entries are taken in the order the
 * mirror received them; the first author to write for a party owns it. Operator entries were role-checked by the
 * mirror. Duplicates (same txId) keep the first.
 */
export function attributePublicLog(entries: readonly PublicEntry[]): Attribution {
  const owners = new Map<string, string>();
  const seen = new Set<string>();
  const accepted: MarketTxLike[] = []; const rejected: Attribution['rejected'] = [];
  const ordered = [...entries].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  for (const e of ordered) {
    if (seen.has(e.tx.txId)) continue;
    seen.add(e.tx.txId);
    const reject = (reason: string) => rejected.push({ txId: e.tx.txId, eventType: e.tx.eventType, reason });
    if (e.tx.sourceAddress.startsWith(OPERATOR_PREFIX)) { accepted.push(e.tx); continue; }
    if (e.tx.sourceAddress === PROCESSOR_SOURCE || e.author === PROCESSOR_AUTHOR) {
      // Processor-confirmed: only the payments function writes this author (the mirror refuses it from accounts).
      if (e.author === PROCESSOR_AUTHOR && e.tx.sourceAddress === PROCESSOR_SOURCE && e.tx.eventType === 'PaymentConfirmed') accepted.push(e.tx);
      else reject('claims to be the payment processor');
      continue;
    }
    if (!e.actingParty) { reject('no acting party'); continue; }
    if (e.tx.sourceAddress !== partyAddress(e.actingParty)) { reject(`written for ${e.actingParty} but sourced elsewhere`); continue; }
    const owner = owners.get(e.actingParty);
    if (owner && owner !== e.author) { reject(`party ${e.actingParty} belongs to another account`); continue; }
    if (!owner) owners.set(e.actingParty, e.author);
    accepted.push(e.tx);
  }
  return { accepted, rejected, owners };
}

/** Union of this wallet's own copy and the public log, one entry per txId. */
export function mergeMarketTxs(own: readonly MarketTxLike[], shared: readonly MarketTxLike[]): MarketTxLike[] {
  const byId = new Map<string, MarketTxLike>();
  for (const t of shared) byId.set(t.txId, t);
  for (const t of own) if (!byId.has(t.txId)) byId.set(t.txId, t);
  return [...byId.values()];
}
