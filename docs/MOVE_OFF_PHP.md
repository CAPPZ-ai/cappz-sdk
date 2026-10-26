# Move a PHP app off php-fpm, route by route (v15-12-00)

Tutorial with an in-browser inventory: https://cappz.ai/tutorials/move-off-php

The move is the strangler pattern with evidence at every step. Nothing changes until a route is
ported, compared and cut over; every cut-over and rollback is a signed record; when no route is
left, php-fpm stops. Public HTTPS keeps its certificate on nginx/Caddy.

## The pieces

| Piece | Code | What it does |
|---|---|---|
| Inventory | `src/lib/legacyPort/phpInventory.ts`, `tools/php-port.ts inventory` | Reads the code (+ access logs, crontab): routes (plain files, Laravel, Slim/Lumen/Silex, CodeIgniter 4, Symfony), what each touches, waves, effort, a table/file-store list with readers and writers, cron, libraries to replace. Writes `PLAN.md`, `routes.ts` (every handler `notPorted`), `nginx.conf`. Lexical: it reads, it does not run |
| Route host | `src/lib/legacyPort/routeHost.ts`, `packages/cappz-edge-node/routes.ts` | Per route: `legacy` (forward to PHP), `shadow` (PHP answers; the port runs dry beside it), `serve` (the port answers). Precompiled matcher, no per-request I/O |
| Response shadow | `src/lib/legacyPort/responseShadow.ts` | Compares status, headers (media type, Location) and body: JSON by value with ignore paths, HTML normalised, token patterns blanked, PHP's `[]`/`{}` equal. Keeps where responses differ, never the bodies. Mergeable across processes |
| Cut-over | `POST /cappz/routes/mode` on the control port, `php-port.ts cutover / rollback`, verbs `edge.route.cutover` / `edge.route.rollback` | An operator's KeyZ-signed request (declared key, wallet in `CAPPZ_ROUTE_OPERATORS`); the node checks the gate at that moment and signs `LegacyRouteCutOver` (report hash) or `LegacyRouteRolledBack`. Modes are replayed from those TXs |
| Process | `src/bpmn/substrate/legacy-port.bpmn` | Inventory → write port → shadow → review → gate → cut over → healthy? → (rollback) → routes left? → stop php-fpm |

## Steps

```sh
deno run -A packages/cappz-edge-node/tools/php-port.ts inventory --src /var/www/app --log /var/log/nginx/access.log --out ./port
deno run -A --unstable-net packages/cappz-edge-node/tools/php-port.ts serve --port 41450 --routes ./port/routes.ts --upstream http://127.0.0.1:8080 --data ./node-data
# write a handler in port/routes.ts, then send only ported routes through the host
deno run -A packages/cappz-edge-node/tools/php-port.ts nginx > /etc/nginx/cappz-routes.conf && nginx -s reload
deno run -A packages/cappz-edge-node/tools/php-port.ts status
deno run -A packages/cappz-edge-node/tools/write-race.ts --base php=http://127.0.0.1:8080 --base port=http://127.0.0.1:41450 --path /api/orders.php   # copies of the data: it writes
deno run -A packages/cappz-edge-node/tools/php-port.ts operator --out operator.json --data ./node-data
deno run -A packages/cappz-edge-node/tools/php-port.ts cutover --route "GET /api/orders.php" --operator operator.json
deno run -A packages/cappz-edge-node/tools/php-port.ts rollback --route "GET /api/orders.php" --operator operator.json --because "..."
```

## Where each part of a PHP app goes

| PHP | CAPPZ |
|---|---|
| Handlers | `defineRoute` handlers on the edge node |
| Signature checks, sessions | KeyZ Gate in front (`CAPPZ_ROUTES_VERIFY=1`); handlers read `ctx.verdict` — passkeys instead of `PHPSESSID` |
| Tables and file stores | Wallet TXs and replayed views; each moves whole after its last PHP writer is cut over |
| Writes | `ctx.emit()` — counted in shadow, signed by the node key and appended after cut-over; a writing port with no node key refuses (503) rather than dropping a write |
| Uploads | DMZ quarantine |
| Cron | BPMN timers (`jobs.ts`) |
| Third-party secrets | Wave 4, hosted only where the secret forces it |

## Measured (x86-64 WSL2, i9-14900KS — not ARM)

`src/content/benchmarks/php-port-2026-10-26.json`, the example orders API and its port, 60,000
requests, 64 concurrent, 4 load processes:

| Deployment | req/s | p50 ms | p99 ms |
|---|---|---|---|
| PHP, 8 workers | 19,114 | 3.31 | 4.46 |
| PHP, 32 workers | 34,662 | 1.68 | 4.60 |
| Shadow (temporary), 4 processes | 11,249 | 5.05 | 12.82 |
| Port served via nginx, 4 processes | 45,593 | 1.29 | 3.96 |
| Port served directly | 50,804 | 1.13 | 3.45 |

Shadow evidence: 84,051 of 84,051 responses matched (200 and 404), handler p50 0.28 ms against
a 2.23 ms PHP round trip. A cut-over through the signed path stopped PHP receiving the route
within about a second.

### Overlapping writes (v15-12-01)

`tools/write-race.ts`, `src/content/benchmarks/php-port-writes-2026-10-26.json`: 100 orders posted
50 at a time, three rounds, a fresh copy of the data each round, then the list read back.

| Deployment | Sent | Confirmed (201) | Kept | Confirmed but lost | Failed (500) | Duplicate ids |
|---|---|---|---|---|---|---|
| nginx → php-fpm, 32 workers | 300 | 88 | 12 | 76 | 212 | 0 |
| nginx → 4 port processes (serve) | 300 | 300 | 300 | 0 | 0 | 0 |

Why PHP fails: `load_orders()` reads the whole file, the request appends, `save_orders()` writes it
back, so overlapping requests overwrite each other; `save_orders()` ignores whether the write worked,
so the answer is 201 either way. A request that reads while another writes gets a truncated file and
throws `TypeError: load_orders(): Return value must be of type array, null returned` (500). The same
code on `php -S` with 8 workers confirmed 83 and kept 39, then 76 and 36.

Why the port holds: each order is one `ContentCreated` TX, signed by the node key and appended to
the node log; the list replays the log over the imported file. Ids are random: PHP's count + 1 hands
overlapping requests the same id (the port did the same before v15-12-01). A write the host cannot
record is refused with 503, never confirmed.

The shadow does not find lost writes: PHP answers 201 for them, so the responses match. It does count
PHP's own 5xx separately from the port. Run `write-race.ts` against a copy of the data before a write
route is cut over.

Performance notes from building it:

- Unported routes never pass through the route host: nginx gets locations for ported routes
  only (`nginxLocations`), so PHP's own path is unchanged during the move.
- The first shadow run did 917 req/s: the JSON comparison re-parsed every ignore pattern at
  every node. Precompiled patterns, a byte-identical fast path and an in-place path stack cut
  a 31 KB comparison to 0.35 ms; four processes with merged evidence gave 11,249 req/s.
- Shadows are capacity-bounded (`maxShadowInflight`): an overloaded host counts a skipped
  comparison instead of slowing a reply. `CAPPZ_ROUTES_SAMPLE` samples busy routes.

## Limits

- It does not translate PHP to TypeScript; you write each handler (the plan, scaffold and
  comparison make that small and safe).
- Detection is lexical: dynamic includes, generated SQL and run-time routes can be missed. The
  access log surfaces paths no definition explains.
- For write routes, the port runs after PHP has written, so values such as the next id differ
  by design; declare them as rules. Effects are counted, never written, until cut-over.
- The example port's view (imported file + replayed TXs) stands in for a wallet view; after a write
  route cuts over, PHP no longer sees new rows, so the table's readers move with it.
- Default mode `serve` is refused while a PHP upstream is configured: with PHP running, routes
  move only by `edge.route.cutover` on their report.
