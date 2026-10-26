/**
 * CAPPZ Network Configuration — Client-side single source of truth.
 *
 * Mirrors supabase/functions/_shared/network-config.ts for client code.
 * All client-side XRPL address lookups resolve through this module.
 *
 * MDM Root: m/44'/144'/0'/cappz/config/network-addresses
 *
 * v15-06-00 — Testnet/Devnet issuer, treasury and service can be replaced by
 * site admins (test ledgers reset). The replayed admin-chain overrides
 * arrive with the public site state (`applyNetworkAddressOverrides`) and
 * win over the shipped defaults below; Mainnet always uses the defaults.
 */
import { isValidClassicAddress } from 'xrpl';
import type { NetworkAddressOverrides, NetworkAddressRole } from './networkTypes';

import type { CappzNetwork } from './networkTypes';
export type { CappzNetwork } from './networkTypes';

export interface NetworkAddresses {
  issuer: string;
  treasury: string;
  service: string;
  wsEndpoint: string;
  rpcEndpoint: string;
}

const NETWORK_REGISTRY: Record<CappzNetwork, NetworkAddresses> = {
  testnet: {
    issuer: 'rU6K7V3Po4snVhBBaU29sesqs2qTQJWDw1',
    treasury: 'rpR95n1iFkTqpoy1e878f4Z1pVHVtWKMNQ',
    service: 'rLHzPsX6oXkzU9rFpMiFyiVfXZ9k8jJ3rZ',
    wsEndpoint: 'wss://s.altnet.rippletest.net:51233',
    rpcEndpoint: 'https://s.altnet.rippletest.net:51234',
  },
  devnet: {
    issuer: 'rN7n7otQDd6FczFgLdlqtyMVrn3WkRxBPK',
    treasury: 'rDN4U8Xby5iLvqwS1mG8KxyMQhU3FyZ3yf',
    service: 'rJP4Z8xhqhzJjV8MvRnz3W2qQ7yKjS9tLm',
    wsEndpoint: 'wss://s.devnet.rippletest.net:51233',
    rpcEndpoint: 'https://s.devnet.rippletest.net:51234',
  },
  mainnet: {
    issuer: 'rMBcKBgMZFmVrSsJXubMUb2MpSxSLa6fTA',
    treasury: 'rUqPbiwe2Z5rj2AewokbFHCGQPtwjtzjHM',
    service: 'rNuKZnMUdb9FtJ1hGQYyXUmJ6Bk7RPbz4c',
    wsEndpoint: 'wss://xrplcluster.com',
    rpcEndpoint: 'https://xrplcluster.com',
  },
};

export const CAPPZ_CURRENCY_HEX = '434150505A000000000000000000000000000000';
export const CAPPZ_PER_XRP = 1000;
export const ANCHOR_BURN_ADDRESS = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';

let overrides: NetworkAddressOverrides = {};
const listeners = new Set<() => void>();

/** Apply admin-chain overrides replayed by admin-users (site-state). */
export function applyNetworkAddressOverrides(next: NetworkAddressOverrides | null | undefined): void {
  overrides = next ?? {};
  listeners.forEach((l) => l());
}

export function getNetworkAddressOverrides(): NetworkAddressOverrides {
  return overrides;
}

export function subscribeNetworkAddressOverrides(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The addresses shipped in code, ignoring admin overrides. */
export function resolveDefaultNetworkAddresses(network: CappzNetwork): NetworkAddresses {
  const addresses = NETWORK_REGISTRY[network];
  if (!addresses) throw new Error(`Unknown CAPPZ network: ${network}`);
  return addresses;
}

export function resolveNetworkAddresses(network: CappzNetwork): NetworkAddresses {
  const base = resolveDefaultNetworkAddresses(network);
  if (network === 'mainnet') return base;
  const o = overrides[network];
  if (!o) return base;
  return {
    ...base,
    issuer: o.issuer?.address ?? base.issuer,
    treasury: o.treasury?.address ?? base.treasury,
    service: o.service?.address ?? base.service,
  };
}

export type AddressSource = 'default' | 'admin-override';

export interface NetworkRoleAddress {
  role: NetworkAddressRole;
  address: string;
  source: AddressSource;
  /** Checksum-valid XRPL classic address — configured data is validated, not trusted. */
  valid: boolean;
  overrideTxId?: string;
  overrideAt?: string;
  overrideBy?: string;
}

/** Per-role view with provenance (default vs admin override) and checksum validity. */
export function describeNetworkAddresses(network: CappzNetwork): NetworkRoleAddress[] {
  const resolved = resolveNetworkAddresses(network);
  const o = network === 'mainnet' ? undefined : overrides[network];
  return (['issuer', 'treasury', 'service'] as const).map((role) => {
    const ov = o?.[role];
    return {
      role,
      address: resolved[role],
      source: ov ? 'admin-override' : 'default',
      valid: isValidClassicAddress(resolved[role]),
      overrideTxId: ov?.txId,
      overrideAt: ov?.at,
      overrideBy: ov?.by,
    };
  });
}

export function resolveIssuer(network: CappzNetwork): string {
  return resolveNetworkAddresses(network).issuer;
}

export function resolveTreasury(network: CappzNetwork): string {
  return resolveNetworkAddresses(network).treasury;
}

export function resolveWsEndpoint(network: CappzNetwork): string {
  return resolveNetworkAddresses(network).wsEndpoint;
}
