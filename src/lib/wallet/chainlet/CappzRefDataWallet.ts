/**
 * CappzRefDataWallet
 * 
 * Thin facade over CappzDataDomain for backward-compatible role management.
 * Delegates all HD addressing, TX factories, and cache lookups to the shared data domain.
 * Also loads all five canonical cappz: domains on construction.
 */

import { CappzDataDomain, type CappzDomainTx, type ResolvedValue } from './CappzDataDomain';
import { CAPPZ_DOMAINS, WALLET_ROLES_DOMAIN } from './cappzDomains';
import { RefDataResolutionError, ChainletError } from './errors';

// ─── Re-export types as role-specific aliases ───

export type WalletRoleTx = CappzDomainTx;

export interface RoleDefinition {
  code: string;
  displayName: string;
  hdIndex: number;
}

// ─── CappzRefDataWallet ───

export class CappzRefDataWallet {
  /** Shared data domain engine — all five cappz: domains */
  readonly dataDomain: CappzDataDomain;
  /** Root HD address for the cappz: namespace */
  readonly rootAddress: string;
  /** Domain HD address for WalletRoles */
  readonly walletRolesDomainAddress: string;

  constructor() {
    this.dataDomain = new CappzDataDomain();

    // Load all canonical domains
    for (const domain of CAPPZ_DOMAINS) {
      try {
        this.dataDomain.registerDomain(domain);
      } catch (err) {
        throw new ChainletError(
          `Failed to initialize cappz: domain ${domain.domainCode}`,
          'DOMAIN_INIT_FAILED',
          'engine',
          err instanceof Error ? err : undefined
        );
      }
    }

    this.rootAddress = this.dataDomain.rootAddress;
    this.walletRolesDomainAddress = this.dataDomain.getDomain(WALLET_ROLES_DOMAIN.domainCode).hdAddress;
  }

  // ─── Role-Specific Convenience (delegates to data domain) ───

  /** Resolve the permanent HD address for a role code */
  resolveRoleAddress(roleCode: string): string {
    return this.dataDomain.resolveAddress(WALLET_ROLES_DOMAIN.domainCode, roleCode);
  }

  /** Get role definition by code */
  getRoleDefinition(roleCode: string): RoleDefinition {
    const v = this.dataDomain.resolveValue(WALLET_ROLES_DOMAIN.domainCode, roleCode);
    return { code: v.code, displayName: v.displayName, hdIndex: v.hdIndex };
  }

  /** List all registered role addresses */
  listRoles(): Array<RoleDefinition & { hdAddress: string }> {
    return this.dataDomain.listValues(WALLET_ROLES_DOMAIN.domainCode).map(v => ({
      code: v.code,
      displayName: v.displayName,
      hdIndex: v.hdIndex,
      hdAddress: v.hdAddress,
    }));
  }

  /** Reverse lookup: HD address → role code */
  resolveRoleCode(hdAddress: string): string {
    return this.dataDomain.resolveCode(WALLET_ROLES_DOMAIN.domainCode, hdAddress);
  }

  // ─── Role TX Factories (delegate to data domain) ───

  /** Emit a WalletRoleCreated TX */
  createRoleAssignmentTx(
    walletAddress: string,
    roleCode: string,
    configSnapshot?: Record<string, unknown>
  ): WalletRoleTx {
    return this.dataDomain.createValueTx(
      walletAddress,
      WALLET_ROLES_DOMAIN.domainCode,
      roleCode,
      configSnapshot
    );
  }

  /** Emit a WalletRoleDeprecated TX correlated to the original creation TX */
  createRoleDeprecationTx(
    walletAddress: string,
    roleCode: string,
    originalTx: WalletRoleTx
  ): WalletRoleTx {
    return this.dataDomain.createDeprecationTx(
      walletAddress,
      WALLET_ROLES_DOMAIN.domainCode,
      roleCode,
      originalTx
    );
  }

  // ─── Generic Domain Access (expose full data domain) ───

  /** Resolve any domain value address */
  resolveAddress(domainCode: string, valueCode: string): string {
    return this.dataDomain.resolveAddress(domainCode, valueCode);
  }

  /** Resolve any domain value */
  resolveValue(domainCode: string, valueCode: string): ResolvedValue {
    return this.dataDomain.resolveValue(domainCode, valueCode);
  }

  /** Reverse lookup any address */
  resolveByAddress(hdAddress: string): ResolvedValue {
    return this.dataDomain.resolveByAddress(hdAddress);
  }

  // ─── TX Cache Lookups (shared across all domains) ───

  lookupTxByMsgId(msgId: string): CappzDomainTx | undefined {
    return this.dataDomain.lookupTxByMsgId(msgId);
  }

  lookupTxByCode(domainCode: string, valueCode: string): readonly CappzDomainTx[] {
    return this.dataDomain.lookupTxByCode(domainCode, valueCode);
  }

  lookupTxByHash(hash: string): readonly CappzDomainTx[] {
    return this.dataDomain.lookupTxByHash(hash);
  }

  lookupTxByTargetAddress(address: string): readonly CappzDomainTx[] {
    return this.dataDomain.lookupTxByTargetAddress(address);
  }

  lookupTxByDomain(domainCode: string): readonly CappzDomainTx[] {
    return this.dataDomain.lookupTxByDomain(domainCode);
  }
}

/** Singleton instance — initializes all five cappz: domains */
export const cappzRefDataWallet = new CappzRefDataWallet();
