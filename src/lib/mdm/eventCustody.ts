/**
 * COPE node crystallized.
 * Node ID: v12-11-universal-event-custody
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * One creation path for every event transaction on the substrate.
 *
 * Every emitter (EBB, wallet tiers, model wallet, model packaging,
 * inference residency, type casting, runtime preferences, access
 * control) resolves its MDM declaration here, so the declaration
 * address and registration receipt are inside the transaction hash.
 *
 * Enforcement is record-not-refuse (v12-11): an undeclared event type
 * still writes, but carries `custodyStatus: 'undeclared'` and shows up
 * in `resolveEventCustodyDrift()` until it is declared in the registry.
 *
 * AP-22 naming, AX-92 modal-free. No base class — composition only:
 * the emitters share nothing but this function.
 */

import { sha256Hex } from '../governance/PrinciplesChainlet';
import {
  EVENT_TX_REGISTRY_ROOT,
  getEventTxRegistryEntry,
} from '../skills/core/MDMEventTxRegistry';
import {
  canonicalEventType,
  isRetiredEventType,
  registrationSeedEventType,
} from './eventTypeAliases';

export type EventCustodyStatus = 'declared' | 'undeclared';

export interface EventCustodyLinkage {
  /** MDM HD address governing the event type. */
  eventMdmAddress: string;
  /** Deterministic id of the on-chain registration receipt. */
  eventRegistrationTxId: string;
  /** Whether the type is declared in the canonical MDM registry. */
  custodyStatus: EventCustodyStatus;
}

export interface NotarizedEvent extends EventCustodyLinkage {
  txId: string;
  timestamp: string;
  eventType: string;
  sourceAddress: string;
  targetAddress: string;
  payload: Record<string, unknown> & { governingPrinciple: string };
  txHash: string;
}

export interface EventCustodyDriftEntry {
  eventType: string;
  emissionCount: number;
  emitterDomains: string[];
  sampleTxIds: string[];
}

/** Canonical JSON with sorted keys — the exact bytes that get hashed. */
export function canonicalizeEvent(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeEvent).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalizeEvent((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

function kebab(eventType: string): string {
  return eventType
    .replace(/Tx$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

/** Resolve the MDM linkage for an event type, declared or not. */
export function resolveEventCustody(eventType: string): EventCustodyLinkage {
  const entry = getEventTxRegistryEntry(eventType);
  if (!entry) {
    return {
      eventMdmAddress: `${EVENT_TX_REGISTRY_ROOT}/undeclared/${kebab(eventType)}`,
      eventRegistrationTxId: `undeclared:event-type:${eventType}`,
      custodyStatus: 'undeclared',
    };
  }
  return {
    eventMdmAddress: entry.mdmAddress,
    // v12-20-06: receipt ids keep the name they were first seeded with, so a
    // renamed event still points at its existing registration receipt.
    eventRegistrationTxId: `${entry.category}:event-type:registered:${registrationSeedEventType(eventType)}`,
    custodyStatus: 'declared',
  };
}

// ─── Drift ledger ──────────────────────────────────────────────────

const _drift = new Map<string, { count: number; domains: Set<string>; samples: string[] }>();

/** Record an emission for the drift report. Declared types are not tracked. */
export function recordEventEmission(eventType: string, txId: string, emitterDomain: string): void {
  const current = _drift.get(eventType) ?? { count: 0, domains: new Set<string>(), samples: [] };
  current.count += 1;
  current.domains.add(emitterDomain);
  if (current.samples.length < 5) current.samples.push(txId);
  _drift.set(eventType, current);
}

/** Every undeclared type emitted in this session, with where it came from. */
export function resolveEventCustodyDrift(): EventCustodyDriftEntry[] {
  return Array.from(_drift.entries())
    .map(([eventType, v]) => ({
      eventType,
      emissionCount: v.count,
      emitterDomains: Array.from(v.domains).sort(),
      sampleTxIds: [...v.samples],
    }))
    .sort((a, b) => b.emissionCount - a.emissionCount);
}

/** Drift over an arbitrary transaction history (replay, AX-73). */
export function resolveEventCustodyDriftFromTxs(
  txs: Array<{ txId: string; eventType: string }>,
  emitterDomain = 'replay',
): EventCustodyDriftEntry[] {
  const seen = new Map<string, EventCustodyDriftEntry>();
  for (const tx of txs) {
    if (resolveEventCustody(tx.eventType).custodyStatus === 'declared') continue;
    const entry = seen.get(tx.eventType) ?? {
      eventType: tx.eventType,
      emissionCount: 0,
      emitterDomains: [emitterDomain],
      sampleTxIds: [],
    };
    entry.emissionCount += 1;
    if (entry.sampleTxIds.length < 5) entry.sampleTxIds.push(tx.txId);
    seen.set(tx.eventType, entry);
  }
  return Array.from(seen.values()).sort((a, b) => b.emissionCount - a.emissionCount);
}

export function clearEventCustodyDrift(): void {
  _drift.clear();
}

// ─── The one creator ───────────────────────────────────────────────

export async function createNotarizedEvent(params: {
  txId: string;
  timestamp?: string;
  eventType: string;
  sourceAddress: string;
  targetAddress: string;
  payload?: Record<string, unknown>;
  governingPrinciple: string;
  /** Which emitter asked — used by the drift report. */
  emitterDomain: string;
  /**
   * 'record' (default, v12-11): undeclared types are written and reported.
   * 'refuse': throw instead — used where the vocabulary is already complete.
   */
  enforcement?: 'record' | 'refuse';
}): Promise<NotarizedEvent> {
  // v12-20-06: retired names are replayed, never written.
  if (isRetiredEventType(params.eventType)) {
    throw new Error(
      `Event type is deprecated: ${params.eventType} — write ${canonicalEventType(params.eventType)} instead`,
    );
  }
  const custody = resolveEventCustody(params.eventType);
  if (custody.custodyStatus === 'undeclared') {
    if (params.enforcement === 'refuse') {
      throw new Error(`Event type is not MDM-registered: ${params.eventType}`);
    }
    recordEventEmission(params.eventType, params.txId, params.emitterDomain);
  }
  const unsigned = {
    txId: params.txId,
    timestamp: params.timestamp ?? new Date().toISOString(),
    eventType: params.eventType,
    sourceAddress: params.sourceAddress,
    targetAddress: params.targetAddress,
    eventMdmAddress: custody.eventMdmAddress,
    eventRegistrationTxId: custody.eventRegistrationTxId,
    custodyStatus: custody.custodyStatus,
    payload: {
      ...(params.payload ?? {}),
      governingPrinciple: params.governingPrinciple,
    },
  };
  return { ...unsigned, txHash: await sha256Hex(canonicalizeEvent(unsigned)) };
}
