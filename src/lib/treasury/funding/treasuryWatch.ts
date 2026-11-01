/**
 * COPE node crystallized. Node ID: v15-23-01-treasury-watch
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * The subscription-watch job for an app owner's own accounts — typically the
 * app's POW treasury hot wallet that sponsored usage draws on. Unlike a user
 * app wallet, its balance is on the XRP Ledger, so it is read there
 * (`balanceOf`), not replayed. The rule, caps and decision are the same as
 * the in-app agent's; caps count the node's own top-ups (AppFunded with the
 * rule id in the node's log). Only automatic rules move money here — a node
 * has no one to click a toast — so a proposal is logged for the owner and a
 * warning is logged when a cap is used up.
 */
import type { EdgeTimerJob, JobRunResult } from '../../functions/edgeJobs.ts';
import { replayProposals } from './events.ts';
import { decideFunding, type FundingRule } from './fundingPolicy.ts';
import { formatMinor } from './money.ts';
import type { FundingStore } from './subscriptionAgent.ts';
import { SUBSCRIPTION_WATCH } from './watchJob.ts';

export interface TreasuryTarget {
  /** Log key for this account (e.g. its XRPL address). */
  wallet: string;
  rules: FundingRule[];
}

export interface TreasuryWatchPorts {
  store: FundingStore;
  /** Current spendable balance in the rule's currency, minor units. */
  balanceOf: (target: TreasuryTarget, rule: FundingRule) => Promise<number>;
  /** Pay `amount` into the target; returns the ledger hash. Throws when it cannot. */
  pay: (target: TreasuryTarget, rule: FundingRule, amount: number) => Promise<{ txHash: string }>;
  log?: (line: string) => void;
  now?: () => Date;
}

export function treasuryWatchJob(ports: TreasuryWatchPorts, targets: () => Promise<TreasuryTarget[]>): EdgeTimerJob {
  const log = ports.log ?? ((l: string) => console.log(l));
  return {
    functionName: SUBSCRIPTION_WATCH,
    async run(): Promise<JobRunResult> {
      let failed = 0;
      const done: string[] = [];
      for (const t of await targets()) {
        for (const rule of t.rules) {
          const now = ports.now?.() ?? new Date();
          const events = await ports.store.read(t.wallet);
          let balance: number;
          try { balance = await ports.balanceOf(t, rule); } catch (err) {
            failed++; log(`[subscription-watch] ${rule.appName}: balance unavailable (${err instanceof Error ? err.message : err})`); continue;
          }
          const d = decideFunding({ rule, balance, runway: { burnPerHour: 0, hours: null, samples: 0 }, events, now });
          if (d.action === 'none' || d.action === 'pending') { done.push(`${rule.ruleId}: ok`); continue; }
          if (d.action === 'notify' || d.action === 'capped') { log(`[subscription-watch] ${d.message}`); done.push(`${rule.ruleId}: warned`); continue; }
          const at = now.toISOString();
          const proposalId = `topup-node-${rule.ruleId}-${at}`;
          const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();
          if (d.action === 'propose') {
            // Logged once per hour per rule (the proposal stays open for an hour).
            if (!replayProposals(events, now).some((p) => p.ruleId === rule.ruleId && p.state === 'open')) {
              await ports.store.append(t.wallet, { type: 'TopUpProposed', at, proposalId, ruleId: rule.ruleId, currency: d.currency, amount: d.amount, expiresAt, reason: d.reason });
              log(`[subscription-watch] ${d.message} (the node only tops up automatically; set mode "auto" with caps)`);
            }
            done.push(`${rule.ruleId}: proposed`);
            continue;
          }
          await ports.store.append(t.wallet, { type: 'TopUpProposed', at, proposalId, ruleId: rule.ruleId, currency: d.currency, amount: d.amount, expiresAt, reason: d.reason });
          await ports.store.append(t.wallet, { type: 'TopUpApproved', at, proposalId, by: `rule:${rule.ruleId}` });
          try {
            const { txHash } = await ports.pay(t, rule, d.amount);
            await ports.store.append(t.wallet, { type: 'AppFunded', at: (ports.now?.() ?? new Date()).toISOString(), currency: d.currency, amount: d.amount, source: rule.source, ruleId: rule.ruleId, proposalId, txHash });
            log(`[subscription-watch] ${rule.appName}: topped up ${formatMinor(d.amount, d.currency)} (${txHash})`);
            done.push(`${rule.ruleId}: funded`);
          } catch (err) {
            failed++;
            await ports.store.append(t.wallet, { type: 'TopUpDeclined', at: (ports.now?.() ?? new Date()).toISOString(), proposalId, by: 'system', reason: `payment failed: ${err instanceof Error ? err.message : String(err)}` });
            log(`[subscription-watch] ${rule.appName}: top-up failed (${err instanceof Error ? err.message : err})`);
            done.push(`${rule.ruleId}: failed`);
          }
        }
      }
      return { ok: failed === 0, detail: done.join(', ') || 'no targets' };
    },
  };
}
