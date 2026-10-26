# KeyZ Gate and KeyZ declarations — security review (v15-11-00)

Scope: KeyZ Gate, the CAPPZ edge verification gateway (`src/lib/identity/edgeVerify.ts`, `packages/cappz-edge-node/verifyGateway.ts`, `tools/gateway.ts`), KeyZ, the wallet key declarations (`src/lib/identity/keyDeclaration.ts`), evidence loading (`packages/cappz-edge-node/evidence.ts`, `src/lib/identity/evidenceReload.ts`), the X.509 parser (`src/lib/identity/x509.ts`), the DMZ drop / FTPS faces and shadow comparison. Reviewed on 2026-10-26 against the failure pattern of the 2026 PHP disclosures (CVE-2026-109618, CVE-2026-109619).

## The PHP pattern, and what carries over

The PHP bugs combine four ingredients: (1) a hard failure mid-request (out of memory), (2) state that outlives the request, (3) a later request or worker reusing that state, (4) attacker input parsed before normal initialisation (multipart / upload progress, OPcache shared memory). The memory-corruption half — use-after-free, type confusion in shared memory — does not carry over: the gateway is TypeScript on Deno (V8 + Rust), with no manual memory management, no `unserialize` (only `JSON.parse`, which builds plain data), no session or upload-progress parsing, and no shared memory between processes. The logic-level half does: any state a failure leaves behind, any cache a later request trusts, any unbounded read an attacker can use to force a failure.

## Findings and fixes

| # | Finding | Risk | Fix | Test |
|---|---|---|---|---|
| 1 | Proxy/shadow mode buffered the whole request body (`req.arrayBuffer()`); the DMZ drop checked only `Content-Length`, so a chunked body bypassed it | Out-of-memory crash of the gateway process (the PHP trigger) | `readBounded` stops reading at the limit while streaming (`CAPPZ_VERIFY_MAX_BODY`, default 10 MB; drop box: policy limit); 413 | `edge-security.test.ts` · oversized chunked body |
| 2 | An unreadable / half-written `key-revocations.json` was read as empty | Fail-open: revoked keys accepted again after a failed write | Keep the last good copy; with none, fail closed (`evidence-unavailable`, 503) | unreadable evidence → 503 |
| 3 | **Found under load:** concurrent first requests got the empty default while the first evidence read was in flight | Fail-open at startup: a revoked key could pass (benchmark: 11 valid refused, 1 replay passed) | `createReloader`: callers wait for the first load; afterwards the last good copy is served while a refresh runs | concurrent first callers; failed refresh keeps last good |
| 4 | Client-controlled `cappz-wallet` used as a lookup key and echoed in headers | `__proto__` / `constructor` walk the operator map; header injection | Wallet must be a compressed secp256k1 key (66 hex) before use; `Object.hasOwn` on maps | prototype / injection wallets → malformed |
| 5 | Client-supplied `cappz-key-declaration` dereferenced before shape checks | A malformed object throws (500 for that wallet) | Size cap (4 KB) + `isDeclarationShape` before any field is read; stored junk entries skipped | wrong-shaped declarations ignored |
| 6 | Replay cache unbounded; cleanup stopped at the first live entry (expiry is not monotonic) | Memory growth from self-made keys when undeclared keys are allowed | Cap (`maxNonces`, default 1M) with full sweeps; when full, new signers are refused (503) — never forget a live nonce | full cache → 503 |
| 7 | DER length-of-length up to 127 bytes in the certificate parser | Shift overflow / reads past the buffer on a crafted mTLS header | At most 4 length bytes, all present; header capped at 16 KB | crafted lengths rejected |
| 8 | A verify fault in shadow mode would have failed the legacy request | Shadow mode must never change what the legacy path answers | Fault recorded as a CAPPZ denial; legacy still answers | shadow fault test |
| 9 | Shadow state written non-atomically | A crash mid-write loses the evidence | Write temporary file, then rename | — |
| 10 | No cap on concurrent FTPS sessions | Resource exhaustion | `CAPPZ_FTP_MAX_SESSIONS` (default 64), 421 beyond | — |
| 11 | Identity-keyed caches (by array or object) for speed | A mutated array served a stale copy: a pushed revocation was missed (caught by the existing tests) | Caches are keyed by content (signed text + signature), never by identity; per-wallet index rebuilt per file version | revocation-after-push tests |

Caches that survive across requests, and why each is safe: the declaration signature cache and the declaration hash cache are keyed by the exact signed text + signature + signer, so a different statement can never hit; imported Ed25519 keys are keyed by the key itself; content verdicts by hash + key + signature; key trust (time window, revocations) is evaluated on every request.

## Residual risks

- The runtime: V8 and Deno have had memory-safety bugs of their own (JIT type confusion). Keep Deno patched, run the gateway unprivileged and as its own process — it shares no memory with PHP workers.
- `reusePort` processes each keep their own replay cache; use it only for routes without replay protection, or hash on `cappz-wallet` (one signer → one process), as the benchmark does.
- Evidence freshness is about one second (the reload interval); a revocation written to disk applies within it.
- FTPS treats a data connection that ends without TLS close_notify as the end of an upload (as curl and most servers do); the receipt hash lets the sender confirm nothing was cut.

## Using KeyZ Gate as a compensating control for the PHP CVEs

Apply the PHP security update — it is the only complete remediation. Until then, in front of PHP routes:

1. **auth_request or proxy mode, not shadow mode.** Unsigned or unverified requests never reach PHP, which turns the published pre-authentication chains into post-authentication ones (an attacker needs a key a wallet declared). Shadow mode forwards everything and protects nothing.
2. **Body cap** (`CAPPZ_VERIFY_MAX_BODY`) and, on routes without uploads, **refuse multipart** (`CAPPZ_VERIFY_DENY_MULTIPART=1`): the disclosed chains start with multipart requests that drive PHP out of memory during startup.
3. Watch for what the researchers list: multipart requests followed by memory-limit errors or bursts of 500s, oversized `PHPSESSID` cookies, unexplained worker restarts.
4. `session.upload_progress.enabled = Off` removes the upload-progress variants only (it was `On` on the review machine's PHP 8.4.27 FPM).
