---
name: securing-control-systems
description: Protects equipment controllers (refrigeration and freezers, ovens, HVAC, dosing pumps, breakers, building systems, IoT devices, graph-based device twins) against unauthorised or unsafe setpoint changes with the CAPPZ Constraint Guard. Assesses the weakness or incident, recommends root-cause fixes plus safeguards in order (contain, reconcile, seal, guard in shadow, enforce per point), writes the device's signed envelope from documents (never inventing numbers), and rolls out the guard on HTTP, Modbus TCP, BACnet/IP, DNP3, IEC 60870-5-104, MQTT/Sparkplug or Gremlin with constraint-wizard. Scopes vehicle navigation and air-data integrity as advisory only. Use when asked about a hacked or tampered controller, ICS/SCADA/OT security, protecting setpoints, a controller CVE, or whether to patch, segment, monitor or add a guard.
---

# Securing control systems

The guide with every command, file format and example: [docs/CONSTRAINT_GUARD.md](../../docs/CONSTRAINT_GUARD.md). To show a person the idea quickly, point them to the animated walkthrough [docs/tutorials/constraint-guard.html](../../docs/tutorials/constraint-guard.html) (opens in a browser). Worked example files for a bakery oven: [examples/constraints/](../../packages/cappz-sdk/examples/constraints/). Ongoing detection and incident response: **monitoring-constraints**.

**Prerequisites** (say so if missing): Deno 2; a clone of github.com/CAPPZ-ai/cappz-sdk (commands below run from its root); for the inline guard, a machine on the network path to the controller.

## What is the person asking?

| They say | Do |
|---|---|
| "We were hacked / a setpoint changed / equipment went out of range" | Triage (§1), recommend contain → reconcile → guard (§2), hand ongoing detection to **monitoring-constraints** |
| "How do we protect device X?" | Triage the write paths (§1), options (§2), envelope (§3), rollout (§4) |
| "Write the envelope / limits for X" | §3. Numbers come only from their documents or from them. |
| "Is the guard ready to enforce?" | §4, step 4 |
| A vehicle, aircraft or ship | §5. Advisory only. |

## 1. Triage: path, owner, evidence

Mark each fact as **fact** (seen in logs, config or an advisory), **inference** or **unknown**. Ask about unknowns; never fill them in.

| Ask | Why |
|---|---|
| Which device and point changed, from what to what, when? | Becomes the envelope's points and the period to reconcile |
| Which paths can write to it? (web panel, vendor cloud, VPN, Modbus/BACnet/DNP3/104 port, MQTT broker, Gremlin, local HMI) | The guard protects only paths that pass through it; every other path must be closed or routed through it |
| Is there an advisory or CVE? | Scope it by the **vulnerable component**, verified on the vendor's own advisory. If you cannot find it, say so; do not cite it. |
| What logs exist? (historian, controller audit log, setpoint read-back, an independent sensor) | Decides what reconciliation can prove today |
| What does a wrong value cost? (spoiled stock, fire, overdose, outage) | Sets urgency and fail modes |

## 2. Recommend: root cause and safeguards, in order

| Option | Covers | Does not cover | Needs |
|---|---|---|---|
| Patch or vendor fix | The specific flaw | Other paths, stolen passwords | A vendor release, a maintenance window |
| Segment; remove internet exposure and vendor remote access | Remote reach | Insiders, a compromised HMI inside | Network changes |
| **Reconciliation** (read-only) | Changes nobody authorised, limit breaches, sensors that disagree (a falsified reading), changes with no effect, silence | Stopping a change as it happens | Exports or read-back; an envelope |
| **Sealed observations** | Edits to the history afterwards | Sensor accuracy | An edge node or small board with a key |
| **Guard, shadow** | Shows what would be refused, with no risk | Blocks nothing yet | A machine on the write path |
| **Guard, enforced per point** | Refuses unsigned, unsafe, out-of-hours, replayed and revoked-key writes, in the protocol's own terms | Paths that bypass it; local/manual overrides (by design); vendor bugs below the protocol | A shadow report that says ready; senders using signed or armed commands |

The default order to recommend:
1. Contain: close or route the write path through the guard.
2. Reconcile now, to learn what already happened.
3. Seal observations.
4. Run the guard in shadow.
5. Enforce point by point.
6. Fix the root cause.

Always state what remains uncovered.

## 3. The envelope

Start from [examples/constraints/envelope-draft.json](../../packages/cappz-sdk/examples/constraints/envelope-draft.json). For each device:

- **Points**: each measured value, setpoint, on/off output and the mode, with a UCUM unit (`Cel`, `kPa`, `mg/L`, `{bool}`, `{state}` …).
- **Constraints**:
  - `range` on values and setpoints
  - `rate` (`maxStep`) on setpoints
  - `dwell` for "may leave the band only briefly"
  - `agreement` with an **independent** sensor
  - `response` (a setpoint must move its value)
  - `authority`: whose key may change which setpoint, and when
  - `schedule` if writes are allowed only at certain times

Rules:
- **Never invent a number.** Use their documents or ask. To draft from a manual, offer `cappz-market constraints-draft --file manual.txt --device <id>` (0.05 XRP; ask approval on mainnet). It keeps only limits quoted verbatim with their numbers and lists what is missing. For a device graph, use `constraint-wizard draft-graph` (mapping example: `examples/constraints/graph-mapping.json`).
- **`authority` is never drafted for them.** It needs real public keys from `constraint-wizard keygen`, and `declare` refuses placeholders.
- **Fail mode**: keep `hold-last-good` unless withholding a write is more dangerous than allowing it. If you choose `pass-and-alarm`, say why.
- **Loosening later** needs two operators and a cooling period. Never suggest shortening the cooling period to get past an incident.

## 4. Roll out the guard

```sh
T=packages/cappz-edge-node/tools
deno run -A $T/constraint-wizard.ts keygen                      # each operator, on their own computer
deno run -A $T/constraint-wizard.ts init --envelope-id site-17/oven-3
deno run -A $T/constraint-wizard.ts declare                     # from cappz-constraints/envelope-draft.json
# write cappz-constraints/constraints.json from examples/constraints/constraints.json:
#   upstream = the controller, the maps for its protocol(s), both operators' public keys
deno run -A $T/constraint-wizard.ts doctor                      # fix everything until it says "doctor: ok"
deno run -A $T/constraint-wizard.ts                             # no step: what is done, and the next step
CAPPZ_CONSTRAINTS_CONFIG=cappz-constraints/constraints.json CAPPZ_NODE_DATA=cappz-constraints/data \
  deno run -A --unstable-net packages/cappz-edge-node/main.ts
```

1. **Shadow.** Every front starts in shadow: requests are forwarded and verdicts recorded. Repoint the HMI, BMS or integrations at the guard's port.
2. **Signed commands.** Move senders to them: the `Cappz-Command` header for HTTP (`constraint-wizard command …` prints it), or `constraint-wizard command … --arm http://guard:41452` before a Modbus, BACnet, DNP3, IEC 104, MQTT or Gremlin write.
3. **Read the report.** `cappz-market constraints-review --guard http://guard:41452` (0.02 XRP), or `GET /cappz/constraints/report`. Explain each refusal with the guide's [refusal table](../../docs/CONSTRAINT_GUARD.md#refusal-reasons-and-what-to-do).
4. **Enforce** only points the report calls ready: `constraint-wizard enforce --point <id> --report http://guard:41452 --reason "…"`.
   - **Investigate first** if it shows `key-revoked`, `replayed`, `bad-signature` or `value-mismatch`. Those mean someone has signing material they should not have.
   - **Roll back** with `constraint-wizard shadow --point <id> --reason "…"`.

**Protocol notes:**
- **OPC UA binary** is end-to-end encrypted: guard it at PubSub JSON or REST, or have clients sign commands.
- **Gremlin** clients must send bytecode; scripts are refused.
- **MQTT 3.1.1** has no "refused" reply, so a refused QoS 1/2 command closes the connection.

## 5. Vehicles (advisory only)

For aircraft, ships and other vehicles, `src/lib/constraints/vehicle.ts` covers:
- distance between position sources
- each source's offset from the others
- speed implied by position jumps
- GNSS clock offset
- `agreement` for redundant air data

Always say:
- These envelopes are advisory and never go in a control loop.
- Anything installed on a vehicle is certified separately.
- Every threshold is the operator's.

Do not claim the guard prevents an aircraft accident. When a claim of sabotage comes from an unverifiable source, say so and work from the official investigation. For AF447 that is the BEA's 2012 report: iced pitot probes, unreliable airspeed, a stall.

## 6. Answer format

1. Lead with the recommendation and its order.
2. Give the option table, with what each option needs from whom.
3. Say what stays uncovered.
4. Mark every claim as fact, inference or unknown.
