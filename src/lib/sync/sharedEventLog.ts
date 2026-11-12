/**
 * Shared event log — 15.39.0.
 *
 * An admin-governed event cache (agent window bindings, skill compositions,
 * recorded function moves) used to be readable only by the browser that wrote
 * it: entries went to on-device storage and to an owner-only, per-device
 * mirror partition, and the cache's remote recovery returned nothing. A new
 * device, a private window or another administrator saw every binding as
 * unbound.
 *
 * A cache opted in with `shared: true` now also has a public copy: one
 * partition of the existing mirror per log (`pub:<event-log address>`), read by
 * anyone, appended only by accounts the mirror checks (the app's insert policy
 * attributes the author and requires the admin role), never updated or
 * deleted. Writes go to the shared copy first and to the wallet only after it
 * accepted them, so nobody keeps a binding others cannot see. Reads merge the
 * shared copy into the device store, so a new device converges and later works
 * offline.
 *
 * The SDK holds no mirror address: the app registers the port
 * (registerSharedEventLog). Unregistered, shared caches run local-only, as
 * before.
 */

/** SHA-256 hex with Web Crypto (no import from the governance chainlet, which itself builds an event cache). */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface SharedLogEntry { txId: string; timestamp: string; eventType?: string; targetAddress?: string }

/** One published entry as read back: the entry, the author the mirror attested, and when the mirror received it. */
export interface SharedLogRecord<T extends SharedLogEntry = SharedLogEntry> { entry: T; author: string; receivedAt: string }

export interface SharedEventLogPort {
  /** Append entries to the partition as one insert; throws when the mirror refuses (nothing is saved). */
  publish(partition: string, entries: readonly SharedLogEntry[]): Promise<void>;
  /** Every entry in the partition, in the order the mirror received them. */
  pull(partition: string): Promise<SharedLogRecord[]>;
}

let registered: SharedEventLogPort | null = null;

export function registerSharedEventLog(port: SharedEventLogPort | null): void { registered = port; }
export function sharedEventLog(): SharedEventLogPort | null { return registered; }

/** The public partition for an event-log address; trailing slashes do not make a second log. */
export const sharedPartitionFor = (eventLogAddress: string): string => `pub:${eventLogAddress.replace(/\/+$/, '')}`;

/** Minimal mirror port: the hosted chainlet_blocks table (the app passes its client; tests a fake). */
export interface SharedLogMirror {
  insert(rows: Array<Record<string, unknown>>): Promise<{ error: { message: string } | null }>;
  select(partition: string, since: string | null, limit: number): Promise<{ data: Array<{ metadata: unknown; created_at: string }> | null; error: { message: string } | null }>;
}

const PAGE = 1000;

/**
 * The port over a chainlet_blocks mirror. Rows carry `metadata.sharedTx = { tx, author }`;
 * `authorOf` returns the signed-in account's author hash (the mirror recomputes and checks it).
 */
export function mirrorSharedEventLog(mirror: SharedLogMirror, authorOf: () => Promise<string>): SharedEventLogPort {
  return {
    async publish(partition, entries) {
      if (!entries.length) return;
      const author = await authorOf();
      const rows = await Promise.all(entries.map(async (tx, i) => {
        const hash = await sha256Hex(JSON.stringify(tx));
        return {
          block_hash: hash, previous_hash: '', merkle_root: hash, block_number: i, transaction_count: 1,
          timestamp: tx.timestamp, query_hash: partition, hd_address: tx.targetAddress ?? partition,
          transactions: { type: 'shared_event_tx', eventType: tx.eventType ?? null, txId: tx.txId },
          anchor_block: { sharedLog: true }, metadata: { sharedTx: { tx, author } },
        };
      }));
      const { error } = await mirror.insert(rows);
      if (error) throw new Error(`The shared log refused the write (nothing was saved): ${error.message}`);
    },
    async pull(partition) {
      const out: SharedLogRecord[] = [];
      let since: string | null = null;
      for (let page = 0; page < 50; page++) {
        const { data, error } = await mirror.select(partition, since, PAGE);
        if (error) throw new Error(`Could not read the shared log: ${error.message}`);
        const rows = data ?? [];
        for (const r of rows) {
          const m = (r.metadata as { sharedTx?: { tx?: SharedLogEntry; author?: string } } | null)?.sharedTx;
          if (m?.tx?.txId && typeof m.tx.timestamp === 'string' && typeof m.author === 'string') out.push({ entry: m.tx, author: m.author, receivedAt: r.created_at });
        }
        if (rows.length < PAGE) break;
        since = rows[rows.length - 1].created_at;
      }
      return out;
    },
  };
}
