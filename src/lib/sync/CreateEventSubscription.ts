/**
 * CreateEventSubscription — Sovereign event subscription via cappz-middleware pub/sub.
 *
 * Replaces direct Supabase realtime channels (AP-22 remediation).
 * Filters by HD path prefix and optional event type.
 * Returns unsubscribe teardown function.
 *
 * AX-70: Event-Driven Cache Invalidation
 * AX-63: Single Storage Stack — zero Supabase dependency
 * AX-75: Receives HD address from event bus — no sync-over-async reads
 * AX-76: Supports both Tier 1 (address-only) and Tier 2 (managed) delivery
 *
 * HD: m/44'/144'/0'/cappz/sync/create-event-subscription
 */

import { middlewareSubscribe, middlewareManagedSubscribe, type MutationType } from './cappz-middleware';

/**
 * Create a sovereign event subscription filtered by HD path prefix.
 *
 * AX-75 fix: The callback receives content via the event bus hdAddress parameter,
 * eliminating the broken sync-over-async chainletStorage.getItem() call.
 *
 * @param hdPath - HD path prefix to watch (e.g., 'cappz:codex/config/')
 * @param callback - Invoked on matching mutations with key, value, and mutation type
 * @param eventType - Optional event type filter(s). If provided, only matching payload.eventType triggers callback.
 *                    Pass null or omit for all events.
 * @returns Unsubscribe teardown function
 */
export function CreateEventSubscription(
  hdPath: string,
  callback: (key: string, value: unknown, mutationType: 'write' | 'delete') => void,
  eventType?: string | string[] | null,
): () => void {
  const eventTypes = eventType
    ? (Array.isArray(eventType) ? eventType : [eventType])
    : null;

  // AX-76 Tier 2: Use managed subscription for write events that need content.
  // Middleware handles the async fetch boundary — no direct chainletStorage calls.
  const unsubManaged = middlewareManagedSubscribe(
    { keyPrefix: hdPath },
    (key, content, hdAddress) => {
      // Strict event-type filter: when eventTypes are provided, the payload
      // MUST carry one of them. Payloads with no eventType (e.g. derived KV
      // cache projections) are dropped — they are not events.
      if (eventTypes) {
        const t = content && typeof content === 'object'
          ? ((content as any).eventType ?? (content as any).type)
          : undefined;
        if (!t || !eventTypes.includes(t)) return;
      }

      const mutationType = content === null ? 'delete' : 'write';
      callback(key, content, mutationType);
    },
  );

  // AX-76 Tier 1: Also subscribe for delete/clear events (no content fetch needed)
  const unsubTier1 = middlewareSubscribe((store: string, key: string, type: MutationType, hdAddress: string) => {
    if (type !== 'delete') return; // Writes handled by managed subscription above
    if (!key.startsWith(hdPath)) return;
    callback(key, null, 'delete');
  });

  console.log(`[CreateEventSubscription] Subscribed to '${hdPath}'${eventTypes ? ` (events: ${eventTypes.join(', ')})` : ''}`);

  return () => {
    unsubManaged();
    unsubTier1();
    console.log(`[CreateEventSubscription] Unsubscribed from '${hdPath}'`);
  };
}
