/**
 * COPE node crystallized. Node ID: v15-23-01-edge-node-funding
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Binds the subscription-watch timer job on an app owner's node. Off unless
 * CAPPZ_FUNDING_CONFIG names a JSON file:
 *
 *   { "network": "testnet",
 *     "targets": [{ "wallet": "r…app treasury hot wallet", "rules": [FundingRule…] }] }
 *
 * Each target is an XRPL account the node keeps funded (e.g. the app's POW
 * treasury hot wallet that sponsored usage draws on). Its balance is read
 * from the ledger; top-ups are XRP Payments signed with CAPPZ_FUNDING_SEED —
 * the owner's own funding account, on the owner's node; the seed never leaves
 * this process. Rules must be XRP, mode "auto", with at least one cap, to move
 * money; anything else is logged for the owner. Caps count the node's own
 * top-ups, kept in <CAPPZ_NODE_DATA>/funding/<target>.jsonl.
 *
 * Schedule it with a timer start event in the jobs BPMN, e.g.
 *   <bpmn:startEvent id="FundingTick" cappz:function="subscription-watch"
 *     cappz:governingPrinciple="m/44'/144'/100'/principles/cope/v1#local-first">
 *     <bpmn:timerEventDefinition><bpmn:timeCycle>R/PT15M</bpmn:timeCycle></bpmn:timerEventDefinition>
 *   </bpmn:startEvent>
 */
import { Client, Wallet } from 'xrpl';
import { XRPL_ENDPOINTS, fetchAccountSummary, type XrplNetwork } from '../../src/lib/xrpl/ledgerCheck.ts';
import type { EdgeTimerJob } from '../../src/lib/functions/edgeJobs.ts';
import type { FundingEvent } from '../../src/lib/treasury/funding/events.ts';
import { ruleProblems, type FundingRule } from '../../src/lib/treasury/funding/fundingPolicy.ts';
import type { FundingStore } from '../../src/lib/treasury/funding/subscriptionAgent.ts';
import { treasuryWatchJob, type TreasuryTarget } from '../../src/lib/treasury/funding/treasuryWatch.ts';

export interface FundingConfig {
  network: XrplNetwork;
  targets: TreasuryTarget[];
}

export function fundingConfigProblems(c: FundingConfig): string[] {
  const out: string[] = [];
  if (!['mainnet', 'testnet', 'devnet'].includes(c.network)) out.push(`network must be mainnet, testnet or devnet`);
  for (const t of c.targets ?? []) {
    if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(t.wallet)) out.push(`${t.wallet}: not an XRPL classic address`);
    for (const r of t.rules ?? []) for (const p of ruleProblems(r)) out.push(`${t.wallet}/${r.ruleId}: ${p}`);
  }
  return out;
}

export function jsonlFundingStore(dir: string): FundingStore {
  const file = (wallet: string) => `${dir}/${encodeURIComponent(wallet)}.jsonl`;
  return {
    async read(wallet) {
      try {
        return (await Deno.readTextFile(file(wallet))).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as FundingEvent);
      } catch { return []; }
    },
    async append(wallet, e) {
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(file(wallet), JSON.stringify(e) + '\n', { append: true });
    },
  };
}

/** The subscription-watch job, or null (with the reason logged) when not configured. */
export async function fundingJobFromEnv(dataDir: string): Promise<EdgeTimerJob | null> {
  const path = Deno.env.get('CAPPZ_FUNDING_CONFIG');
  if (!path) return null;
  let config: FundingConfig;
  try { config = JSON.parse(await Deno.readTextFile(path)); } catch (e) {
    console.log(`[edge-node] subscription-watch off: cannot read ${path} (${e instanceof Error ? e.message : e})`); return null;
  }
  const problems = fundingConfigProblems(config);
  if (problems.length) { console.log(`[edge-node] subscription-watch off:\n  ${problems.join('\n  ')}`); return null; }
  const seed = Deno.env.get('CAPPZ_FUNDING_SEED');
  const payer = seed ? Wallet.fromSeed(seed) : null;
  if (!payer) console.log('[edge-node] subscription-watch: no CAPPZ_FUNDING_SEED — it watches and logs, and never pays');

  const pay = async (t: TreasuryTarget, rule: FundingRule, drops: number) => {
    if (rule.currency !== 'XRP') throw new Error('the node pays XRP only');
    if (!payer) throw new Error('no CAPPZ_FUNDING_SEED');
    const client = new Client(XRPL_ENDPOINTS[config.network]);
    await client.connect();
    try {
      const prepared = await client.autofill({ TransactionType: 'Payment', Account: payer.classicAddress, Destination: t.wallet, Amount: String(drops) });
      const res = await client.submitAndWait(payer.sign(prepared).tx_blob);
      const meta = res.result.meta as { TransactionResult?: string } | undefined;
      if (meta?.TransactionResult !== 'tesSUCCESS') throw new Error(`ledger result ${meta?.TransactionResult ?? 'unknown'}`);
      return { txHash: res.result.hash };
    } finally { await client.disconnect(); }
  };

  console.log(`[edge-node] subscription-watch: ${config.targets.length} account(s) on ${config.network}`);
  return treasuryWatchJob({
    store: jsonlFundingStore(`${dataDir}/funding`),
    balanceOf: async (t, rule) => {
      if (rule.currency !== 'XRP') throw new Error('the node reads XRP balances only');
      const s = await fetchAccountSummary(config.network, t.wallet);
      return s.activated && s.xrpDrops ? Number(s.xrpDrops) : 0;
    },
    pay,
  }, async () => config.targets);
}
