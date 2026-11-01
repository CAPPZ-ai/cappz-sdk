/**
 * COPE node crystallized. Node ID: v15-20-01-contract-split
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Who is paid from each charge comes only from the contract: the platform,
 * the app owner (ebb tenant) and content owners (talent), in basis points.
 * A share may be null or 0 — that party gets nothing from usage. If the
 * shares do not add up to 100%, the contract must name who takes the rest;
 * otherwise the split is refused rather than guessed. Rounding is exact
 * (largest remainder): the lines always add up to the charge.
 *
 * The platform baseline fee per charged TX is a separate line to the plan's
 * base-fee party, not part of the percentage split.
 *
 * Each line is also an AP/AR pair: the payer's payable, the payee's receivable.
 */
import type { Currency } from './money.ts';

export type SplitRole = 'platform' | 'tenant' | 'talent';

export interface ContractShare {
  /** Wallet address or account root of the party. */
  party: string;
  role: SplitRole;
  /** Basis points of the usage amount; null or 0 = no share. */
  bps: number | null;
}

export interface ContractSplit {
  contractId: string;
  shares: ContractShare[];
  /** Party (one of `shares`) that takes whatever the shares leave unallocated. */
  remainderTo?: string;
}

export interface SplitLine {
  party: string;
  role: SplitRole | 'base-fee';
  amount: number;
}

export type SplitResult = { ok: true; lines: SplitLine[] } | { ok: false; problem: string };

export function splitProblems(s: ContractSplit): string[] {
  const out: string[] = [];
  let sum = 0;
  for (const sh of s.shares) {
    if (sh.bps === null) continue;
    if (!Number.isInteger(sh.bps) || sh.bps < 0 || sh.bps > 10_000) out.push(`${sh.party}: share must be 0–10000 basis points`);
    else sum += sh.bps;
  }
  if (sum > 10_000) out.push(`Shares add up to ${sum} basis points, over 100%`);
  if (s.remainderTo !== undefined && !s.shares.some((sh) => sh.party === s.remainderTo)) out.push('remainderTo must be one of the contract parties');
  if (sum < 10_000 && s.remainderTo === undefined) out.push(`Contract ${s.contractId} leaves ${10_000 - sum} basis points unallocated and names no remainder party`);
  return out;
}

/** Split `usage` (minor units) by the contract, plus an optional base-fee line. */
export function splitCharge(usage: number, split: ContractSplit, baseFee?: { amount: number; to: string }): SplitResult {
  const problems = splitProblems(split);
  if (problems.length) return { ok: false, problem: problems.join('; ') };
  const weights = new Map<string, { role: SplitRole; bps: number }>();
  let sum = 0;
  for (const sh of split.shares) {
    const bps = sh.bps ?? 0;
    sum += bps;
    const cur = weights.get(sh.party);
    weights.set(sh.party, { role: cur?.role ?? sh.role, bps: (cur?.bps ?? 0) + bps });
  }
  if (sum < 10_000) {
    const r = weights.get(split.remainderTo!)!;
    r.bps += 10_000 - sum;
  }
  // BigInt so usage × bps stays exact for any amount.
  const parts = [...weights.entries()].filter(([, w]) => w.bps > 0).map(([party, w]) => {
    const p = BigInt(usage) * BigInt(w.bps);
    return { party, role: w.role, amount: Number(p / 10_000n), rem: Number(p % 10_000n) };
  });
  let left = usage - parts.reduce((s, p) => s + p.amount, 0);
  for (const p of [...parts].sort((a, b) => b.rem - a.rem || a.party.localeCompare(b.party))) {
    if (left <= 0) break;
    p.amount++;
    left--;
  }
  const lines: SplitLine[] = parts.filter((p) => p.amount > 0).map(({ party, role, amount }) => ({ party, role, amount }));
  if (baseFee && baseFee.amount > 0) lines.push({ party: baseFee.to, role: 'base-fee', amount: baseFee.amount });
  return { ok: true, lines };
}

export interface Posting {
  kind: 'AP' | 'AR';
  /** Whose books the line is on. */
  account: string;
  counterparty: string;
  currency: Currency;
  amount: number;
  chargeId: string;
  contractId: string;
}

/** Payer owes each payee (AP); each payee is owed by the payer (AR). */
export function postingsFor(lines: readonly SplitLine[], payer: string, currency: Currency, chargeId: string, contractId: string): Posting[] {
  return lines.flatMap((l) => [
    { kind: 'AP' as const, account: payer, counterparty: l.party, currency, amount: l.amount, chargeId, contractId },
    { kind: 'AR' as const, account: l.party, counterparty: payer, currency, amount: l.amount, chargeId, contractId },
  ]);
}
