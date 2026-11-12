export { runSyncCycle, syncCacheWalletCopies } from '../lib/sync/a2aBlockExchange';
export { CreateEventSubscription } from '../lib/sync/CreateEventSubscription';

/** The optional hosted mirror (from(table) builders, functions.invoke): register one, or run local-only. */
export { registerHostedClient, hasHostedClient } from '../lib/sync/hostedBackend';
export type { HostedClient, HostedSlot } from '../lib/sync/hostedBackend';

/** 15.39.0 — the public copy of admin-governed event logs (bindings, compositions, recorded moves): register a port, or run local-only. */
export { registerSharedEventLog, sharedEventLog, sharedPartitionFor, mirrorSharedEventLog } from '../lib/sync/sharedEventLog';
export type { SharedEventLogPort, SharedLogEntry, SharedLogRecord, SharedLogMirror } from '../lib/sync/sharedEventLog';
