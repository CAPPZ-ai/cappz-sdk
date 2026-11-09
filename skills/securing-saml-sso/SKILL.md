---
name: securing-saml-sso
description: Assesses a SAML single sign-on weakness or incident (a SaaS or app accepted a forged, replayed, misdirected or cross-tenant SAML login) and chooses between root-cause fixes and CAPPZ safeguards — login reconciliation from two log exports, SAML Guard in front of an SP (single or multi-tenant, built-in signature verification, operator-signed certificate pins, cross-tenant refusal), device-bound sessions — with what each covers, costs and needs; then configures and rolls out the chosen safeguard with the saml-wizard (metadata import, doctor, offline test, shadow, signed enforce). Use when asked about a SAML authentication bypass or CVE, an SSO login nobody issued, hardening a SAML service provider, onboarding customer IdPs to a multi-tenant SaaS, or whether to patch, configure or add a guard.
---

# Securing SAML single sign-on

A SAML bypass is almost never broken cryptography. It is a service provider (SP) that accepted something it should have refused. Your job is to name **which check failed**, decide **who can fix it**, and add **safeguards for the gap until it is fixed and after**. Root cause and safeguard are not alternatives: you recommend both, in order.

Read [docs/SAML_GUARD.md](../../docs/SAML_GUARD.md) for the tools. This skill is the decision and the procedure.

## 1. Triage: what failed, and who owns it

Establish these facts. Mark each as **fact** (seen in logs, advisory or config), **inference** or **unknown**. Ask for what is unknown rather than assuming.

| Question | Why it matters |
|---|---|
| Which component did the check? (SaaS vendor's code, an open-source SAML library and version, your own app, a gateway) | Decides who can fix the root cause |
| Which check was skipped? Signature / issuer / audience / recipient / destination / time / one-time use / tenant binding / parser (wrapping, comments, namespaces) | Decides which safeguard covers it |
| Is the SP single-tenant (one IdP) or multi-tenant (one IdP per customer)? | Cross-tenant is the most common multi-tenant failure |
| Do you control the SP's traffic (host it, or can proxy its ACS)? | Guard possible, or reconciliation only |
| Is there a CVE or advisory? | Scope it by the **vulnerable component**, verified on the vendor's or maintainer's own advisory, not by the product name in a news item. Do not cite a CVE you could not find; say so. |
| What do the logs show? IdP sign-in log, SaaS login audit log, assertion IDs? | Decides whether reconciliation can match by assertion ID or only by time window |

## 2. Choose: root cause and safeguards

Present the options as a table with **covers / does not cover / needs / effort**, then a recommendation with its order.

| Option | Covers | Does not cover | Needs | Effort |
|---|---|---|---|---|
| **Root cause: patch** (vendor fix, library upgrade) | The specific flaw | The next flaw of the same class; the window until it ships | The owner's release | Vendor's timeline |
| **Root cause: configuration** (enable audience/recipient checks, pin the IdP certificate per tenant, disable unsolicited logins, SHA-256+) | Misconfiguration, which is most "didn't check the source" incidents | Library bugs | Admin access to the SP | Hours |
| **Reconciliation** (`saml-reconcile.ts`) | Detects any login the IdP never issued, and replays, whatever the SP's bug. Works on any SaaS. | Doesn't prevent; finds after the fact (daily, or per export) | IdP sign-in export + SaaS login audit export | An hour to set up |
| **SAML Guard, shadow** | Shows which bad responses the SP accepts today, per reason, on live traffic, with no risk | Doesn't block yet | Control of the SP's traffic (proxy hop) | A day |
| **SAML Guard, enforce** | Blocks wrapping, parser tricks, misaddressed, expired, replayed and cross-tenant responses, and bad signatures (built-in verifier with pinned keys), even if the SP's own check is broken | IdPs using inclusive C14N or RSA-PSS (plug in a verifier); encrypted assertion contents | Shadow report READY, doctor clean | Minutes per tenant after shadow |
| **Device-bound sessions** (RFC 9421 signed requests after login) | A stolen or replayed assertion is useless on its own | A forged login at the door (the Guard's job) | App changes | Weeks |

**Default recommendation, in order:**
1. **Contain.** Revoke the suspect sessions, and run reconciliation over the incident window to find every login the IdP never issued.
2. **Root cause.** Configure what's misconfigured now. Report the flaw to the owner with evidence (the reconciliation report hash and the Guard's findings).
3. **Safeguard where you control traffic.** SAML Guard: shadow, then enforce per tenant.
4. **Detect where you don't.** Scheduled reconciliation (see **monitoring-saml-logins**).
5. **Later.** Device-bound sessions for apps you build.

When you only consume a SaaS, steps 3 and 5 are the vendor's. Say so, and give the person the questions to ask the vendor: which check failed, the fix version, whether assertion IDs can be added to the audit log, and whether tenant binding is by ACS URL.

## 3. Configure and roll out SAML Guard

Use the wizard (`packages/cappz-edge-node/tools/saml-wizard.ts`, Deno 2). Run the steps in order. Do not skip the doctor or shadow.

```bash
W="deno run -A packages/cappz-edge-node/tools/saml-wizard.ts --dir ./saml-guard"
$W keygen                                     # operator key: signs pins and mode changes
$W init --upstream http://127.0.0.1:8080      # strict defaults
$W add-tenant --id <tenant> --metadata <https URL or file> --acs <tenant ACS URL> --sp-entity <tenant SP entity>
$W doctor                                     # errors block enforce
$W test --tenant <tenant> --response <captured SAMLResponse> --at <its IssueInstant>
deno run -A packages/cappz-edge-node/tools/saml-guard.ts --config ./saml-guard/saml.json --data ./saml-guard/data
$W status --verbose
$W enforce --tenant <tenant>                  # only when READY; signed, cites the report
```

Rules to hold to, and to explain to the person:

- **One ACS URL and one SP entity ID per tenant.** The login URL is how the Guard knows which IdP must have signed. Never let the tenant be chosen from the response (RelayState, issuer, email domain).
- **Pins are per tenant and signed by the operator key.** Get metadata over HTTPS from the customer's IdP, or confirm the certificate fingerprint out of band.
- **Keep `signature: builtin`.** `left-to-sp` trusts the SP's library, which is the thing that failed.
- **`allowUnsolicited: false`** unless the tenant needs IdP app tiles. **Lifetime ≤ 10 min, skew ≤ 5 min.**
- **nginx passes `Host` and `X-Forwarded-Proto`**, and the guard binds to loopback.
- **Enforce one tenant at a time.** Roll back with `$W shadow --tenant <id> --reason "…"`.
- **Rotation.** `$W rotate --tenant <id> --metadata <new>` before the IdP switches certificates. The doctor warns 30 days ahead.

Read the shadow report back to the person in plain words. Attack-class reasons the SP accepted are findings **in the SP**. Configuration-class reasons are either findings or a Guard setting to fix, and each must be explained before enforcing.

## 4. What to hand back

- The triage table with fact / inference / unknown marks.
- The options table and the ordered recommendation.
- Commands run, and what each showed (doctor findings, test verdicts, report status), with report hashes for the record.
- What stays open, and who owns it (vendor fix, IdP certificate rotation date, tenants still in shadow).

Never paste NameIDs, assertions or session cookies into tickets or chat. The Guard and reconciliation report salted hashes for exactly this reason.
