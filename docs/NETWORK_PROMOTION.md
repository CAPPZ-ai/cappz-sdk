# Network promotion

`@cappz/sdk/network` turns a testnet → mainnet promotion into one governed run that behaves the same way every time. The SDK holds the rules. The host app supplies the BPMN process, the task handlers that sign with the operator's own wallet, and the admin view.

## The pieces

| Module | What it does |
|---|---|
| `promotionChecks.ts` | Platform checks plus checks that apps declare (`registerPromotableApp`). Checks only read. A check that throws counts as `unknown`, and `unknown` on a critical check blocks the run. |
| `preflightEvidence.ts` | Hashes the preflight result together with the network pair, apps, session and check outcomes. `verifyPreflightForStart` refuses a hash from another session, another pair or set of apps, an evidence set older than 30 minutes, or one taken before the last network switch. |
| `promotionRun.ts` | Replays one process instance into steps and run state. Nothing stores a status. A failed step leaves the run `stopped`, `stepsToRun` resumes from the first step that has not completed, and rollback is `clean` until the first step marked `reversible="false"`. |
| `issuerGrant.ts` | Dry run for a token issuer on a new network: DefaultRipple (and domain) before any holder line, holder lines, NoRipple repair, no-ripple fee lines, and the owner reserve each signer needs. It returns unsigned transactions and never sees a seed. |

## A run's history

```
NetworkPromotionRequested   operator → instance   { apps, source, target, preflightHash, requestedBy }
PromotionStepRequested      instance port out     { stepId, requestId }
PromotionStepCompleted      reply                 { requestId, evidenceHash, ledgerTxHashes }
PromotionStepFailed         reply                 { requestId, reason }
SkillClonePromoted          on the target network, one per app
ProcessInstanceCompleted    the last step completed
ProcessInstanceCancelled    an operator abandoned the run   { reason, cancelledBy }
```

A reply whose `requestId` was never requested is ignored. A retry or a resume sends a new request, so each step counts its attempts.

Two ways out of an unfinished run:

- **Resume** (`resumeRefusal`). This is refused while a step is still waiting for its reply. A step with no reply for 15 minutes (`PROMOTION_STEP_STALE_MS`) is treated as abandoned, for example because the operator's browser closed mid-step, so resume can ask for it again. Step handlers must be idempotent for this to be safe.
- **Cancel** (`cancelRefusal`). Any open run can be cancelled, and a reason is required. Cancelling closes the run, so it no longer blocks a new promotion. Its history stays, including which irreversible steps already ran.

## Targets

A promotion writes to `testnet` (a rehearsal) or `mainnet`. Devnet is not a target, because it resets too often to rehearse on. Validate a run on testnet before you run it on mainnet.

## Example

```ts
import {
  registerPromotableApp, checksFor, runPromotionChecks, buildPreflightEvidence, preflightHash,
  verifyPreflightForStart, replayPromotionRun, stepsToRun,
} from '@cappz/sdk/network';

registerPromotableApp({
  appId: 'my-app', label: 'My app', skillAddress: "m/44'/144'/0'/my/skills/app",
  checks: [{ id: 'my-app.config', label: 'Config present', appId: 'my-app', critical: true,
    governingPrinciple: 'm/44\'/144\'/100\'/principles/cope/v1',
    run: async () => ({ status: 'passed', reason: '3 config TXs' }) }],
});

const ctx = { source: 'testnet', target: 'mainnet', apps: ['my-app'] } as const;
const results = await runPromotionChecks(checksFor(ctx.apps), ctx);
const evidence = buildPreflightEvidence({ ...ctx, sessionId, checkedAt: new Date().toISOString(), results });
const hash = await preflightHash(evidence);
const verdict = await verifyPreflightForStart({ evidence, citedHash: hash, sessionId, ...ctx });
```
