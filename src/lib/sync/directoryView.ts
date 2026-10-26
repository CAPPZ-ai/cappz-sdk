/**
 * COPE node crystallized.
 * Node ID: v15-09-00-directory-view
 * Provenance: m/44'/144'/100'/principles/cope/v1
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * The ontology is the directory, per instance. A directory entry is a
 * projection — never a store — of three explicit signals:
 *   member records   where a copy's device accepts connections (endpointDirectory.ts)
 *   ontology edges   ConstituentIncluded parent → child (walletOntology.ts)
 *   alias records    the display name a wallet gave itself (AliasCreated/Amended)
 * Placement comes only from an ontology edge naming the entry's wallet; an
 * entry without one is listed under 'unplaced' (a visible gap), never put in
 * a group because of its name. Names are display text and are never parsed.
 *
 * The legacy front end serves this view as JSON (GET /legacy/v1/directory),
 * so clients that used an LDAP or bindery-style lookup read the same table.
 */

import type { DirectoryEntry } from './endpointDirectory.ts';

export const UNPLACED_PARENT = 'unplaced';

/** The ConstituentIncluded fields the view reads (structurally, so the edge node need not import walletOntology). */
export interface OntologyEdgeLike { eventType: string; sourceAddress: string; targetAddress: string; payload?: { relation?: string; ordinal?: number } }

export interface DirectoryRow {
  walletAddress: string;
  copyId: string;
  deviceId: string;
  address: string;
  /** Display name: the wallet's alias if recorded, else null (shown as the address). */
  name: string | null;
  description?: string;
  parent: string;
  ordinal: number;
  endpoints: Array<{ scope: string; url: string; carriers: string[] }>;
  trust: DirectoryEntry['trust'];
  registeredAt: string;
}

export function projectDirectory(input: {
  members: readonly DirectoryEntry[];
  ontology?: readonly OntologyEdgeLike[];
  aliases?: Readonly<Record<string, { name: string; description?: string }>>;
}): DirectoryRow[] {
  const parentOf = new Map<string, { parent: string; ordinal: number }>();
  for (const e of input.ontology ?? []) {
    if (e.eventType !== 'ConstituentIncluded' || e.payload?.relation !== 'ontology') continue;
    parentOf.set(e.targetAddress, { parent: e.sourceAddress, ordinal: e.payload?.ordinal ?? 0 });
  }
  return input.members.map((m) => {
    const r = m.record;
    const placed = parentOf.get(r.walletAddress) ?? parentOf.get(r.address);
    const alias = input.aliases?.[r.walletAddress];
    return {
      walletAddress: r.walletAddress, copyId: r.copyId, deviceId: r.deviceId, address: r.address,
      name: alias?.name ?? null, ...(alias?.description ? { description: alias.description } : {}),
      parent: placed?.parent ?? UNPLACED_PARENT, ordinal: placed?.ordinal ?? 0,
      endpoints: r.endpoints.map((e) => ({ scope: e.scope, url: e.url, carriers: [...e.carriers] })),
      trust: m.trust, registeredAt: r.registeredAt,
    };
  }).sort((a, b) => (a.parent === b.parent ? a.ordinal - b.ordinal || a.address.localeCompare(b.address) : a.parent === UNPLACED_PARENT ? 1 : b.parent === UNPLACED_PARENT ? -1 : a.parent.localeCompare(b.parent)));
}
