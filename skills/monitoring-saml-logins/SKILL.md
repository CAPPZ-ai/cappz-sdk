---
name: monitoring-saml-logins
description: Sets up and runs ongoing detection for SAML single sign-on abuse with CAPPZ — scheduled reconciliation of SaaS login logs against identity-provider issuance (orphan and replayed logins, gaps reported as gaps), tamper-evident sealed issuance, and SAML Guard alerts (responses the SP accepted that the guard refused, cross-tenant attempts) — and responds when one fires: contain, scope, root cause, record with report hashes. Use when asked to monitor SSO or SAML logins, detect forged or replayed SAML sessions, schedule checks after a SAML incident, investigate a SAML Guard or reconciliation alert, or prove which logins an IdP actually issued.
---

# Monitoring SAML logins

Prevention fails quietly. A SaaS that accepts a forged assertion still writes "successful SSO login" in its own log. Monitoring compares that log with what your identity provider (IdP) actually issued, and watches SAML Guard where it runs. Tools and options: [docs/SAML_GUARD.md](../../docs/SAML_GUARD.md). Choosing safeguards: **securing-saml-sso**.

## Two signals

| Signal | Source | Covers | Cadence |
|---|---|---|---|
| **Reconciliation** (`saml-reconcile.ts`) | IdP sign-in export + SaaS login audit export | Any SP, including third-party SaaS: logins the IdP never issued (`orphan`), one assertion used twice (`reused`) | Daily, or after each export; immediately for an incident window |
| **Guard alerts** (`saml-wizard status --alert`) | `data/saml-alerts.jsonl` on a host running SAML Guard | SPs behind the Guard: responses the SP **accepted** that the Guard refused (shadow), and cross-tenant attempts (any mode) | Every 5 minutes |

## Set up reconciliation

1. **Exports.** Find where each log comes from and how it gets to the monitoring host. Typical sources: the Okta System Log API or export, Entra sign-in logs (Graph `auditLogs/signIns` or the portal download), ADFS events to CSV, and the SaaS admin console's login audit export or API.
   - Use read-only credentials, keep them on the monitoring host, and never put them in the report.
   - If the SaaS export carries the SAML assertion ID, map it (`assertionId`): matching then becomes exact.
2. **Mapping.** Write the SaaS field map (`at`, `subject`, `app`, `where` for SSO-login rows only, plus `ip` and `assertionId` when available). Add `apps.json` so both sides name the application the same way, and `aliases.json` if the SaaS identifies users differently from the IdP.
3. **First run, by hand,** on a week you believe is clean. Expect `clean`, or `gaps-only` while mappings are wrong.
   - An `unmapped-app` means the names don't match, or the app doesn't use SSO. Fix the mapping. Never treat a gap as clean.
   - A real `orphan` in a "clean" week is a finding. Treat it as an incident.
4. **Schedule it.** `saml-wizard monitor` prints systemd timers and cron lines. The reconcile command exits 1 on findings and 2 on gaps only. Page on 1, and open a ticket on 2.
5. **Tamper evidence (recommended).** On the edge node, `saml-reconcile.ts seal --issued <today's IdP export>` as each export arrives, then reconcile with `--sealed`. Someone who can forge logins may also edit IdP logs, and a sealed, chained batch shows the edit.

## Set up Guard alerts

Where SAML Guard runs (see **securing-saml-sso**): schedule `saml-wizard status --alert` every 5 minutes. It prints only alerts new since the last run, and exits 1 if there are any. Also check that the guard is reachable: a failed status call is itself an alert, because a stopped guard in front of an SP is an outage or a bypass.

## When something fires

1. **Contain.** Revoke the sessions in question at the SaaS: orphan or reused logins from reconciliation, or the subject hash plus tenant from a Guard alert. If a Guard tenant is still in shadow and the reason is attack-class (`cross-tenant`, `bad-signature`, `bad-digest`, `replayed`, wrapping), propose enforcing that tenant now, with `--force --reason "incident <ref>"`. Ask the person first: it changes production login.
2. **Scope.** Reconcile the affected application over the whole suspected window, not just the alert's time. List orphan subjects, source IPs and times.
3. **Root cause.** The reason names the check the SP skipped: tenant binding, addressing (audience, recipient, destination), signature, time or one-time use. Hand off to **securing-saml-sso** for the fix-or-safeguard decision.
4. **Record.** Put the reconciliation `reportHash` and the Guard report hash in the incident record, with which export files (and their hashes, `inputHashes`) they came from.

Report to the person in plain words: how many logins, which users (by name only where they are allowed to see it), when, what was done, and what stays open. Never paste assertions, NameIDs or session cookies into chat or tickets.

## Keep it honest

- **A quiet monitor isn't proof.** Check monthly that both exports still arrive and still map: `gaps-only` that grows, or zero logins on a busy app, means the pipeline broke.
- **Clock drift between the IdP, the SaaS and the host** shows up as orphans near the window edge. Fix the clocks before widening `--window-min`.
- **Credentials and certificates change.** Keep the IdP and SaaS export credentials and the IdP certificate pins on the same calendar as their expiry, and watch the doctor's `pin-expiring` warning.
