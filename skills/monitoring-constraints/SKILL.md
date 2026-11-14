---
name: monitoring-constraints
description: Runs ongoing detection of tampering with equipment using the CAPPZ Constraint Guard — scheduled reconciliation of historian exports, setpoint read-back, sealed observations and the guard's verdict log against each device's signed envelope (changes nobody authorised, limit breaches, disagreeing sensors, changes with no effect, silence; gaps reported as gaps) plus guard alerts — and responds when one fires: triage, contain, preserve, verify, recover, notify. Use when asked to monitor controllers, setpoints, cold chains, process values or vehicle navigation integrity, to schedule checks after an incident, to investigate a guard alert or a reconciliation finding, or to prove which changes were authorised.
---

# Monitoring constraints

A controller changed through a back door still reports "OK", and sometimes it reports a forged value. Monitoring catches that by comparing three things:
- what changed, against what was authorised
- what was measured, against the device's limits
- each sensor, against an independent one

The guide: [docs/CONSTRAINT_GUARD.md](../../docs/CONSTRAINT_GUARD.md) (Quick start, step 2, runs a full example). Setting up envelopes and the guard: **securing-control-systems**.

**Prerequisites:** Deno 2; a clone of github.com/CAPPZ-ai/cappz-sdk; a declared envelope (`constraint-wizard status` shows "version N active" and the next step).

## What is the person asking?

| They say | Do |
|---|---|
| "Set up monitoring" | Set up (below) |
| "This finding / alert fired" | When something fires (below) |
| "Is everything clean?" | Run reconciliation. Report `clean` only when the verdict is `clean`; `gaps-only` is not clean. |

## The three signals

| Signal | Where | Catches | How often |
|---|---|---|---|
| Reconciliation report | `constraint-reconcile` | Unauthorised changes, breaches, sensor disagreement, no response, silence, edited history | Every 5–15 min for safety-relevant values (stock can spoil in hours); at least daily otherwise |
| Guard alerts | `cappz-constraints/data/constraint-alerts.jsonl` | Refusals, fail modes and privileged attempts as they happen | Continuously: feed the file to their alerting |
| Shadow report | `GET http://guard:41452/cappz/constraints/report` | Readiness to enforce | Weekly, until every point is enforced |

## Set up

1. **Setpoint read-back.** An unauthorised change is only visible if someone reads the setpoint. Read it through the guard (reads are recorded), or export it on a schedule (`examples/constraints/readback-map.json` shows the map).
2. **An independent sensor** for each value that matters, with an `agreement` constraint. Without one, a falsified reading looks normal.
3. **Sealing.** Run the edge node with `CAPPZ_NODE_KEY` and `CAPPZ_NODE_PUB` so its observations are sealed.
4. **Schedule the check.** For example, every 10 minutes, covering the last hour:

   ```sh
   deno run --allow-read --allow-write packages/cappz-edge-node/tools/constraint-reconcile.ts \
     --config cappz-constraints/constraints.json --data cappz-constraints/data \
     --sealed cappz-constraints/data/constraint-observations.jsonl --collectors "$CAPPZ_NODE_PUB" \
     --commands cappz-constraints/data/constraint-verdicts.jsonl \
     --observations historian.csv --mapping historian-map.json \
     --from "$(date -u -d '-1 hour' +%FT%TZ)" --out report.json
   ```

   **Exit codes:** 0 clean · 1 findings → alert someone · 2 gaps only → open a ticket (never ignore) · 3 the check itself failed → alert.

## When something fires

Work in this order, and cite the report's `reportHash` in every record you make.

1. **Triage.** Offer `cappz-market constraints-triage --report report.json` (0.02 XRP; ask approval on mainnet), or read the findings yourself with the guide's table. Lead with the severity and the strongest explanation. Explanations are inferences, not proof of cause: say so.
2. **Contain.**
   - For an `orphan-change`: close or route through the guard the path it came through, and enforce the guard on the affected points.
   - For `key-revoked`, `replayed` or `bad-signature`: revoke those keys in their wallets.
3. **Preserve.** Keep these unchanged, and note who had access:
   - `report.json`
   - the sealed batches
   - `constraint-verdicts.jsonl` and `constraint-alerts.jsonl`
   - the controller's own logs
4. **Verify on site.**
   - Check disagreeing sensors against a third, independent reference before trusting either.
   - Inspect silent periods.
   - Treat `sealed-broken` as edited history: that period's historian cannot be trusted.
5. **Recover.** Restore setpoints with signed commands inside the envelope. When a value left its band, give the times and the worst value. Whether to discard or re-test product is the owner's safety plan's decision, not yours.
6. **Notify** as their obligations require: their security contact, the equipment vendor, the police for suspected crime. Under the EU NIS2 Directive, a significant incident needs an early warning to the national CSIRT or authority within 24 hours.

## Never

- Call a period clean when the verdict is `gaps-only`. Unmapped tags, silent points and missing data were not checked.
- Loosen an envelope to make a finding go away. Loosening needs two operators and a cooling period for a reason.
- Treat a seal as proof that a sensor was accurate. It proves only that the record has not been changed.
