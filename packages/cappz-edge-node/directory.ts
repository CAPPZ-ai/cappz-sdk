/**
 * COPE node crystallized.
 * Node ID: v15-05-00-edge-node-directory
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * The node's own member-table record and its view of the table. The record
 * says where this node accepts connections — CAPPZ_NODE_LAN_URL (+ its
 * CAPPZ_NODE_LAN_ID) for peers on the same network, CAPPZ_NODE_PUBLIC_URL
 * (or CAPPZ_RELAY_PUBLIC_URL) for everyone else — signed with the node key.
 * It is stored as a content-addressed body, so the body pull every peer
 * session runs (edgeBodyPull.ts) replicates member records like any body.
 * The node answers connect requests with it (the source answering for
 * itself); a peer that holds it dials the node directly next time.
 * LAN endpoints are visible to peers that connect: leave CAPPZ_NODE_LAN_URL
 * unset if the LAN layout must stay private.
 */

import { replayEndpointDirectory, signEndpointRecord, type DeviceEndpoint, type DirectoryEntry, type EndpointRecord } from '../../src/lib/sync/endpointDirectory.ts';
import { copyDeviceAddress, replicatorNetworkRoot } from '../../src/lib/wallets/paths.ts';
import { sha256Hex, type BodyStore } from '../../src/lib/sync/edgeBodyPull.ts';
import type { SigningKey } from '../../src/lib/sync/helloSignature.ts';

const isRecord = (v: unknown): v is EndpointRecord => !!v && typeof v === 'object' && (v as EndpointRecord).v === 1 && typeof (v as EndpointRecord).signature === 'string' && Array.isArray((v as EndpointRecord).endpoints);

/** Every member record this node holds (bodies that parse as records). */
export async function memberTableFromStore(store: BodyStore): Promise<DirectoryEntry[]> {
  const records: EndpointRecord[] = [];
  for (const id of await store.list()) {
    const bytes = await store.get(id);
    if (!bytes || bytes.length > 64 * 1024) continue;
    try { const v = JSON.parse(new TextDecoder().decode(bytes)); if (isRecord(v)) records.push(v); } catch { /* not a record */ }
  }
  return replayEndpointDirectory(records);
}

export function nodeEndpointsFromEnv(webTransport: boolean): DeviceEndpoint[] {
  const carriers: DeviceEndpoint['carriers'] = [...(webTransport ? ['webtransport' as const] : []), 'wss', 'https-stream', 'https-poll'];
  const out: DeviceEndpoint[] = [];
  const lan = Deno.env.get('CAPPZ_NODE_LAN_URL');
  if (lan) out.push({ scope: 'lan', url: lan, carriers, lanId: Deno.env.get('CAPPZ_NODE_LAN_ID') ?? 'lan' });
  const pub = Deno.env.get('CAPPZ_NODE_PUBLIC_URL') ?? Deno.env.get('CAPPZ_RELAY_PUBLIC_URL');
  if (pub) out.push({ scope: 'public', url: pub, carriers });
  return out;
}

/**
 * Register (or amend) this node's record when its endpoints changed, and
 * keep it in the body store. Returns the current record.
 */
export async function registerNodeRecord(opts: { powAddress: string; key: SigningKey; store: BodyStore; endpoints: DeviceEndpoint[] }): Promise<EndpointRecord> {
  // One device per node key: stable across restarts, no host lookup (or --allow-sys) needed.
  const deviceId = `node-${(await sha256Hex(new TextEncoder().encode(`${opts.powAddress}|${opts.key.publicKeyHex}`))).slice(0, 12)}`;
  const copyId = `${opts.powAddress}#node`;
  const address = copyDeviceAddress(replicatorNetworkRoot(opts.powAddress), copyId, deviceId);
  const mine = (await memberTableFromStore(opts.store)).find((e) => e.record.address === address);
  const same = mine && JSON.stringify(mine.record.endpoints) === JSON.stringify(opts.endpoints);
  if (mine && same) return mine.record;
  const record = await signEndpointRecord({
    walletAddress: opts.powAddress, copyId, deviceId, address, endpoints: opts.endpoints, registeredAt: new Date().toISOString(),
    ...(mine ? { amends: mine.recordId } : {}),
  }, opts.key);
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  await opts.store.put(await sha256Hex(bytes), bytes);
  return record;
}
