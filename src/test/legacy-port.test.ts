/** v15-12-00 — move a PHP app off php-fpm route by route: inventory, response shadow, route host, cut-over. */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync, mkdtempSync, cpSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { compareResponses, createRouteShadow, mergeRouteStates, type CapturedResponse } from '../lib/legacyPort/responseShadow';
import { compileRoutes, createRouteHost, defineRoute, isPorted, nginxLocations, notPorted, replayRouteModes, type PortedRoute } from '../lib/legacyPort/routeHost';
import { inventoryPhpApp, parseAccessLog, planMarkdown, scaffoldRoutes, type PhpSource } from '../lib/legacyPort/phpInventory';
import type { VerifyGateway } from '../lib/identity/edgeVerify';
import * as sdkPort from '@cappz/sdk/port';
import { fileURLToPath } from 'node:url';

// Repo-relative files resolve from this file, so the tests run from any working directory (also as a submodule).
const ROOT = join(fileURLToPath(import.meta.url), '../../..');

const enc = new TextEncoder();
const res = (status: number, type: string, body: string, extra: Record<string, string> = {}): CapturedResponse => ({ status, headers: new Headers({ 'content-type': type, ...extra }), body: enc.encode(body) });
const J = 'application/json';
const cost = { instanceUsdPerHour: 0.034, vcpus: 2, label: 'assumption' };

describe('response comparison', () => {
  it('compares JSON by value, not bytes, under explicit rules', () => {
    expect(compareResponses(res(200, J, '{"a":1,"b":[1,2]}'), res(200, J, '{ "b": [1, 2], "a": 1 }'))).toEqual([]);
    expect(compareResponses(res(200, J, '{"a":1}'), res(200, J, '{"a":2}'))).toEqual(['$.a value']);
    expect(compareResponses(res(200, J, '{"a":1}'), res(404, J, '{"a":1}'))).toEqual(['status 200≠404']);
    expect(compareResponses(res(200, J, '{"t":"x","n":{"u":1}}'), res(200, J, '{"t":"y","n":{"u":2}}'), { ignoreJsonPaths: ['$.t', '$..u'] })).toEqual([]);
    expect(compareResponses(res(200, J, '{"items":[{"at":1,"v":1},{"at":2,"v":1}]}'), res(200, J, '{"items":[{"at":9,"v":1},{"at":8,"v":1}]}'), { ignoreJsonPaths: ['$.items[*].at'] })).toEqual([]);
    // PHP json_encode writes an empty associative array as [].
    expect(compareResponses(res(200, J, '{"meta":[]}'), res(200, J, '{"meta":{}}'))).toEqual([]);
    expect(compareResponses(res(200, J, '{"meta":[]}'), res(200, J, '{"meta":{}}'), { emptyArrayEqualsObject: false })).toEqual(['$.meta value']);
    expect(compareResponses(res(200, J, '{"a":1}'), res(200, J, '{"a":1,"extra":true}'))).toEqual(['$.extra only in port']);
  });

  it('normalises HTML whitespace, blanks declared token patterns, compares media types and Location', () => {
    expect(compareResponses(res(200, 'text/html; charset=UTF-8', '<p>\n  hi </p>  <b>x</b>'), res(200, 'text/html', '<p> hi </p><b>x</b>'))).toEqual([]);
    const a = res(200, 'text/html', '<input name="_token" value="abc">'); const b = res(200, 'text/html', '<input name="_token" value="zzz">');
    expect(compareResponses(a, b)).toEqual(['body text']);
    expect(compareResponses(a, b, { ignorePatterns: ['value="[^"]*"'] })).toEqual([]);
    expect(compareResponses(res(302, 'text/html', '', { location: '/a' }), res(302, 'text/html', '', { location: '/b' }))).toEqual(['header location']);
    expect(compareResponses(res(200, 'application/xml', '<a/>'), res(200, J, '<a/>'))).toEqual(['header content-type']);
  });

  it('gates cut-over on traffic, days, mismatches and port errors; keeps locations, not bodies', async () => {
    let t = 0; const s = createRouteShadow({ now: () => t, policy: { minRequests: 3, minDays: 1, maxMismatches: 0, maxPortErrors: 0 } });
    for (let i = 0; i < 3; i++) s.record('GET /x', { outcome: 'match', method: 'GET', path: '/x', legacyStatus: 200, portStatus: 200, legacyMs: 2, portMs: 0.3 });
    expect((await s.report('GET /x', cost)).cutover.because[0]).toMatch(/days/);
    t = 2 * 86400_000;
    s.record('GET /x', { outcome: 'match', method: 'GET', path: '/x', legacyStatus: 404, portStatus: 404 });
    const ok = await s.report('GET /x', cost);
    expect(ok.cutover.ready).toBe(true);
    expect(ok.reportHash).toMatch(/^[0-9a-f]{64}$/);
    s.record('GET /x', { outcome: 'mismatch', method: 'GET', path: '/x?secret=1', where: ['$.total value'] });
    const bad = await s.report('GET /x', cost);
    expect(bad.cutover.ready).toBe(false);
    expect(JSON.stringify(bad.samples)).toContain('$.total value');
    // Evidence from sibling processes merges (reuse-port shadows report as one).
    const other = createRouteShadow({ now: () => t }); other.record('GET /x', { outcome: 'match', method: 'GET', path: '/x', legacyMs: 1 });
    const merged = mergeRouteStates([s.state()['GET /x'], other.state()['GET /x']])!;
    expect(merged.counts.match).toBe(5);
    expect((await s.report('GET /x', cost, [other.state()['GET /x']])).requests).toBe(6);
  });
});

function upstream(handler: (req: Request) => Response | Promise<Response>) {
  const calls: string[] = [];
  return { calls, fetch: async (req: Request) => { calls.push(`${req.method} ${new URL(req.url).pathname}${new URL(req.url).search}`); return handler(req); } };
}

describe('route host', () => {
  const legacyApp = upstream((req) => {
    const u = new URL(req.url);
    if (u.pathname === '/api/item') return Response.json({ id: u.searchParams.get('id'), at: Date.now() });
    if (u.pathname === '/api/boom') return new Response('fail', { status: 500 });
    return new Response(`legacy ${u.pathname}`, { headers: { 'content-type': 'text/plain' } });
  });
  const routes: PortedRoute[] = [
    defineRoute({ method: 'GET', path: '/api/item', compare: { ignoreJsonPaths: ['$.at'] }, handler: (_r, ctx) => Response.json({ id: ctx.query.get('id'), at: 0 }) }),
    defineRoute({ method: 'POST', path: '/api/items', handler: (_r, ctx) => { ctx.emit({ eventType: 'ContentCreated', targetAddress: 'items/1', payload: { kind: 'item' } }); return Response.json({ ok: true }, { status: 201 }); } }),
    defineRoute({ method: 'GET', path: '/api/users/:id', handler: notPorted }),
    defineRoute({ method: 'GET', path: '/api/wrong', handler: () => Response.json({ v: 2 }) }),
  ];

  it('matches exact paths, :params, HEAD as GET, and a trailing *', () => {
    const m = compileRoutes([...routes, defineRoute({ method: 'GET', path: '/files/*', handler: notPorted })]);
    expect(m('GET', '/api/item')?.c.key).toBe('GET /api/item');
    expect(m('HEAD', '/api/item/')?.c.key).toBe('GET /api/item');
    expect(m('GET', '/api/users/a%20b')?.params).toEqual({ id: 'a b' });
    expect(m('GET', '/files/a/b.txt')?.params['*']).toBe('a/b.txt');
    expect(m('POST', '/api/item')).toBeNull();
    expect(m('GET', '/api/users/%E0%A4%A')).toBeNull();
  });

  it('shadow: answers with legacy, compares the port off the hot path, and never writes', async () => {
    const shadow = createRouteShadow();
    const writes: unknown[] = [];
    const host = createRouteHost({ routes, upstream: legacyApp.fetch, defaultMode: 'shadow', shadow, write: async (e) => { writes.push(...e); } });
    const r = await host.handle(new Request('http://app/api/item?id=7'));
    expect((await r.json()).at).not.toBe(0); // the legacy body
    const w = await host.handle(new Request('http://app/api/items', { method: 'POST', body: '{}' }));
    expect(w.status).toBe(200); // legacy answered (its own text); the port's 201 was only compared
    await host.handle(new Request('http://app/api/wrong'));
    await host.drain();
    const item = await shadow.report('GET /api/item', cost);
    expect(item.counts.match).toBe(1);
    const created = await shadow.report('POST /api/items', cost);
    expect(created.counts.mismatch).toBe(1);
    expect(created.effects).toEqual({ ContentCreated: 1 });
    expect(writes).toEqual([]);
    expect((await shadow.report('GET /api/wrong', cost)).samples[0].where[0]).toMatch(/header content-type|body/);
  });

  it('a port that throws is a port error, and the visitor still gets the legacy answer', async () => {
    const shadow = createRouteShadow();
    const host = createRouteHost({ routes: [defineRoute({ method: 'GET', path: '/api/item', handler: () => { throw new Error('not yet'); } })], upstream: legacyApp.fetch, defaultMode: 'shadow', shadow });
    expect((await host.handle(new Request('http://app/api/item?id=1'))).status).toBe(200);
    await host.drain();
    expect((await shadow.report('GET /api/item', cost)).counts['port-error']).toBe(1);
  });

  it('serve: the port answers, PHP is not called, effects are written; notPorted stays legacy', async () => {
    const app = upstream(() => new Response('legacy'));
    const writes: Array<{ eventType: string }> = [];
    const host = createRouteHost({ routes, upstream: app.fetch, modes: () => ({ 'POST /api/items': 'serve', 'GET /api/users/:id': 'serve' }), write: async (e) => { writes.push(...e); } });
    const r = await host.handle(new Request('http://app/api/items', { method: 'POST', body: '{}' }));
    expect(r.status).toBe(201);
    expect(writes.map((w) => w.eventType)).toEqual(['ContentCreated']);
    expect(await (await host.handle(new Request('http://app/api/users/1'))).text()).toBe('legacy');
    expect(app.calls).toEqual(['GET /api/users/1']);
    // A writing port with no writer refuses rather than dropping the write.
    const noWriter = createRouteHost({ routes, modes: () => ({ 'POST /api/items': 'serve' }) });
    expect((await noWriter.handle(new Request('http://app/api/items', { method: 'POST', body: '{}' }))).status).toBe(503);
  });

  it('with no legacy upstream, unknown paths are 404; legacy 5xx is not held against the port', async () => {
    const host = createRouteHost({ routes, modes: () => ({ 'GET /api/item': 'serve' }) });
    expect((await host.handle(new Request('http://app/old.php'))).status).toBe(404);
    expect((await host.handle(new Request('http://app/api/item?id=2'))).status).toBe(200);
    const shadow = createRouteShadow();
    const h2 = createRouteHost({ routes: [defineRoute({ method: 'GET', path: '/api/boom', handler: () => new Response('ok') })], upstream: legacyApp.fetch, defaultMode: 'shadow', shadow });
    await h2.handle(new Request('http://app/api/boom')); await h2.drain();
    expect((await shadow.report('GET /api/boom', cost)).counts['legacy-error']).toBe(1);
  });

  it('KeyZ Gate in front: refused requests reach neither legacy nor port; handlers see the verdict', async () => {
    const app = upstream(() => new Response('legacy'));
    const verify = { verifyRequest: async (req: Request) => (req.headers.get('signature') ? { allowed: true, status: 200, signature: 'verified', trust: 'declared', content: 'not-checked', anchor: 'unchecked', walletAddress: '02' + 'a'.repeat(64), because: '' } : { allowed: false, status: 401, signature: 'unsigned', trust: 'undeclared', content: 'not-checked', anchor: 'unchecked', because: 'unsigned' }) } as unknown as VerifyGateway;
    let seen = '';
    const host = createRouteHost({ routes: [defineRoute({ method: 'GET', path: '/me', handler: (_r, ctx) => { seen = ctx.verdict?.walletAddress ?? ''; return new Response('me'); } })], upstream: app.fetch, verify, modes: () => ({ 'GET /me': 'serve' }) });
    expect((await host.handle(new Request('http://app/me'))).status).toBe(401);
    expect((await host.handle(new Request('http://app/me', { headers: { signature: 'x' } }))).status).toBe(200);
    expect(seen).toMatch(/^02a/);
    expect(app.calls).toEqual([]);
  });

  it('bounded shadow capacity: an overloaded host skips comparisons instead of slowing replies', async () => {
    const shadow = createRouteShadow();
    const slow = defineRoute({ method: 'GET', path: '/api/item', handler: () => new Promise<Response>((ok) => setTimeout(() => ok(Response.json({ id: '1', at: 0 })), 30)) });
    const host = createRouteHost({ routes: [slow], upstream: legacyApp.fetch, defaultMode: 'shadow', shadow, maxShadowInflight: 1 });
    await Promise.all([1, 2, 3].map((i) => host.handle(new Request(`http://app/api/item?id=${i}`))));
    await host.drain();
    expect((await shadow.report('GET /api/item', cost)).counts.skipped).toBe(2);
  });

  it('modes replay from the signed TXs; nginx gets locations for ported routes only', () => {
    const modes = replayRouteModes([
      { eventType: 'LegacyRouteCutOver', timestamp: '2026-10-26T10:00:00Z', payload: { route: 'GET /a', reportHash: 'h1' } },
      { eventType: 'LegacyRouteRolledBack', timestamp: '2026-10-26T11:00:00Z', payload: { route: 'GET /a', to: 'shadow' } },
      { eventType: 'LegacyRouteCutOver', timestamp: '2026-10-26T09:00:00Z', payload: { route: 'GET /b', reportHash: 'h2' } },
    ]);
    expect(modes['GET /a'].mode).toBe('shadow');
    expect(modes['GET /b']).toMatchObject({ mode: 'serve', reportHash: 'h2' });
    const conf = nginxLocations(routes);
    expect(conf).toContain('location = /api/item {');
    expect(conf).not.toContain('/api/users');
    expect(nginxLocations([defineRoute({ method: 'GET', path: '/v1/orders/:id.json', handler: () => new Response('') })])).toContain('location ~ ^/v1/orders/[^/]+$');
    expect(isPorted(routes[2])).toBe(false);
  });
});

const read = (dir: string): PhpSource[] => {
  const out: PhpSource[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith('.php')) out.push({ path: relative(dir, p), text: readFileSync(p, 'utf8') }); } };
  walk(dir); return out;
};

describe('PHP inventory', () => {
  it('reads the example app: routes, waves, traffic, includes and cron', () => {
    const log = [
      '127.0.0.1 - - [26/Oct/2026:10:00:00 +0000] "GET /api/orders.php?id=o-0001 HTTP/1.1" 200 120 "-" "curl"',
      '127.0.0.1 - - [26/Oct/2026:10:00:01 +0000] "GET /api/orders.php HTTP/1.1" 200 9000 "-" "curl"',
      '127.0.0.1 - - [26/Oct/2026:10:00:02 +0000] "POST /api/orders.php HTTP/1.1" 201 80 "-" "curl"',
      '127.0.0.1 - - [26/Oct/2026:10:00:03 +0000] "GET / HTTP/1.1" 200 2000 "-" "Mozilla"',
      '127.0.0.1 - - [26/Oct/2026:10:00:04 +0000] "GET /legacy/report HTTP/1.1" 500 10 "-" "Mozilla"',
      '127.0.0.1 - - [26/Oct/2026:10:00:05 +0000] "GET /style.css HTTP/1.1" 200 10 "-" "Mozilla"',
    ].join('\n');
    const inv = inventoryPhpApp({ files: read(join(ROOT, 'packages/cappz-sdk/examples/php-app')), accessLog: log, crontab: '*/5 * * * * php /var/www/app/cron/cleanup.php\n0 3 * * * /usr/bin/backup.sh' });
    expect(inv.framework).toEqual(['plain']);
    const keys = inv.routes.map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(['GET /api/orders.php', 'POST /api/orders.php', 'GET /']));
    expect(keys.some((k) => k.includes('lib/'))).toBe(false); // included files are not routes
    const get = inv.routes.find((r) => r.key === 'GET /api/orders.php')!;
    expect(get.hits).toBe(2);
    expect(get.uses.output).toBe('json');
    const post = inv.routes.find((r) => r.key === 'POST /api/orders.php')!;
    expect(post.uses.writes).toEqual(['files']); // the JSON-file "database"
    expect(post.wave).toBe(2);
    expect(get.uses.reads).toEqual(['files']);
    expect(inv.routes.find((r) => r.key === 'GET /')!.wave).toBe(3); // session
    expect(inv.unmapped.map((u) => u.path)).toEqual(['GET /legacy/report']);
    expect(inv.cron).toHaveLength(1);
    expect(planMarkdown(inv)).toContain('Wave 3');
    const scaffold = scaffoldRoutes(inv);
    expect(scaffold).toContain("path: '/api/orders.php'");
    expect(scaffold).toContain('handler: notPorted');
  });

  it('reads framework routes, controller methods, tables, sessions, secrets and libraries', () => {
    const files: PhpSource[] = [
      { path: 'artisan', text: '#!/usr/bin/env php' },
      { path: 'routes/api.php', text: "<?php\nRoute::get('/orders/{id}', [OrderController::class, 'show']);\nRoute::post('/orders', 'OrderController@store');\nRoute::get('/health', function () { return response()->json(['ok' => true]); });\nRoute::post('/pay', [PayController::class, 'charge']);" },
      { path: 'app/Http/Controllers/OrderController.php', text: "<?php\nclass OrderController {\n  public function show($id) { $o = DB::table('orders')->where('id', $id)->first(); return response()->json($o); }\n  public function store() { session()->put('x', 1); DB::table('orders')->insert(['a' => 1]); $pdo->query(\"UPDATE customers SET n = n + 1\"); return response()->json([]); }\n}" },
      { path: 'app/Http/Controllers/PayController.php', text: "<?php\nclass PayController {\n  public function charge() { $k = env('STRIPE_SECRET'); $c = curl_init('https://api.stripe.com'); $pdf = new Dompdf(); return response()->json([]); }\n}" },
    ];
    const inv = inventoryPhpApp({ files, accessLog: '"GET /orders/12 HTTP/1.1" 200 1\n"GET /orders/13 HTTP/1.1" 200 1\n"GET /health HTTP/1.1" 200 1' });
    expect(inv.framework).toContain('laravel');
    const by = Object.fromEntries(inv.routes.map((r) => [r.key, r]));
    expect(by['GET /orders/:id']).toMatchObject({ wave: 1, hits: 2, source: 'app/Http/Controllers/OrderController.php#show' });
    expect(by['GET /orders/:id'].uses.reads).toEqual(['orders']);
    expect(by['POST /orders'].uses.writes).toEqual(['customers', 'orders']);
    expect(by['POST /orders'].wave).toBe(3); // session
    expect(by['POST /pay']).toMatchObject({ wave: 4, destination: 'hosted-secrets-last', effort: 'L' });
    expect(by['POST /pay'].uses.secrets).toEqual(['STRIPE_SECRET']);
    expect(by['GET /health'].wave).toBe(1);
    expect(inv.routes[0].wave).toBe(1); // ordered: wave first
    expect(inv.tables.find((t) => t.table === 'orders')).toMatchObject({ readers: ['GET /orders/:id'], writers: ['POST /orders'] });
    expect(inv.libraries.map((l) => l.name)).toEqual(expect.arrayContaining(['curl', 'pdf']));
  });

  it('parses combined access logs, ignoring the query string', () => {
    const m = parseAccessLog('"GET /a?x=1 HTTP/1.1" 200 1\n"GET /a/ HTTP/2.0" 502 1');
    expect(m.get('GET /a')).toEqual({ hits: 2, errors: 1 });
  });
});

const hasPhp = spawnSync('php', ['-v'], { encoding: 'utf8' }).status === 0;

describe('the example port against the real PHP app', () => {
  it.skipIf(!hasPhp)('every compared response matches (php -S), including the empty-string query cases', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cappz-php-'));
    cpSync(join(ROOT, 'packages/cappz-sdk/examples/php-app'), dir, { recursive: true });
    process.env.CAPPZ_ORDERS_FILE = join(dir, 'data/orders.json');
    const port = 20000 + Math.floor(Math.random() * 20000);
    const php = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', join(dir, 'public')], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/api/orders.php?id=o-0001`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
      const { routes } = await import('../../packages/cappz-sdk/examples/port/routes.ts');
      const shadow = createRouteShadow();
      const host = createRouteHost({ routes, upstream: `http://127.0.0.1:${port}`, defaultMode: 'shadow', shadow });
      for (const q of ['', '?status=open', '?status=shipped', '?status=', '?id=o-0042', '?id=o-9999', '?id=']) await host.handle(new Request(`http://app/api/orders.php${q}`));
      await host.handle(new Request('http://app/api/orders.php', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customer: 'Ada', amount: 12.5 }) }));
      await host.handle(new Request('http://app/api/orders.php', { method: 'POST', body: '{"customer":1}' }));
      await host.drain();
      const get = await shadow.report('GET /api/orders.php', cost);
      expect(get.samples).toEqual([]);
      expect(get.counts.match).toBe(7);
      const post = await shadow.report('POST /api/orders.php', cost);
      expect(post.samples).toEqual([]);
      expect(post.counts.match).toBe(2);
      expect(post.effects).toEqual({ ContentCreated: 1 });
    } finally { php.kill(); delete process.env.CAPPZ_ORDERS_FILE; }
  }, 30_000);
});

describe('overlapping writes (v15-12-01, tools/write-race.ts)', () => {
  it('the served port keeps every order it confirms, with distinct ids, and lists them from the node log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cappz-race-'));
    cpSync(join(ROOT, 'packages/cappz-sdk/examples/php-app/data/orders.json'), join(dir, 'orders.json'));
    process.env.CAPPZ_ORDERS_FILE = join(dir, 'orders.json'); process.env.CAPPZ_NODE_DATA = dir;
    try {
      vi.resetModules();
      const { routes } = await import('../../packages/cappz-sdk/examples/port/routes.ts');
      const written: { eventType: string; targetAddress: string; payload: Record<string, unknown> }[] = [];
      const host = createRouteHost({ routes, defaultMode: 'serve', write: async (effects) => { written.push(...effects); } });
      const replies = await Promise.all(Array.from({ length: 100 }, (_, n) => host.handle(new Request('http://app/api/orders.php', { method: 'POST', body: JSON.stringify({ customer: `race-${n}`, amount: 1 }) }))));
      expect(replies.map((r) => r.status)).toEqual(Array(100).fill(201));
      expect(new Set(written.map((e) => e.targetAddress)).size).toBe(100);
      // The host appends one signed TX per effect; the port's view replays them.
      writeFileSync(join(dir, 'edge-txs.jsonl'), written.map((e) => JSON.stringify(e)).join('\n') + '\n');
      await new Promise((r) => setTimeout(r, 1100));
      const list = await (await host.handle(new Request('http://app/api/orders.php'))).json() as { count: number; orders: { id: string }[] };
      expect(list.count).toBe(300);
      expect(new Set(list.orders.map((o) => o.id)).size).toBe(300);
    } finally { delete process.env.CAPPZ_ORDERS_FILE; delete process.env.CAPPZ_NODE_DATA; vi.resetModules(); }
  }, 15_000);
});

describe('@cappz/sdk/port', () => {
  it('exports the route host, the shadow and the inventory', () => {
    for (const k of ['createRouteHost', 'createRouteShadow', 'compareResponses', 'defineRoute', 'notPorted', 'nginxLocations', 'replayRouteModes', 'inventoryPhpApp', 'planMarkdown', 'scaffoldRoutes']) expect(typeof (sdkPort as Record<string, unknown>)[k], k).toBe('function');
  });
});
