/**
 * COPE node crystallized. Node ID: v15-20-01-subscription-watch-job
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * The subscription agent as an edge-node timer job. An app owner runs it on
 * their node for sponsored apps: the node's `fund` port pays from the app's
 * POW treasury account (the owner's key, on the owner's node), within each
 * rule's caps. Bind it with a BPMN timer start event
 * (cappz:function="subscription-watch", e.g. R/PT15M); it is not bound by
 * default because only the owner knows which wallets and rules it covers.
 */
import type { EdgeTimerJob, JobRunResult } from '../../functions/edgeJobs.ts';
import type { FundingRule } from './fundingPolicy.ts';
import type { SubscriptionAgent } from './subscriptionAgent.ts';

export const SUBSCRIPTION_WATCH = 'subscription-watch';

export function subscriptionWatchJob(
  agent: SubscriptionAgent,
  targets: () => Promise<Array<{ wallet: string; rules: FundingRule[] }>>,
): EdgeTimerJob {
  return {
    functionName: SUBSCRIPTION_WATCH,
    async run(): Promise<JobRunResult> {
      const counts: Record<string, number> = {};
      let failed = 0;
      for (const t of await targets()) {
        for (const c of await agent.check(t.wallet, t.rules)) {
          counts[c.outcome] = (counts[c.outcome] ?? 0) + 1;
          if (c.outcome === 'fund-failed') failed++;
        }
      }
      const detail = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ') || 'no wallets';
      return { ok: failed === 0, detail };
    },
  };
}
