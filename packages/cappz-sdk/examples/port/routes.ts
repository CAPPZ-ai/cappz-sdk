/**
 * The orders API from examples/php-app, ported (v15-12-00). Served by the route host:
 *   deno run -A --unstable-net packages/cappz-edge-node/tools/php-port.ts serve --routes packages/cappz-sdk/examples/port/routes.ts \
 *     --upstream http://127.0.0.1:8080 --data ./node-data
 * In your own project import from '@cappz/sdk/port'; this file imports the source so it runs from the repo.
 *
 * Matching PHP exactly is the work, and the shadow comparison finds every place it differs:
 *   - isset($_GET['id']) is true for ?id= (empty string) → query.has, not query.get
 *   - round(array_sum(...), 2) → sum in integer cents (the amounts have two decimals)
 *   - gmdate('c') differs every second → ignored ($.generatedAt)
 *   - the HTML page (session + CSRF) is not ported: it stays on PHP
 *
 * Where the port deliberately does not match PHP (v15-12-01, tools/write-race.ts):
 *   - PHP reads the whole file, appends and writes it back: overlapping POSTs overwrite each other
 *     (201 for orders never stored) or read a half-written file (500). The port emits one signed TX
 *     per order, appended by the host, so nothing it confirmed can be overwritten.
 *   - PHP numbers an order count + 1, so overlapping requests get the same id. The port uses a
 *     random id, which cannot collide; the shadow ignores $.order.id.
 */
import { readFile, stat } from 'node:fs/promises';
import { defineRoute, type PortedRoute } from '../../../../src/lib/legacyPort/routeHost.ts';

interface Order { id: string; customer: string; amount: number; status: string; items: unknown[] }

// Stand-in for a wallet view of the imported orders table: the file, plus the orders this node has
// written since cut-over (ContentCreated TXs replayed from its log). Re-read on change, at most once a second.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const FILE = env.CAPPZ_ORDERS_FILE ? new URL(`file://${env.CAPPZ_ORDERS_FILE}`) : new URL('../php-app/data/orders.json', import.meta.url);
const LOG = env.CAPPZ_NODE_DATA ? new URL(`file://${env.CAPPZ_NODE_DATA.replace(/\/$/, '')}/edge-txs.jsonl`) : null;
const mtimeOf = (u: URL | null) => (u ? stat(u).then((x) => x.mtimeMs, () => -1) : Promise.resolve(-1));
let cache: { at: number; key: string; orders: Order[] } = { at: 0, key: '', orders: [] };
async function orders(): Promise<Order[]> {
  if (Date.now() - cache.at < 1000) return cache.orders;
  const key = `${await mtimeOf(FILE)}|${await mtimeOf(LOG)}`;
  if (key === cache.key) { cache = { ...cache, at: Date.now() }; return cache.orders; }
  const file: Order[] = JSON.parse(await readFile(FILE, 'utf8'));
  const written = LOG ? (await readFile(LOG, 'utf8').catch(() => '')).split('\n')
    .filter((l) => l.includes('"ContentCreated"') && l.includes('"kind":"order"'))
    .map((l) => (JSON.parse(l) as { payload: { order: Order } }).payload.order) : [];
  cache = { at: Date.now(), key, orders: [...file, ...written] };
  return cache.orders;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const gmdateC = () => new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');

export const routes: PortedRoute[] = [
  defineRoute({
    method: 'GET', path: '/api/orders.php', legacySource: 'public/api/orders.php',
    compare: { ignoreJsonPaths: ['$.generatedAt'] },
    handler: async (_req, ctx) => {
      const all = await orders();
      if (ctx.query.has('id')) {
        const o = all.find((x) => x.id === ctx.query.get('id'));
        return o ? json({ order: o, generatedAt: gmdateC() }) : json({ error: 'no such order' }, 404);
      }
      const status = ctx.query.has('status') ? ctx.query.get('status') : null;
      const list = all.filter((o) => status === null || o.status === status);
      const cents = list.reduce((a, o) => a + Math.round(o.amount * 100), 0);
      return json({ orders: list, count: list.length, total: cents / 100, generatedAt: gmdateC() });
    },
  }),
  defineRoute({
    method: 'POST', path: '/api/orders.php', legacySource: 'public/api/orders.php',
    // PHP's id is count + 1 (overlapping requests share it); the port's is random, so ids are not compared.
    compare: { ignoreJsonPaths: ['$.order.id'] },
    handler: async (req, ctx) => {
      let input: { customer?: unknown; amount?: unknown };
      try { input = await req.json(); } catch { input = {}; }
      const amount = typeof input?.amount === 'number' ? input.amount : typeof input?.amount === 'string' && input.amount.trim() !== '' && Number.isFinite(Number(input.amount)) ? Number(input.amount) : NaN;
      if (!input || typeof input !== 'object' || typeof input.customer !== 'string' || !(amount > 0)) return json({ error: 'customer (string) and amount (> 0) are required' }, 422);
      const order: Order = { id: `o-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`, customer: input.customer, amount: Math.round(amount * 100) / 100, status: 'open', items: [] };
      // Written by the host in serve mode (signed by the node key); only counted in shadow mode.
      ctx.emit({ eventType: 'ContentCreated', targetAddress: `orders/${order.id}`, payload: { kind: 'order', order } });
      return json({ order }, 201);
    },
  }),
];
