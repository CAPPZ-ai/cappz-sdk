/** v15-32-07: the buyer or seller cancels a contract nobody has funded or paid; anything with money keeps the dispute path. */
import { describe, expect, it } from 'vitest';
import { DEMO_YOU, seedDemoMarket } from '../lib/marketplace/demo';
import * as M from '../lib/marketplace/model';
import { NO_FEES, buildFeeSchedule } from '../lib/marketplace/fees';
import { partyAddress } from '../lib/marketplace/MarketplacePaths';

const START = '2026-11-01T12:00:00.000Z';

async function order() {
  const r = await seedDemoMarket(START);
  r.apply(await buildFeeSchedule('op', r.as('op', 1).at, { marketplace: NO_FEES, securities: NO_FEES, recipients: [], note: 'fees off' }));
  const o = await M.buildOrder(r.state, r.as(DEMO_YOU), 'l-agentco-recon', 1); r.apply(o.txs);
  return { r, id: o.contractId };
}
const view = (r: Awaited<ReturnType<typeof order>>['r'], id: string) => r.state.contracts.find((c) => c.contractId === id)!;

describe('cancelling an unfunded contract', () => {
  it('either side cancels with a reason; it is cancelled, not finished, not a dispute', async () => {
    for (const who of [DEMO_YOU, 'agentco']) {
      const { r, id } = await order();
      const before = { ...(r.state.reputation.get('agentco') ?? { completed: 0, disputes: 0 }) };
      r.apply(await M.buildCancelContract(r.state, r.as(who), id, 'Deal fell through'));
      expect(view(r, id)).toMatchObject({ state: 'cancelled', cancelled: { by: who, reason: 'Deal fell through' }, nextAction: { action: 'Cancelled' } });
      const after = r.state.reputation.get('agentco') ?? { completed: 0, disputes: 0 };
      expect([after.completed, after.disputes]).toEqual([before.completed, before.disputes]);
      await expect(M.buildCancelContract(r.state, r.as(who), id, 'again')).rejects.toThrow(/already cancelled/);
    }
  });

  it('refuses third parties, missing reasons and any contract money has touched', async () => {
    const { r, id } = await order();
    await expect(M.buildCancelContract(r.state, r.as('north-star-grain'), id, 'x')).rejects.toThrow(/Only the buyer or the seller/);
    await expect(M.buildCancelContract(r.state, r.as(DEMO_YOU), id, '  ')).rejects.toThrow(/Say why/);
    const amount = view(r, id).total.amount;
    r.apply(await M.buildFund(r.state, r.as(DEMO_YOU), id, amount, { rail: 'demo' }));
    await expect(M.buildCancelContract(r.state, r.as(DEMO_YOU), id, 'changed my mind')).rejects.toThrow(/Money has moved/);
  });

  it('replay ignores a cancellation written by someone else, or after money moved', async () => {
    const { r, id } = await order();
    const [cx] = await M.buildCancelContract(r.state, r.as(DEMO_YOU), id, 'x');
    r.apply([{ ...cx, sourceAddress: partyAddress('north-star-grain') }]);
    expect(view(r, id).state).not.toBe('cancelled');
    r.apply(await M.buildFund(r.state, r.as(DEMO_YOU), id, view(r, id).total.amount, { rail: 'demo' }));
    r.apply([cx]);
    expect(view(r, id).state).not.toBe('cancelled');
  });
});
