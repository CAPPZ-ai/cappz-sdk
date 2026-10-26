/** The XRPL networks CAPPZ runs on. networkConfig.ts re-exports it; storage evidence needs only the name. */
export type CappzNetwork = 'testnet' | 'devnet' | 'mainnet';

/** The roles whose ledger address an admin can override on testnet and devnet. */
export type NetworkAddressRole = 'issuer' | 'treasury' | 'service';

/**
 * What the client reads of an admin-replayed address override. The server's record
 * (supabase/functions/_shared/networkAddressOverrides.ts) carries more and fits this shape.
 */
export interface NetworkAddressOverrideView { address: string; txId?: string; at?: string; by?: string }
export type NetworkAddressOverrides = Partial<Record<'testnet' | 'devnet', Partial<Record<NetworkAddressRole, NetworkAddressOverrideView>>>>;
