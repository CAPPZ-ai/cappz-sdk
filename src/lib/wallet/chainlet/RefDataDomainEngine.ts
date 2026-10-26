/**
 * RefData Domain Engine (Phase 1A)
 * 
 * HD address derivation engine for reference data domains, values, and versions.
 * Competes with TIBCO EBX / Orchestra Networks / Informatica MDM.
 * 
 * HD Address Tree:
 *   Standard Root (m/44'/coinType'/standardIdx')
 *     └── Domain (m/.../domainIdx')
 *           ├── Values Branch (m/.../domainIdx'/0')
 *           │     ├── 0' → USD
 *           │     ├── 1' → JPY
 *           │     └── 2' → EUR
 *           └── Versions Branch (m/.../domainIdx'/1')
 *                 ├── 0' → v1-00
 *                 └── 1' → v1-01
 */

import type {
  RefDataStandard,
  RefDataDomain,
  RefDataValue,
  RefDataVersion,
  RefDataEvent,
  RefDataEventType,
} from './types';
import { RefDataResolutionError, HDDerivationError } from './errors';

// ─── Constants ───

/** XRPL coin type per SLIP-0044 */
const XRPL_COIN_TYPE = 144;

/** Branch indices within a domain */
const VALUES_BRANCH = 0;
const VERSIONS_BRANCH = 1;

/** Standard root indices */
const STANDARD_INDICES: Record<RefDataStandard, number> = {
  ISO20022: 0,
  FpML: 1,
  FIX: 2,
  Custom: 3,
};

// ─── HD Derivation Helpers ───

export function deriveStandardRootPath(standard: RefDataStandard): string {
  return `m/44'/${XRPL_COIN_TYPE}'/${STANDARD_INDICES[standard]}'`;
}

export function deriveDomainPath(standard: RefDataStandard, domainIndex: number): string {
  if (domainIndex < 0) {
    throw new HDDerivationError(`Invalid domain index: ${domainIndex}`, `${standard}/${domainIndex}`);
  }
  return `${deriveStandardRootPath(standard)}/${domainIndex}'`;
}

export function deriveValuePath(
  standard: RefDataStandard,
  domainIndex: number,
  valueIndex: number
): string {
  if (valueIndex < 0) {
    throw new HDDerivationError(`Invalid value index: ${valueIndex}`, `${standard}/${domainIndex}/${valueIndex}`);
  }
  return `${deriveDomainPath(standard, domainIndex)}/${VALUES_BRANCH}'/${valueIndex}'`;
}

export function deriveVersionPath(
  standard: RefDataStandard,
  domainIndex: number,
  versionIndex: number
): string {
  if (versionIndex < 0) {
    throw new HDDerivationError(`Invalid version index: ${versionIndex}`, `${standard}/${domainIndex}/${versionIndex}`);
  }
  return `${deriveDomainPath(standard, domainIndex)}/${VERSIONS_BRANCH}'/${versionIndex}'`;
}

/** Generate a deterministic HD address string from a derivation path */
export function hdPathToAddress(path: string): string {
  if (!path || !path.startsWith('m/')) {
    throw new HDDerivationError(`Invalid HD path format: ${path}`, path);
  }
  // Deterministic hash of the path — production would use BIP32
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    hash = ((hash << 5) - hash) + path.charCodeAt(i);
    hash = hash & hash;
  }
  const hex = Math.abs(hash).toString(16).padStart(16, '0');
  return `r${hex.slice(0, 20)}`;
}

/** FNV-1a hash for refdata cache indexing */
function computeRefdataHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ─── RefData Domain Engine ───

export class RefDataDomainEngine {
  private domains: Map<string, RefDataDomain> = new Map();
  private domainCounter: Map<RefDataStandard, number> = new Map();
  private valueCounters: Map<string, number> = new Map();
  private versionCounters: Map<string, number> = new Map();

  constructor() {
    for (const std of Object.keys(STANDARD_INDICES) as RefDataStandard[]) {
      this.domainCounter.set(std, 0);
    }
  }

  /** Get the HD root path for a standard */
  getStandardRoot(standard: RefDataStandard): string {
    return deriveStandardRootPath(standard);
  }

  /** Register a new domain under a standard */
  createDomain(
    standard: RefDataStandard,
    domainCode: string,
    displayName: string,
    options?: {
      description?: string;
      sourceUri?: string;
      parentDomainId?: string;
    }
  ): { domain: RefDataDomain; event: RefDataEvent } {
    try {
      const domainIndex = this.domainCounter.get(standard) ?? 0;
      this.domainCounter.set(standard, domainIndex + 1);

      const hdDerivationPath = deriveDomainPath(standard, domainIndex);
      const hdRootAddress = hdPathToAddress(hdDerivationPath);
      const now = new Date().toISOString();
      const domainId = `${standard}:${domainCode}`;

      const domain: RefDataDomain = {
        id: domainId,
        standard,
        domainCode,
        displayName,
        description: options?.description,
        hdRootAddress,
        hdDerivationPath,
        sourceUri: options?.sourceUri,
        parentDomainId: options?.parentDomainId,
        createdAt: now,
        updatedAt: now,
      };

      this.domains.set(domainId, domain);
      this.valueCounters.set(domainId, 0);
      this.versionCounters.set(domainId, 0);

      const event = this.createEvent(
        'ListDomainCreated',
        hdRootAddress,
        deriveStandardRootPath(standard),
        { refdataCode: domainCode }
      );

      return { domain, event };
    } catch (err) {
      if (err instanceof HDDerivationError) throw err;
      throw new RefDataResolutionError('domain', `${standard}:${domainCode}`, err instanceof Error ? err : undefined);
    }
  }

  /** Create a permanently-addressed value within a domain */
  createValue(
    domainId: string,
    code: string,
    displayName: string,
    options?: {
      definition?: string;
      sourceMetadata?: Record<string, unknown>;
    }
  ): { value: RefDataValue; event: RefDataEvent } {
    const domain = this.domains.get(domainId);
    if (!domain) throw new RefDataResolutionError('domain', domainId);

    try {
      const valueIndex = this.valueCounters.get(domainId) ?? 0;
      this.valueCounters.set(domainId, valueIndex + 1);

      const domainIndex = this.getDomainIndex(domain);
      const hdPath = deriveValuePath(domain.standard, domainIndex, valueIndex);
      const hdAddress = hdPathToAddress(hdPath);
      const now = new Date().toISOString();

      const value: RefDataValue = {
        id: `${domainId}:${code}`,
        domainId,
        code,
        displayName,
        definition: options?.definition,
        hdAddress,
        hdIndex: valueIndex,
        status: 'active',
        sourceMetadata: options?.sourceMetadata,
        createdAt: now,
      };

      const refdataHash = computeRefdataHash(`${domainId}:${code}:${hdAddress}`);
      const event = this.createEvent(
        'ListValueCreated',
        domain.hdRootAddress,
        hdAddress,
        { refdataCode: code, refdataSha256: refdataHash }
      );

      return { value, event };
    } catch (err) {
      if (err instanceof HDDerivationError || err instanceof RefDataResolutionError) throw err;
      throw new RefDataResolutionError('value', `${domainId}:${code}`, err instanceof Error ? err : undefined);
    }
  }

  /** Create a new version of a domain's value list */
  createVersion(
    domainId: string,
    versionCode: string,
    options?: {
      priorVersionId?: string;
      supersedesTx?: string;
    }
  ): { version: RefDataVersion; events: RefDataEvent[] } {
    const domain = this.domains.get(domainId);
    if (!domain) throw new RefDataResolutionError('domain', domainId);

    try {
      const versionIndex = this.versionCounters.get(domainId) ?? 0;
      this.versionCounters.set(domainId, versionIndex + 1);

      const domainIndex = this.getDomainIndex(domain);
      const hdPath = deriveVersionPath(domain.standard, domainIndex, versionIndex);
      const hdAddress = hdPathToAddress(hdPath);
      const now = new Date().toISOString();

      const version: RefDataVersion = {
        id: `${domainId}:v${versionIndex}`,
        domainId,
        versionCode,
        hdAddress,
        hdIndex: versionIndex,
        supersedesTx: options?.supersedesTx,
        priorVersionId: options?.priorVersionId,
        publishedAt: now,
        createdAt: now,
      };

      const refdataHash = computeRefdataHash(`${domainId}:${versionCode}:${hdAddress}`);
      const events: RefDataEvent[] = [
        this.createEvent(
          'ListVersionCreated',
          domain.hdRootAddress,
          hdAddress,
          { refdataCode: versionCode, refdataSha256: refdataHash }
        ),
      ];

      if (options?.priorVersionId) {
        events.push(
          this.createEvent('ListVersioned', hdAddress, domain.hdRootAddress, {
            supersedesTx: options.supersedesTx,
            orgnlMsgId: options.priorVersionId,
          })
        );
      }

      return { version, events };
    } catch (err) {
      if (err instanceof HDDerivationError || err instanceof RefDataResolutionError) throw err;
      throw new RefDataResolutionError('version', `${domainId}:${versionCode}`, err instanceof Error ? err : undefined);
    }
  }

  /** Create a cross-standard value mapping */
  createValueMapping(
    sourceValueAddress: string,
    targetValueAddress: string
  ): RefDataEvent {
    return this.createEvent('ValueMappingCreated', sourceValueAddress, targetValueAddress);
  }

  /** Terminate a cross-standard value mapping */
  terminateValueMapping(
    sourceValueAddress: string,
    targetValueAddress: string,
    originalMsgId: string
  ): RefDataEvent {
    return this.createEvent('ValueMappingTerminated', sourceValueAddress, targetValueAddress, {
      orgnlMsgId: originalMsgId,
    });
  }

  // ─── Helpers ───

  private getDomainIndex(domain: RefDataDomain): number {
    const parts = domain.hdDerivationPath.split('/');
    const lastPart = parts[parts.length - 1];
    const parsed = parseInt(lastPart.replace("'", ''), 10);
    if (isNaN(parsed)) {
      throw new HDDerivationError(
        `Cannot parse domain index from path: ${domain.hdDerivationPath}`,
        domain.hdDerivationPath
      );
    }
    return parsed;
  }

  private createEvent(
    eventType: RefDataEventType,
    sourceAddress: string,
    targetAddress: string,
    overrides?: Partial<RefDataEvent>
  ): RefDataEvent {
    const now = new Date().toISOString();
    const msgId = `${eventType}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    return {
      eventType,
      txHash: `sim_${msgId}`,
      timestamp: now,
      sourceAddress,
      targetAddress,
      msgId,
      creDtTm: now,
      ...overrides,
    };
  }

  /** Get a registered domain by ID — throws if not found */
  getDomain(domainId: string): RefDataDomain {
    const domain = this.domains.get(domainId);
    if (!domain) throw new RefDataResolutionError('domain', domainId);
    return domain;
  }

  /** List all registered domains, optionally filtered by standard */
  listDomains(standard?: RefDataStandard): RefDataDomain[] {
    const all = Array.from(this.domains.values());
    return standard ? all.filter(d => d.standard === standard) : all;
  }
}
