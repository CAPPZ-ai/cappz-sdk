/**
 * CappzDataDomain
 * 
 * Generic, extensible HD data domain engine under the `cappz:` namespace.
 * Every system concern (roles, errors, functions, rules) is a registered domain
 * with permanent HD addresses, lifecycle TX factories, and a shared TX cache.
 * 
 * No cloud. No registry. Pure local state derived from ledger replay.
 * 
 * HD Address Tree:
 *   cappz: Root (m/44'/144'/99')
 *     ├── Domain 0: WalletRoles
 *     ├── Domain 1: ValidationErrors    (reusable by clients/partners)
 *     ├── Domain 2: OperationalErrors   (internal function execution)
 *     ├── Domain 3: FunctionsEvents    (functions + event types with correlation)
 *     └── Domain 4: Rules              (on-chain validation rules)
 * 
 * Each domain:
 *     └── domainIdx'
 *           └── 0' (values branch)
 *                 ├── 0' → first value
 *                 ├── 1' → second value
 *                 └── ...
 * 
 * Lifecycle Functions:
 *   CreateDataDomain()              → DataDomainCreated TX
 *   DeprecateDataDomain()           → DataDomainDeprecated TX
 *   CreateDataDomainValue()         → DataDomainValueCreated TX (by-val)
 *   DeprecateDataDomainValue()      → DataDomainValueDeprecated TX
 *   CreateDataDomainValueRef()      → DataDomainValueRefCreated TX (by-ref)
 *   DeprecateDataDomainValueRef()   → DataDomainValueRefDeprecated TX (does NOT deprecate source)
 */

import { hdPathToAddress } from './RefDataDomainEngine';
import { RefDataResolutionError, ChainletError } from './errors';

// ─── Constants ───

const CAPPZ_NAMESPACE = 'cappz';
const XRPL_COIN_TYPE = 144;
const CAPPZ_STANDARD_INDEX = 99;
const VALUES_BRANCH = 0;

// ─── Types ───

/** Definition of a value within a domain */
export interface CappzValueDefinition {
  /** Short code (e.g. 'ARC', 'REFDATA_DOMAIN_NOT_FOUND', 'resolveRoleAddress') */
  code: string;
  /** Human-readable label */
  displayName: string;
  /** Permanent HD child index — append-only, never reused */
  hdIndex: number;
  /** Optional description */
  description?: string;
  /** Optional category/group within domain */
  category?: string;
}

/** Domain configuration */
export interface CappzDomainConfig {
  /** Unique domain code (e.g. 'WalletRoles', 'ValidationErrors') */
  domainCode: string;
  /** Human-readable name */
  displayName: string;
  /** HD domain index under cappz root — permanent */
  hdDomainIndex: number;
  /** Description */
  description?: string;
  /** Whether clients/partners can extend this domain at runtime */
  extensible: boolean;
  /** Canonical values — append-only seed set */
  values: readonly CappzValueDefinition[];
}

/** Resolved value with its HD address */
export interface ResolvedValue extends CappzValueDefinition {
  /** Permanent HD address */
  hdAddress: string;
  /** Domain this value belongs to */
  domainCode: string;
  /** FNV-1a hash for TX cache indexing */
  refdataHash: string;
}

/** A value reference linking a source value into a target domain */
export interface ValueReference {
  /** The domain holding the reference */
  refDomainCode: string;
  /** The source value being referenced */
  sourceValue: ResolvedValue;
  /** HD address of the reference slot in the target domain */
  refAddress: string;
  /** msgId of the DataDomainValueRefCreated TX */
  createdMsgId: string;
  /** Whether this reference is still active */
  isActive: boolean;
}

/** Lifecycle TX for any domain entity */
export interface CappzDomainTx {
  msgId: string;
  eventType: string;
  sourceAddress: string;
  targetAddress: string;
  domainCode: string;
  valueCode: string;
  creDtTm: string;
  txHash: string;
  orgnlMsgId?: string;
  supersedesTx?: string;
  refdataCode?: string;
  refdataSha256?: string;
  metadata?: Record<string, unknown>;
}

// ─── HD Path Helpers ───

function cappzRootPath(): string {
  return `m/44'/${XRPL_COIN_TYPE}'/${CAPPZ_STANDARD_INDEX}'`;
}

function domainPath(domainIndex: number): string {
  return `${cappzRootPath()}/${domainIndex}'`;
}

function valuePath(domainIndex: number, valueIndex: number): string {
  return `${domainPath(domainIndex)}/${VALUES_BRANCH}'/${valueIndex}'`;
}

/** FNV-1a hash for TX cache indexing */
function fnv1aHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Generate a unique message ID */
function generateMsgId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Shared TX Cache Index ───

class DomainTxCacheIndex {
  private byMsgId: Map<string, CappzDomainTx> = new Map();
  private byRefdataCode: Map<string, CappzDomainTx[]> = new Map();
  private byRefdataHash: Map<string, CappzDomainTx[]> = new Map();
  private byTargetAddress: Map<string, CappzDomainTx[]> = new Map();
  private byDomain: Map<string, CappzDomainTx[]> = new Map();

  index(tx: CappzDomainTx): void {
    this.byMsgId.set(tx.msgId, tx);

    if (tx.refdataCode) {
      const key = `${tx.domainCode}:${tx.refdataCode}`;
      const list = this.byRefdataCode.get(key) ?? [];
      list.push(tx);
      this.byRefdataCode.set(key, list);
    }
    if (tx.refdataSha256) {
      const list = this.byRefdataHash.get(tx.refdataSha256) ?? [];
      list.push(tx);
      this.byRefdataHash.set(tx.refdataSha256, list);
    }
    {
      const list = this.byTargetAddress.get(tx.targetAddress) ?? [];
      list.push(tx);
      this.byTargetAddress.set(tx.targetAddress, list);
    }
    {
      const list = this.byDomain.get(tx.domainCode) ?? [];
      list.push(tx);
      this.byDomain.set(tx.domainCode, list);
    }
  }

  lookupByMsgId(msgId: string): CappzDomainTx | undefined {
    return this.byMsgId.get(msgId);
  }

  lookupByCode(domainCode: string, valueCode: string): readonly CappzDomainTx[] {
    return this.byRefdataCode.get(`${domainCode}:${valueCode}`) ?? [];
  }

  lookupByHash(hash: string): readonly CappzDomainTx[] {
    return this.byRefdataHash.get(hash) ?? [];
  }

  lookupByTargetAddress(address: string): readonly CappzDomainTx[] {
    return this.byTargetAddress.get(address) ?? [];
  }

  lookupByDomain(domainCode: string): readonly CappzDomainTx[] {
    return this.byDomain.get(domainCode) ?? [];
  }
}

// ─── Domain State ───

interface DomainState {
  config: CappzDomainConfig;
  hdAddress: string;
  values: Map<string, ResolvedValue>;
  addressToCode: Map<string, string>;
  /** Next available HD index for runtime-added values */
  nextValueIndex: number;
  /** Whether this domain has been deprecated */
  isDeprecated: boolean;
  /** Value references (by-ref mappings from other domains) */
  valueRefs: Map<string, ValueReference>;
}

// ─── CappzDataDomain ───

export class CappzDataDomain {
  readonly rootAddress: string;

  /** Domain code → resolved domain state */
  private domains: Map<string, DomainState> = new Map();

  /** Shared TX cache across all domains */
  private txCache: DomainTxCacheIndex = new DomainTxCacheIndex();

  /** Next available domain index for runtime-created domains */
  private nextDomainIndex: number = 0;

  constructor() {
    this.rootAddress = hdPathToAddress(cappzRootPath());
  }

  // ─── Domain Loading (canonical seed data) ───

  /** Load a domain with its canonical value set (called at init) */
  registerDomain(config: CappzDomainConfig): void {
    if (this.domains.has(config.domainCode)) {
      throw new ChainletError(
        `Domain already loaded: ${config.domainCode}`,
        'DOMAIN_ALREADY_LOADED',
        'engine'
      );
    }

    try {
      const hdAddress = hdPathToAddress(domainPath(config.hdDomainIndex));
      const values = new Map<string, ResolvedValue>();
      const addressToCode = new Map<string, string>();
      let maxIndex = -1;

      for (const def of config.values) {
        const path = valuePath(config.hdDomainIndex, def.hdIndex);
        const addr = hdPathToAddress(path);
        const refdataHash = fnv1aHash(`${config.domainCode}:${def.code}:${addr}`);

        const resolved: ResolvedValue = {
          ...def,
          hdAddress: addr,
          domainCode: config.domainCode,
          refdataHash,
        };

        values.set(def.code, resolved);
        addressToCode.set(addr, def.code);
        if (def.hdIndex > maxIndex) maxIndex = def.hdIndex;
      }

      // Track highest domain index for runtime domain creation
      if (config.hdDomainIndex >= this.nextDomainIndex) {
        this.nextDomainIndex = config.hdDomainIndex + 1;
      }

      this.domains.set(config.domainCode, {
        config,
        hdAddress,
        values,
        addressToCode,
        nextValueIndex: maxIndex + 1,
        isDeprecated: false,
        valueRefs: new Map(),
      });
    } catch (err) {
      throw new ChainletError(
        `Failed to load domain: ${config.domainCode}`,
        'DOMAIN_LOAD_FAILED',
        'engine',
        err instanceof Error ? err : undefined
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  LIFECYCLE FUNCTION 1: CreateDataDomain
  //  Emits: DataDomainCreated TX
  // ═══════════════════════════════════════════════════════════════════

  /** Create a new data domain at runtime. Returns DataDomainCreated TX. */
  CreateDataDomain(
    sourceAddress: string,
    domainCode: string,
    displayName: string,
    options?: { description?: string; extensible?: boolean }
  ): CappzDomainTx {
    if (this.domains.has(domainCode)) {
      throw new ChainletError(
        `Domain already exists: ${domainCode}`,
        'DOMAIN_ALREADY_EXISTS',
        'engine'
      );
    }

    const hdDomainIndex = this.nextDomainIndex++;
    const config: CappzDomainConfig = {
      domainCode,
      displayName,
      hdDomainIndex,
      description: options?.description,
      extensible: options?.extensible ?? true,
      values: [],
    };

    const hdAddress = hdPathToAddress(domainPath(hdDomainIndex));

    this.domains.set(domainCode, {
      config,
      hdAddress,
      values: new Map(),
      addressToCode: new Map(),
      nextValueIndex: 0,
      isDeprecated: false,
      valueRefs: new Map(),
    });

    const msgId = generateMsgId('DataDomainCreated');
    const now = new Date().toISOString();
    const tx: CappzDomainTx = {
      msgId,
      eventType: `${CAPPZ_NAMESPACE}:DataDomainCreated`,
      sourceAddress,
      targetAddress: hdAddress,
      domainCode,
      valueCode: domainCode,
      creDtTm: now,
      txHash: `sim_${msgId}`,
      refdataCode: domainCode,
      refdataSha256: fnv1aHash(`domain:${domainCode}:${hdAddress}`),
      metadata: { displayName, ...options },
    };

    this.txCache.index(tx);
    return tx;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  LIFECYCLE FUNCTION 2: DeprecateDataDomain
  //  Emits: DataDomainDeprecated TX
  // ═══════════════════════════════════════════════════════════════════

  /** Deprecate an existing data domain. Correlated to its creation TX. */
  DeprecateDataDomain(
    sourceAddress: string,
    domainCode: string,
    originalTx: CappzDomainTx
  ): CappzDomainTx {
    const d = this.domains.get(domainCode);
    if (!d) throw new RefDataResolutionError('domain', domainCode);
    if (d.isDeprecated) {
      throw new ChainletError(
        `Domain already deprecated: ${domainCode}`,
        'DOMAIN_ALREADY_DEPRECATED',
        'engine'
      );
    }

    d.isDeprecated = true;

    const msgId = generateMsgId('DataDomainDeprecated');
    const now = new Date().toISOString();
    const tx: CappzDomainTx = {
      msgId,
      eventType: `${CAPPZ_NAMESPACE}:DataDomainDeprecated`,
      sourceAddress,
      targetAddress: d.hdAddress,
      domainCode,
      valueCode: domainCode,
      creDtTm: now,
      txHash: `sim_${msgId}`,
      orgnlMsgId: originalTx.msgId,
      supersedesTx: originalTx.txHash,
      refdataCode: domainCode,
      refdataSha256: fnv1aHash(`domain:${domainCode}:${d.hdAddress}`),
    };

    this.txCache.index(tx);
    return tx;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  LIFECYCLE FUNCTION 3: CreateDataDomainValue (by-val)
  //  Emits: DataDomainValueCreated TX
  // ═══════════════════════════════════════════════════════════════════

  /** Create a new value in a domain by direct definition. */
  CreateDataDomainValue(
    sourceAddress: string,
    domainCode: string,
    valueCode: string,
    displayName: string,
    options?: { description?: string; category?: string; metadata?: Record<string, unknown> }
  ): CappzDomainTx {
    const d = this.domains.get(domainCode);
    if (!d) throw new RefDataResolutionError('domain', domainCode);
    if (d.isDeprecated) {
      throw new ChainletError(`Cannot add value to deprecated domain: ${domainCode}`, 'DOMAIN_DEPRECATED', 'engine');
    }
    if (!d.config.extensible && d.config.values.length > 0) {
      throw new ChainletError(`Domain is not extensible: ${domainCode}`, 'DOMAIN_NOT_EXTENSIBLE', 'engine');
    }
    if (d.values.has(valueCode)) {
      throw new ChainletError(`Value already exists: ${domainCode}:${valueCode}`, 'VALUE_ALREADY_EXISTS', 'engine');
    }

    const hdIndex = d.nextValueIndex++;
    const path = valuePath(d.config.hdDomainIndex, hdIndex);
    const addr = hdPathToAddress(path);
    const refdataHash = fnv1aHash(`${domainCode}:${valueCode}:${addr}`);

    const resolved: ResolvedValue = {
      code: valueCode,
      displayName,
      hdIndex,
      description: options?.description,
      category: options?.category,
      hdAddress: addr,
      domainCode,
      refdataHash,
    };

    d.values.set(valueCode, resolved);
    d.addressToCode.set(addr, valueCode);

    const msgId = generateMsgId('DataDomainValueCreated');
    const now = new Date().toISOString();
    const tx: CappzDomainTx = {
      msgId,
      eventType: `${CAPPZ_NAMESPACE}:DataDomainValueCreated`,
      sourceAddress,
      targetAddress: addr,
      domainCode,
      valueCode,
      creDtTm: now,
      txHash: `sim_${msgId}`,
      refdataCode: valueCode,
      refdataSha256: refdataHash,
      metadata: { displayName, ...options?.metadata },
    };

    this.txCache.index(tx);
    return tx;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  LIFECYCLE FUNCTION 4: DeprecateDataDomainValue
  //  Emits: DataDomainValueDeprecated TX
  // ═══════════════════════════════════════════════════════════════════

  /** Deprecate a value. Accepts domain+value code strings OR the value's HD address. */
  DeprecateDataDomainValue(
    sourceAddress: string,
    domainCode: string,
    valueCode: string,
    originalTx: CappzDomainTx
  ): CappzDomainTx {
    const resolved = this.resolveValue(domainCode, valueCode);

    const msgId = generateMsgId('DataDomainValueDeprecated');
    const now = new Date().toISOString();
    const tx: CappzDomainTx = {
      msgId,
      eventType: `${CAPPZ_NAMESPACE}:DataDomainValueDeprecated`,
      sourceAddress,
      targetAddress: resolved.hdAddress,
      domainCode,
      valueCode,
      creDtTm: now,
      txHash: `sim_${msgId}`,
      orgnlMsgId: originalTx.msgId,
      supersedesTx: originalTx.txHash,
      refdataCode: valueCode,
      refdataSha256: resolved.refdataHash,
    };

    this.txCache.index(tx);
    return tx;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  LIFECYCLE FUNCTION 5: CreateDataDomainValueRef (by-ref)
  //  Emits: DataDomainValueRefCreated TX
  //  Links an existing value from another domain into the target domain
  // ═══════════════════════════════════════════════════════════════════

  /** Create a reference to an existing value from another domain. */
  CreateDataDomainValueRef(
    sourceAddress: string,
    targetDomainCode: string,
    sourceDomainCode: string,
    sourceValueCode: string,
    metadata?: Record<string, unknown>
  ): CappzDomainTx {
    const targetDomain = this.domains.get(targetDomainCode);
    if (!targetDomain) throw new RefDataResolutionError('domain', targetDomainCode);
    if (targetDomain.isDeprecated) {
      throw new ChainletError(`Cannot add ref to deprecated domain: ${targetDomainCode}`, 'DOMAIN_DEPRECATED', 'engine');
    }

    // Resolve the source value — must exist
    const sourceValue = this.resolveValue(sourceDomainCode, sourceValueCode);

    // Allocate an HD slot in the target domain for this reference
    const refIndex = targetDomain.nextValueIndex++;
    const refPath = valuePath(targetDomain.config.hdDomainIndex, refIndex);
    const refAddress = hdPathToAddress(refPath);
    const refKey = `${sourceDomainCode}:${sourceValueCode}`;

    if (targetDomain.valueRefs.has(refKey)) {
      throw new ChainletError(
        `Value reference already exists: ${refKey} in ${targetDomainCode}`,
        'VALUE_REF_ALREADY_EXISTS',
        'engine'
      );
    }

    const msgId = generateMsgId('DataDomainValueRefCreated');
    const now = new Date().toISOString();

    targetDomain.valueRefs.set(refKey, {
      refDomainCode: targetDomainCode,
      sourceValue,
      refAddress,
      createdMsgId: msgId,
      isActive: true,
    });

    const tx: CappzDomainTx = {
      msgId,
      eventType: `${CAPPZ_NAMESPACE}:DataDomainValueRefCreated`,
      sourceAddress,
      targetAddress: refAddress,
      domainCode: targetDomainCode,
      valueCode: sourceValueCode,
      creDtTm: now,
      txHash: `sim_${msgId}`,
      refdataCode: sourceValueCode,
      refdataSha256: sourceValue.refdataHash,
      metadata: {
        sourceDomainCode,
        sourceValueAddress: sourceValue.hdAddress,
        ...metadata,
      },
    };

    this.txCache.index(tx);
    return tx;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  LIFECYCLE FUNCTION 6: DeprecateDataDomainValueRef (by-ref)
  //  Emits: DataDomainValueRefDeprecated TX
  //  Does NOT deprecate the source value — only the reference link
  // ═══════════════════════════════════════════════════════════════════

  /** Deprecate a value reference. Does NOT affect the source value. */
  DeprecateDataDomainValueRef(
    sourceAddress: string,
    targetDomainCode: string,
    sourceDomainCode: string,
    sourceValueCode: string,
    originalTx: CappzDomainTx
  ): CappzDomainTx {
    const targetDomain = this.domains.get(targetDomainCode);
    if (!targetDomain) throw new RefDataResolutionError('domain', targetDomainCode);

    const refKey = `${sourceDomainCode}:${sourceValueCode}`;
    const ref = targetDomain.valueRefs.get(refKey);
    if (!ref) {
      throw new ChainletError(
        `Value reference not found: ${refKey} in ${targetDomainCode}`,
        'VALUE_REF_NOT_FOUND',
        'engine'
      );
    }
    if (!ref.isActive) {
      throw new ChainletError(
        `Value reference already deprecated: ${refKey} in ${targetDomainCode}`,
        'VALUE_REF_ALREADY_DEPRECATED',
        'engine'
      );
    }

    ref.isActive = false;

    const msgId = generateMsgId('DataDomainValueRefDeprecated');
    const now = new Date().toISOString();
    const tx: CappzDomainTx = {
      msgId,
      eventType: `${CAPPZ_NAMESPACE}:DataDomainValueRefDeprecated`,
      sourceAddress,
      targetAddress: ref.refAddress,
      domainCode: targetDomainCode,
      valueCode: sourceValueCode,
      creDtTm: now,
      txHash: `sim_${msgId}`,
      orgnlMsgId: originalTx.msgId,
      supersedesTx: originalTx.txHash,
      refdataCode: sourceValueCode,
      refdataSha256: ref.sourceValue.refdataHash,
      metadata: {
        sourceDomainCode,
        sourceValueAddress: ref.sourceValue.hdAddress,
        note: 'Reference deprecated — source value remains active',
      },
    };

    this.txCache.index(tx);
    return tx;
  }

  // ─── Resolution (throws, never returns undefined) ───

  /** Get domain metadata — throws if not found */
  getDomain(domainCode: string): { config: CappzDomainConfig; hdAddress: string } {
    const d = this.domains.get(domainCode);
    if (!d) throw new RefDataResolutionError('domain', domainCode);
    return { config: d.config, hdAddress: d.hdAddress };
  }

  /** Resolve a value's HD address — throws if not found */
  resolveAddress(domainCode: string, valueCode: string): string {
    const d = this.domains.get(domainCode);
    if (!d) throw new RefDataResolutionError('domain', domainCode);
    const v = d.values.get(valueCode);
    if (!v) throw new RefDataResolutionError('value', `${domainCode}:${valueCode}`);
    return v.hdAddress;
  }

  /** Get full resolved value — throws if not found */
  resolveValue(domainCode: string, valueCode: string): ResolvedValue {
    const d = this.domains.get(domainCode);
    if (!d) throw new RefDataResolutionError('domain', domainCode);
    const v = d.values.get(valueCode);
    if (!v) throw new RefDataResolutionError('value', `${domainCode}:${valueCode}`);
    return v;
  }

  /** Reverse lookup: HD address → value code — throws if not found */
  resolveCode(domainCode: string, hdAddress: string): string {
    const d = this.domains.get(domainCode);
    if (!d) throw new RefDataResolutionError('domain', domainCode);
    const code = d.addressToCode.get(hdAddress);
    if (!code) throw new RefDataResolutionError('value', `${domainCode}@${hdAddress}`);
    return code;
  }

  /** Reverse lookup across all domains: HD address → ResolvedValue — throws if not found */
  resolveByAddress(hdAddress: string): ResolvedValue {
    for (const d of this.domains.values()) {
      const code = d.addressToCode.get(hdAddress);
      if (code) {
        const v = d.values.get(code);
        if (v) return v;
      }
    }
    throw new RefDataResolutionError('value', hdAddress);
  }

  /** List all values in a domain */
  listValues(domainCode: string): ResolvedValue[] {
    const d = this.domains.get(domainCode);
    if (!d) throw new RefDataResolutionError('domain', domainCode);
    return Array.from(d.values.values());
  }

  /** List all value references in a domain */
  listValueRefs(domainCode: string): ValueReference[] {
    const d = this.domains.get(domainCode);
    if (!d) throw new RefDataResolutionError('domain', domainCode);
    return Array.from(d.valueRefs.values());
  }

  /** List all loaded domains */
  listDomains(): Array<{ domainCode: string; displayName: string; hdAddress: string; valueCount: number; isDeprecated: boolean }> {
    return Array.from(this.domains.entries()).map(([code, d]) => ({
      domainCode: code,
      displayName: d.config.displayName,
      hdAddress: d.hdAddress,
      valueCount: d.values.size,
      isDeprecated: d.isDeprecated,
    }));
  }

  // ─── Legacy TX Factories (backward compat for CappzRefDataWallet) ───

  /** Emit a Created TX for any domain value (legacy — prefer CreateDataDomainValue) */
  createValueTx(
    sourceAddress: string,
    domainCode: string,
    valueCode: string,
    metadata?: Record<string, unknown>
  ): CappzDomainTx {
    try {
      const resolved = this.resolveValue(domainCode, valueCode);
      const now = new Date().toISOString();
      const eventSuffix = this.getDomain(domainCode).config.domainCode.replace(/s$/, '');
      const msgId = generateMsgId(`${eventSuffix}Created`);

      const tx: CappzDomainTx = {
        msgId,
        eventType: `${CAPPZ_NAMESPACE}:${eventSuffix}Created`,
        sourceAddress,
        targetAddress: resolved.hdAddress,
        domainCode,
        valueCode,
        creDtTm: now,
        txHash: `sim_${msgId}`,
        refdataCode: valueCode,
        refdataSha256: resolved.refdataHash,
        metadata,
      };

      this.txCache.index(tx);
      return tx;
    } catch (err) {
      if (err instanceof ChainletError) throw err;
      throw new ChainletError(
        `Failed to create TX for ${domainCode}:${valueCode}`,
        'DOMAIN_TX_CREATE_FAILED',
        'engine',
        err instanceof Error ? err : undefined
      );
    }
  }

  /** Emit a Deprecated TX correlated to the original creation TX */
  createDeprecationTx(
    sourceAddress: string,
    domainCode: string,
    valueCode: string,
    originalTx: CappzDomainTx
  ): CappzDomainTx {
    try {
      const resolved = this.resolveValue(domainCode, valueCode);
      const now = new Date().toISOString();
      const eventSuffix = this.getDomain(domainCode).config.domainCode.replace(/s$/, '');
      const msgId = generateMsgId(`${eventSuffix}Deprecated`);

      const tx: CappzDomainTx = {
        msgId,
        eventType: `${CAPPZ_NAMESPACE}:${eventSuffix}Deprecated`,
        sourceAddress,
        targetAddress: resolved.hdAddress,
        domainCode,
        valueCode,
        creDtTm: now,
        txHash: `sim_${msgId}`,
        orgnlMsgId: originalTx.msgId,
        supersedesTx: originalTx.txHash,
        refdataCode: valueCode,
        refdataSha256: resolved.refdataHash,
      };

      this.txCache.index(tx);
      return tx;
    } catch (err) {
      if (err instanceof ChainletError) throw err;
      throw new ChainletError(
        `Failed to deprecate TX for ${domainCode}:${valueCode}`,
        'DOMAIN_TX_DEPRECATE_FAILED',
        'engine',
        err instanceof Error ? err : undefined
      );
    }
  }

  // ─── TX Cache Lookups (O(1)) ───

  lookupTxByMsgId(msgId: string): CappzDomainTx | undefined {
    return this.txCache.lookupByMsgId(msgId);
  }

  lookupTxByCode(domainCode: string, valueCode: string): readonly CappzDomainTx[] {
    return this.txCache.lookupByCode(domainCode, valueCode);
  }

  lookupTxByHash(hash: string): readonly CappzDomainTx[] {
    return this.txCache.lookupByHash(hash);
  }

  lookupTxByTargetAddress(address: string): readonly CappzDomainTx[] {
    return this.txCache.lookupByTargetAddress(address);
  }

  lookupTxByDomain(domainCode: string): readonly CappzDomainTx[] {
    return this.txCache.lookupByDomain(domainCode);
  }
}
