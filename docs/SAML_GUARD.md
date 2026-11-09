# SAML: catch forged logins, then refuse them

SAML single sign-on fails in a predictable way. The identity provider (IdP) is fine. The SaaS service provider (SP) accepts an assertion it should have refused, for one of two reasons:

- **Two parsers disagree.** The signature check reads one part of the XML and the login code reads another. Examples are signature wrapping, namespace confusion, and a comment splitting the NameID.
- **The SP checks the signature but not the rest.** It never checks that the assertion was meant for it: audience, recipient, destination, issuer, time, or a one-time use.

CAPPZ adds two things, both in the public SDK and the edge node. Neither needs any change to the SaaS or the IdP.

| | What it does | Where it runs | What you need |
|---|---|---|---|
| **Reconciliation** | Finds SaaS logins your IdP never issued (detection) | Anywhere: laptop, edge node timer, CI | Two log exports |
| **SAML Guard** | Refuses ambiguous or misdirected responses before the SP sees them (prevention) | In front of an SP you host or can proxy | One proxy hop |

You cannot fix a third party's SAML validation from outside. Reconciliation is the part that works for any SaaS. The Guard works for SPs whose traffic you control.

## 1. Reconciliation: every session needs a matching issuance

```sh
deno run --allow-read --allow-write packages/cappz-edge-node/tools/saml-reconcile.ts \
  --issued okta:okta-system-log.json \
  --logins csv:saas-audit.csv --logins-map saas-map.json \
  --out report.json
```

- **`--issued`** is what your IdP issued. Supported forms:
  - `okta:` for an Okta System Log export (successful `user.authentication.sso` events);
  - `entra:` for Microsoft Entra sign-in logs (`errorCode` 0);
  - `csv:` or `json:` for anything else, together with `--issued-map`.
- **`--logins`** is the SaaS's own audit log of SSO logins. A field map names its columns:

```json
{ "at": "timestamp", "subject": "user.email", "app": { "constant": "saas" },
  "where": { "event_type": "sso_login" }, "assertionId": "saml.assertion_id", "ip": "client_ip" }
```

- **`--apps apps.json`** maps the names each side uses for the same application to one id. For example: `{ "Saas (Okta)": "saas", "saas": "saas" }`.
- **`--aliases`** maps other subject identifiers (such as employee ids) to the IdP's subject.

Each SaaS login is matched to an issuance for the same subject and application. If both logs carry an assertion ID, the match is exact. Otherwise it is the nearest unused issuance in the 5 minutes before the login (`--window-min`). Each login ends up in one of these states:

| State | Meaning |
|---|---|
| `matched` | An issuance accounts for it |
| `orphan` | **No issuance at all: a session your IdP never issued.** Revoke it and investigate. |
| `reused` | The only issuances (or the assertion ID) already started another session: a replay |
| `unmapped-app` | The IdP issued nothing for this application in the whole period. This is a mapping gap or an app without SSO, not a clean result. |
| `outside-coverage` | The login falls outside the time range the IdP export covers |

The exit code is 0 for clean, 1 for findings and 2 for gaps only, so a timer or CI job can alert on it. The report is hashed (`reportHash`), so an incident record can cite exactly the evidence it was based on.

### Tamper evidence

An attacker who can forge assertions may also be able to edit IdP logs. To guard against that, seal issuance as it arrives:

```sh
saml-reconcile.ts seal --issued okta:today.json --data ./node-data   # CAPPZ_NODE_KEY / CAPPZ_NODE_PUB
saml-reconcile.ts --sealed ./node-data --logins csv:saas.csv --logins-map map.json
```

Each batch is signed by the node and chained to the one before it. It holds `sha256(salt|subject)`, never the NameID. A batch that is removed or edited makes verification fail (`openSealedBatches`).

Library: `reconcileSamlLogins`, `issuedFromOktaSystemLog`, `issuedFromEntraSignIns`, `issuedFromRecords`, `loginsFromRecords`, `parseCsv`, `sealIssuedBatch`, `openSealedBatches`, `hashLogins` (`@cappz/sdk/identity`).

The Okta and Entra readers follow those vendors' documented export fields (`eventType`, `actor.alternateId`, `target[].type = AppInstance`, `outcome.result`; `userPrincipalName`, `appDisplayName`, `status.errorCode`, `createdDateTime`). Check them against your own export once: a field your tenant names differently makes rows disappear from the issuance side. Those logins then show up as `unmapped-app`, never as clean.

## 2. SAML Guard: refuse ambiguity, don't interpret it

```sh
# pin the IdP's signing certificate with the operator's key (its public key goes in trustedPinSigners)
deno run -A packages/cappz-edge-node/tools/saml-guard.ts pin --idp https://idp.example.com/ --cert idp.pem --days 365 --data ./node-data
# shadow in front of the SP
deno run -A packages/cappz-edge-node/tools/saml-guard.ts --config saml.json --upstream http://127.0.0.1:8080 --data ./node-data
```

```json
{ "idpEntityId": "https://idp.example.com/", "spEntityId": "https://app.example.com",
  "acsUrls": ["https://app.example.com/saml/acs"], "trustedPinSigners": ["<hex>"], "allowUnsolicited": true }
```

On the full edge node, set `CAPPZ_SAML_CONFIG` and `CAPPZ_SAML_UPSTREAM` (and optionally `--saml 41451`, `CAPPZ_SAML_MODE=enforce`).

The Guard refuses a response if any of these checks fails:

- **Structure:**
  - exactly one `Assertion` or `EncryptedAssertion`, as a direct child of the `Response`;
  - no DOCTYPE, entity, comment, CDATA or processing instruction;
  - no duplicate IDs or attributes;
  - no namespace prefix bound to two different namespaces anywhere;
  - size and depth limits.
- **Signatures:**
  - each signature sits directly inside the element it signs;
  - it has exactly one `Reference`, and that reference is `#<that element's ID>`;
  - transforms are limited to enveloped-signature plus C14N without comments;
  - algorithms are RSA or ECDSA with SHA-256 or stronger;
  - either the assertion is signed, or the response containing it is (`requireSignedAssertion` requires the former).
- **Certificate:** an embedded certificate must match an operator-signed, unexpired pin (`declareIdpPin`). The certificate is a projection; the trust comes from the wallet's declaration.
- **Addressing:** Issuer (response and assertion), Destination, bearer `Recipient`, and every `AudienceRestriction`.
- **Time:** `IssueInstant` within 5 minutes, `NotBefore` and `NotOnOrAfter` within clock skew, and a lifetime of at most 10 minutes.
- **One use:** `InResponseTo` must name a request the SP sent. The Guard learns these from the SP's HTTP-Redirect to the IdP, and each one is accepted once. Unsolicited responses can be refused with `allowUnsolicited: false`. An assertion ID is accepted only once.

**The Guard does not replace the SP's signature check.** It does not verify the XML signature cryptographically unless you plug in a verifier (`verifySignature`). Its verdict says which happened (`signature: left-to-sp | verified`). The SP keeps its own check, so both must pass. An attacker then has to fool two different parsers, and the Guard never trusts content it cannot place unambiguously.

Verdicts go to `<data>/saml-verdicts.jsonl` with a salted subject hash, never the NameID. A request that passes reaches the SP with `Cappz-Saml-Verdict: pass` and `Cappz-Saml-Subject-Hash`. Any such headers a client sent are stripped first.

### Shadow, then enforce

In shadow mode the SP stays authoritative. `GET /cappz/saml/report` returns:

- **`spAcceptedGuardRefused`, by reason:** every response the SP **accepted** that the Guard would have refused.
  - An attack-class reason (wrapping, comment, replay, expiry…) means the SP took a login it should not have.
  - A configuration reason (`audience`, `recipient`, `destination`, `issuer`) is either the same finding (the SP does not check that field) or a Guard misconfiguration. Each one has to be explained.
- **`enforce.ready`:** true once enough responses and days have been seen (500 / 7 by default) and no unexplained configuration reasons remain.

Switch to `CAPPZ_SAML_MODE=enforce` when the gate passes. Refused responses then never reach the SP (403), and the SP keeps its own check.

## 3. Upgrade path

The same steps as moving off PHP or off X.509, each taken on evidence:

1. **SAML as today, plus reconciliation.** Nothing in the login path changes.
2. **SAML with the Guard in front of the SPs you host:** shadow, then enforce.
3. **Signed requests instead of bearer assertions** for apps you control. Once the Guard has passed a login, the app can bind the session to a wallet-declared device key, and later requests are signed with that key (RFC 9421, `signRequest` / KeyZ Gate). A stolen or replayed assertion is then worth nothing on its own.

Each step is optional, and the earlier ones keep working.
