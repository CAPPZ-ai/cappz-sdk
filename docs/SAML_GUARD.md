# SAML: catch forged logins, then refuse them

SAML single sign-on fails in a predictable way. The identity provider (IdP) is fine. The service provider (SP), usually a SaaS application, accepts an assertion it should have refused:

- **Two parsers disagree.** The signature check reads one part of the XML and the login code reads another: signature wrapping, namespace confusion, a comment splitting the NameID.
- **The signature is checked, but nothing else is.** The SP never checks that the assertion was meant for it, for this login attempt, and for this customer: audience, recipient, destination, issuer, time, one-time use, tenant.
- **The signature isn't really checked.** An algorithm confusion, a certificate taken from the response itself, or a library flaw.

## Which part is for you

| You are… | Your problem | Use |
|---|---|---|
| **A company whose SaaS was hit** | You can't change the SaaS | **Reconciliation** (§1): find logins your IdP never issued, from two log exports |
| **A company running its own SAML apps** | Your apps are the SP | **SAML Guard** (§2), single-tenant, plus reconciliation |
| **A SaaS provider** | Many customers, each with its own IdP | **SAML Guard, multi-tenant** (§2–§4), and give customers the logs reconciliation needs (§1, last paragraph) |
| **An agent or analyst choosing** | Safeguard or root-cause fix? | The skill [skills/securing-saml-sso](../skills/securing-saml-sso/SKILL.md) |

Nothing here needs a change to the IdP, a CAPPZ account or a hosted service. It runs on the CAPPZ edge node or with Deno on any machine.

---

## 1. Reconciliation: every session needs a matching issuance

```sh
deno run --allow-read --allow-write packages/cappz-edge-node/tools/saml-reconcile.ts \
  --issued okta:okta-system-log.json --logins csv:saas-audit.csv --logins-map saas-map.json --out report.json
```

- **`--issued`** is what your IdP issued: `okta:` (Okta System Log), `entra:` (Microsoft Entra sign-ins), or `csv:`/`json:` with `--issued-map`.
- **`--logins`** is the SaaS's own audit log of SSO logins, with a field map:

```json
{ "at": "timestamp", "subject": "user.email", "app": { "constant": "saas" },
  "where": { "event_type": "sso_login" }, "assertionId": "saml.assertion_id", "ip": "client_ip" }
```

- **`--apps`** maps the names each side uses for the same application to one id. **`--aliases`** maps other subject ids (employee ids) to the IdP's subject.

Every login is matched to an issuance for the same person and application: by assertion ID when both logs carry it, otherwise the nearest unused issuance in the 5 minutes before it (`--window-min`).

| State | Meaning |
|---|---|
| `matched` | An issuance accounts for it |
| `orphan` | **No issuance: a session your IdP never issued.** Revoke it, investigate. |
| `reused` | One assertion started two sessions: a replay |
| `unmapped-app` | The IdP issued nothing for this app in the whole period. A mapping gap, never "clean". |
| `outside-coverage` | Outside the time the IdP export covers |

The exit code is 0 for clean, 1 for findings and 2 for gaps only. The report is hashed, so an incident record can cite exactly what it was based on.

**Tamper evidence.** `saml-reconcile.ts seal --issued … --data ./node-data` signs and chains each issuance batch as it arrives. Each batch holds a salted hash of every subject, never the name. Reconciling with `--sealed ./node-data` makes a removed or edited batch fail verification.

**Check the readers once.** The Okta and Entra readers follow the vendors' documented export fields. Check them against one real export: a field named differently in your tenant drops rows from the issuance side, and those logins then show as `unmapped-app`, never as clean.

**SaaS providers:** put the SAML assertion ID (and the IdP's issuer) in your customers' login audit log export. Customers can then reconcile exactly, by ID, in minutes.

---

## 2. SAML Guard: the workflow

The wizard walks the whole process. Run it with no arguments for the guided version, or run each step on its own from scripts and CI:

```sh
W="deno run -A packages/cappz-edge-node/tools/saml-wizard.ts"   # add --dir <folder> (default ./saml-guard)
$W                                    # guided: steps 1–8 in order
$W keygen                             # 1. operator key: signs pins and mode changes (keep it off the guard host if you can)
$W init --upstream http://127.0.0.1:8080        # 2. config with strict defaults
$W add-tenant --id acme --metadata acme-idp.xml \
   --acs https://app.example.com/saml/acs/acme --sp-entity https://app.example.com/saml/acme   # 3. per customer
$W doctor                             # 4. configuration checks; exit 1 on errors
$W test --tenant acme --response captured.b64 --at 2026-11-09T12:00:00Z    # 5. a captured response, offline
deno run -A packages/cappz-edge-node/tools/saml-guard.ts --config saml-guard/saml.json --data saml-guard/data   # 6. shadow
$W status --verbose                   #    findings and the enforce gate, per tenant
$W enforce --tenant acme              # 7. signed switch, citing the shadow report; refused until it is ready
$W shadow --tenant acme --reason "…"  #    signed rollback, immediate
$W monitor                            # 8. systemd timers / cron for alerts and reconciliation
$W rotate --tenant acme --metadata acme-idp-2027.xml   # when the IdP rotates its certificate
```

Put the guard in front of the app's SAML endpoints (or the whole app). Pass the Host header and the scheme through, because **the login URL is how the guard knows which tenant's IdP must have signed**:

```nginx
location / {
  proxy_pass http://127.0.0.1:41451;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

On the full edge node, set `CAPPZ_SAML_CONFIG` (and optionally `CAPPZ_SAML_UPSTREAM` and `--saml 41451`) instead of running `saml-guard.ts`.

### What the Guard refuses

- **Structure.** Exactly one `Assertion` (or `EncryptedAssertion`), as a direct child of the `Response`. No DOCTYPE, entities, comments, CDATA or processing instructions. No duplicate IDs or attributes. No prefix bound to two namespaces. Size and depth limits.
- **Signature placement.** Each signature sits directly in the element it signs, with exactly one `Reference` to that element's own ID. Enveloped plus C14N without comments. RSA or ECDSA with SHA-256 or stronger.
- **The signature itself (built in since 15.37).** Exclusive C14N, then digest and RSA/ECDSA verification, **with the key of a pinned certificate only**. A certificate embedded in the response is used only if it is pinned. This covers an SP whose own signature check is broken. The SP keeps its own check, so both must pass. The verifier is tested against an independent implementation (signxml on lxml; `src/test/fixtures/`).
- **Addressing.** Issuer (response and assertion), Destination, bearer `Recipient`, every `AudienceRestriction`.
- **Time.** `IssueInstant` within 5 minutes, `NotBefore`/`NotOnOrAfter` within skew, lifetime of at most 10 minutes.
- **One use.** `InResponseTo` must name a request this tenant's SP sent (learned from its redirect to the IdP, used once). Unsolicited responses can be refused. Each assertion ID is accepted once.
- **Tenant.** A response posted to tenant A's login URL that names tenant B's IdP, SP entity, ACS URL or pinned certificate is refused as **`cross-tenant`**.

---

## 3. Configuring it properly

The doctor checks every rule below. **An error blocks `enforce`.** A warning needs a decision you can explain.

| Setting | Use | Why | Doctor |
|---|---|---|---|
| ACS URL | **One per tenant**, https | The URL picks the tenant, and so which IdP must have signed. A shared ACS lets one customer's IdP log into another. | error `acs-shared`, `acs-not-https` |
| SP entity ID | **One per tenant** (e.g. `https://app.example.com/saml/<tenant>`) | The audience check separates tenants only if their audiences differ | error `sp-entity-shared` |
| Pins | Every signing certificate in the IdP metadata, **signed for that tenant** by the operator key | A pin for one tenant never verifies at another. The certificate is a projection; the operator's signed declaration is the trust. | error `no-pin`, `pin-refused`; warn `pin-expiring` |
| `trustedPinSigners` | The operator's public key(s) only | Whoever holds a trusted key can add an IdP | error `no-trusted-signer` |
| `signature` | **`builtin`** (default) | `left-to-sp` trusts the SaaS's library. If that library is broken, forged responses pass. | error in enforce, warn in shadow |
| `requireSignedAssertion` | `true` when the IdP signs assertions (Okta, Entra, ADFS and Google do by default) | Narrows what a signature can cover | info |
| `allowUnsolicited` | `false` once logins start at the SaaS | IdP-initiated logins have no request to tie them to, which makes them easier to replay or inject. Keep `true` only for tenants that need IdP app tiles. | warn |
| `maxLifetimeSec` / `clockSkewSec` | ≤ 600 / 120–300 | IdPs issue 5-minute assertions. Fix clocks with NTP, don't widen skew. | warn |
| `encryptedAssertions` | `refuse` unless the IdP encrypts | The Guard checks only the envelope of an encrypted assertion | info |
| Mode | Start in `shadow`; enforce per tenant with `saml-wizard enforce` | The signed record cites the report it was decided on, and rollback is one command | info if set in the file |

**IdP metadata.** Get it from the customer's IdP over HTTPS (`--metadata https://…`), or confirm the certificate fingerprint with the customer out of band when it arrives as a file. The wizard says which.

**The operator key.** It signs pins and mode changes and nothing else. Keep it in a secret store and pass it as `CAPPZ_SAML_OPERATOR_KEY` when signing. The guard host needs only the public key.

**Never pick the tenant from the response.** Don't use `RelayState`, the issuer or a NameID domain. That is exactly the multi-tenant bug: the attacker controls the response. The Guard takes the tenant from the URL the browser posted to, and refuses a response that names someone else.

**Two tenants, one IdP** (a reseller, or two business units on one Okta org) is allowed, and the doctor warns (`idp-shared`, `cert-shared`). Only the audience and ACS checks separate those tenants, so make sure the IdP issues a separate audience per application.

---

## 4. Rollout: shadow, then enforce, per tenant

In **shadow** the SaaS stays in charge and the Guard records. `saml-wizard status` shows, per tenant:

- **SP-accepted / guard-refused, by reason.** Every response the SaaS **accepted** that the Guard would have refused.
  - An attack-class reason (`cross-tenant`, `bad-signature`, `bad-digest`, wrapping, replay, expiry) means the SaaS took a login it should not have. That is a finding in your SP, not in the Guard.
  - A configuration reason (`audience`, `recipient`, `destination`, `issuer`, `unpinned-certificate`) is either the same kind of finding or a Guard setting to correct. Each one has to be explained before enforcing.
- **Cross-tenant attempts.**
- **Enforce: READY** once enough responses and days have been seen (500 / 7 by default; `CAPPZ_SAML_MIN_RESPONSES`, `CAPPZ_SAML_MIN_DAYS`) and nothing is unexplained.

`saml-wizard enforce --tenant <id>` refuses while the doctor has errors for that tenant or the report isn't ready. `--force --reason "…"` records an override, reason included. The record goes to `data/saml-tenant-modes.jsonl`, signed. The guard accepts records only from trusted operator keys and applies them on the next request. `saml-wizard shadow` rolls back the same way.

---

## 5. Monitoring

Two scheduled checks. `saml-wizard monitor` prints ready-to-use systemd timers and cron lines.

| Check | How often | Fires when | Means |
|---|---|---|---|
| `saml-wizard status --alert` | 5 min | A new entry in `data/saml-alerts.jsonl` | The SaaS accepted a response the Guard refused (shadow), or a cross-tenant attempt (any mode) |
| `saml-reconcile.ts` | Daily, or after each log export | Exit 1 | A login with no issuance (`orphan`) or a replay (`reused`) |

Both exit non-zero on findings. Wire that to paging (`OnFailure=` in systemd, or `|| <alert command>` in cron). Verdict logs carry salted subject hashes, never NameIDs.

### When an alert fires

1. **Contain.** Revoke the affected sessions at the SaaS. The alert carries the tenant, reason and subject hash; the SaaS session log maps the hash back to a user. If the reason is attack-class and the tenant is still in shadow, consider `saml-wizard enforce --tenant <id> --force --reason "incident <ref>"`.
2. **Scope.** Run `saml-reconcile` for the tenant over the incident window, to find logins the IdP never issued, not just the ones the Guard saw.
3. **Root cause.** The reason names the check the SaaS skipped: `cross-tenant` (tenant binding), `audience`/`recipient` (addressing), `bad-signature`/`bad-digest` (signature), `replayed` (one-time use). Fix it in the SP, or take it to the vendor with the alert and the reconciliation report (both hashed).
4. **Record.** Cite the report hashes in the incident record.

### IdP certificate rotation

IdPs publish the next certificate before switching. Run `saml-wizard rotate --tenant <id> --metadata <new metadata>`: the new pin is added, and the old one keeps working until it expires, so both verify during the rollover. Use `--retire-old` when the IdP has finished. The doctor warns 30 days before a pin expires.

---

## 6. Limits (what it does not do)

- **The built-in verifier supports exclusive C14N only.** That's what Okta, Entra, ADFS, Google, PingFederate, Keycloak and Shibboleth emit by default. Inclusive C14N, RSA-PSS or anything else is refused as `signature-unsupported`, never passed. Plug in `verifySignature` for such an IdP.
- **Encrypted assertions:** only the envelope is checked, unless you set `encryptedAssertions: 'refuse'`.
- **`InResponseTo` is learned from the HTTP-Redirect binding** (the SP's redirect to the IdP). SPs that send AuthnRequests by HTTP-POST need `allowUnsolicited: true` or a call to `expectRequest`. The Artifact binding is not handled.
- **The Guard protects SPs whose traffic you control.** For a third party's SaaS, use reconciliation.

## 7. Upgrade path

1. **SAML as today, plus reconciliation.** Nothing in the login path changes.
2. **The Guard in front of the SPs you host:** shadow, then enforce per tenant.
3. **Bind sessions to a device key** for apps you control. After a login passes, later requests are signed with a wallet-declared key (RFC 9421, `signRequest` / KeyZ Gate). A stolen or replayed assertion is then worth nothing on its own.

Library: `createSamlGuard` (single `config` or `tenants`), `createSamlChecker`, `verifyEnvelopedSignature`, `exclusiveC14n`, `idpFromMetadata`, `lintSamlTenants`, `declareIdpPin`, `signTenantMode`, `replaySamlTenantModes` (`@cappz/sdk/edge`); `reconcileSamlLogins` and friends (`@cappz/sdk/identity`).
