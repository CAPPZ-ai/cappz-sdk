export { runSyncCycle, syncCacheWalletCopies } from '../lib/sync/a2aBlockExchange';
export { CreateEventSubscription } from '../lib/sync/CreateEventSubscription';

/** The optional hosted mirror (from(table) builders, functions.invoke): register one, or run local-only. */
export { registerHostedClient, hasHostedClient } from '../lib/sync/hostedBackend';
export type { HostedClient, HostedSlot } from '../lib/sync/hostedBackend';
