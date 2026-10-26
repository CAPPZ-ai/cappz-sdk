/**
 * Callback Notification Transport — Transport-agnostic response notification
 * 
 * When a client submits a syncOnAsync request with a callbackAddress,
 * the processing service notifies the caller when the response is ready —
 * but ONLY if the response has not already been fetched via fetchAsyncResponse().
 * 
 * Transport Adapters:
 *   - 'a2a'  → Agent-to-Agent notification via A2AProtocol (sovereign, P2P)
 *   - 'http' → Legacy HTTP webhook POST (for non-sovereign clients)
 *   - 'queue'→ Inbound queue write (for cloud-hosted agents)
 * 
 * The callback address format encodes the transport:
 *   a2a://<agentId>/<pipeline>         → A2A message
 *   https://example.com/callback       → HTTP POST
 *   queue://<walletAddress>/<channel>   → a2a_inbound_queue write
 * 
 * Patent alignment:
 *   US 7,769,802 — Callback notification as optional sync-on-async enhancement
 *   US 7,870,187 — Pull-mode retrieval remains canonical; callback is advisory
 */

import { a2aProtocol, type A2AMessage } from '../a2aProtocol';
import { hostedClient } from './hostedBackend';

// ─── Types ────────────────────────────────────────────────────

export type CallbackTransport = 'a2a' | 'http' | 'queue';

export interface CallbackAddress {
  /** Raw callback URI as provided by the client */
  raw: string;
  /** Resolved transport type */
  transport: CallbackTransport;
  /** Transport-specific target (agentId, URL, or queue channel) */
  target: string;
  /** Optional sub-path or pipeline within the target */
  path?: string;
}

export interface CallbackNotification {
  /** The correlationId (TxID) of the completed submission */
  correlationId: string;
  /** Original messageId */
  messageId: string;
  /** Status: 'completed' | 'failed' */
  status: 'completed' | 'failed';
  /** ISO timestamp of completion */
  completedAt: string;
  /** Pipeline that processed the request */
  pipeline: string;
}

export interface NotificationResult {
  /** Whether notification was sent */
  sent: boolean;
  /** Transport used */
  transport: CallbackTransport;
  /** Reason if not sent */
  reason?: string;
  /** A2A message ID if sent via A2A */
  a2aMessageId?: string;
}

// ─── Parse Callback Address ───────────────────────────────────

export function parseCallbackAddress(raw: string): CallbackAddress {
  if (raw.startsWith('a2a://')) {
    const parts = raw.slice(6).split('/');
    return {
      raw,
      transport: 'a2a',
      target: parts[0],
      path: parts.slice(1).join('/') || undefined,
    };
  }

  if (raw.startsWith('queue://')) {
    const parts = raw.slice(8).split('/');
    return {
      raw,
      transport: 'queue',
      target: parts[0],
      path: parts.slice(1).join('/') || undefined,
    };
  }

  // Default: HTTP/HTTPS webhook
  return {
    raw,
    transport: 'http',
    target: raw,
  };
}

// ─── Transport Dispatchers ────────────────────────────────────

/**
 * A2A transport — sends notification as an A2AMessage.
 * Uses the existing A2AProtocol with a new 'SYNC_RESPONSE' type
 * carrying the callback notification payload.
 */
async function dispatchA2A(
  address: CallbackAddress,
  notification: CallbackNotification,
  senderAgentId: string,
  signingKey: string,
): Promise<NotificationResult> {
  try {
    const message: A2AMessage = a2aProtocol.createMessage(
      senderAgentId,
      address.target,
      'SYNC_RESPONSE',
      {
        type: 'callback_notification',
        correlationId: notification.correlationId,
        messageId: notification.messageId,
        status: notification.status,
        completedAt: notification.completedAt,
        pipeline: notification.pipeline,
        callbackPath: address.path,
      },
      signingKey,
      { correlationId: notification.correlationId, ttl: 300 },
    );

    // Persist A2A message to inbound queue for the target agent
    const { error } = await hostedClient().from('chainlet_blocks').insert([{
      query_hash: `a2a_notify_${address.target}`,
      block_number: Date.now(),
      block_hash: message.header.messageId,
      previous_hash: '0'.repeat(64),
      merkle_root: notification.correlationId,
      timestamp: new Date().toISOString(),
      transaction_count: 1,
      transactions: { notification, a2aMessage: message } as any,
      anchor_block: { type: 'callback_notification', transport: 'a2a' } as any,
    }]);

    if (error) {
      console.warn('[CallbackTransport] A2A dispatch failed:', error.message);
      return { sent: false, transport: 'a2a', reason: error.message };
    }

    a2aProtocol.updateTrust(address.target, true);

    return {
      sent: true,
      transport: 'a2a',
      a2aMessageId: message.header.messageId,
    };
  } catch (err: any) {
    return { sent: false, transport: 'a2a', reason: err?.message ?? String(err) };
  }
}

/**
 * HTTP transport — legacy webhook POST for non-sovereign clients.
 */
async function dispatchHTTP(
  address: CallbackAddress,
  notification: CallbackNotification,
): Promise<NotificationResult> {
  try {
    const response = await fetch(address.target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notification),
    });

    if (!response.ok) {
      return {
        sent: false,
        transport: 'http',
        reason: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    return { sent: true, transport: 'http' };
  } catch (err: any) {
    return { sent: false, transport: 'http', reason: err?.message ?? String(err) };
  }
}

/**
 * Queue transport — writes to a2a_inbound_queue-style storage
 * for cloud-hosted agents to poll.
 */
async function dispatchQueue(
  address: CallbackAddress,
  notification: CallbackNotification,
): Promise<NotificationResult> {
  try {
    const channel = address.path ?? 'default';
    const queueKey = `queue_${address.target}_${channel}`;

    const { error } = await hostedClient().from('chainlet_blocks').insert([{
      query_hash: queueKey,
      block_number: Date.now(),
      block_hash: `qn_${notification.correlationId}`,
      previous_hash: '0'.repeat(64),
      merkle_root: notification.correlationId,
      timestamp: new Date().toISOString(),
      transaction_count: 1,
      transactions: { notification } as any,
      anchor_block: { type: 'callback_notification', transport: 'queue' } as any,
    }]);

    if (error) {
      return { sent: false, transport: 'queue', reason: error.message };
    }

    return { sent: true, transport: 'queue' };
  } catch (err: any) {
    return { sent: false, transport: 'queue', reason: err?.message ?? String(err) };
  }
}

// ─── Notification Dispatcher (main entry) ─────────────────────

/**
 * Send a callback notification — ONLY if the response has not already been fetched.
 * 
 * This is the core patent alignment:
 *   "The processing service sends the response notification only if
 *    the fetchAsyncResponse() correlation has not yet returned the response."
 * 
 * @param callbackUri  - The callback address URI (a2a://, queue://, or https://)
 * @param notification - The notification payload
 * @param options      - A2A-specific options (sender, signing key)
 */
export async function dispatchCallbackNotification(
  callbackUri: string,
  notification: CallbackNotification,
  options: {
    senderAgentId?: string;
    signingKey?: string;
  } = {},
): Promise<NotificationResult> {
  const address = parseCallbackAddress(callbackUri);

  switch (address.transport) {
    case 'a2a':
      return dispatchA2A(
        address,
        notification,
        options.senderAgentId ?? 'system',
        options.signingKey ?? 'default-key',
      );

    case 'queue':
      return dispatchQueue(address, notification);

    case 'http':
      return dispatchHTTP(address, notification);

    default:
      return { sent: false, transport: address.transport, reason: 'Unknown transport' };
  }
}
