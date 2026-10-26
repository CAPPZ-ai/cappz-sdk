/**
 * COPE node crystallized.
 * Node ID: v15-12-01-write-race
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Send N overlapping writes to each deployment of one app, then read back what it
 * stored: how many writes it confirmed (2xx), how many it really kept, how many
 * it lost, how many failed, and whether ids repeat.
 *   deno run -A packages/cappz-edge-node/tools/write-race.ts --base php=http://127.0.0.1:58180 \
 *     --base port=http://127.0.0.1:58182 --path /api/orders.php --requests 100 --concurrency 50 --out ./race
 * --body is the POST body; {n} becomes the request number. The list (GET --path) must return
 * { <--items>: [{ <--id>: … }] }. --settle-ms waits for views that refresh (the port: 1 s).
 * Run it against a copy of the data: it writes.
 */
const args = Deno.args;
const flags = (n: string) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));
const flag = (n: string, d: string) => flags(n)[0] ?? d;
const bases = flags('base').map((b) => { const i = b.indexOf('='); return { name: b.slice(0, i), url: b.slice(i + 1) }; });
const path = flag('path', '/api/orders.php');
const total = Number(flag('requests', '100')); const conc = Number(flag('concurrency', '50'));
const body = flag('body', '{"customer":"race-{n}","amount":1}');
const items = flag('items', 'orders'); const idField = flag('id', 'id');
const settle = Number(flag('settle-ms', '1500')); const out = flag('out', '');

async function ids(base: string): Promise<string[]> {
  const r = await fetch(base + path);
  const j = await r.json() as Record<string, unknown>;
  return (j[items] as Record<string, unknown>[]).map((o) => String(o[idField]));
}

async function race(base: string) {
  const before = new Set(await ids(base));
  const statuses: Record<string, number> = {}; let next = 0;
  const worker = async () => {
    for (;;) {
      const n = next++; if (n >= total) return;
      try {
        const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body.replaceAll('{n}', String(n + 1)) });
        await r.arrayBuffer(); statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      } catch { statuses.unreachable = (statuses.unreachable ?? 0) + 1; }
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  await new Promise((r) => setTimeout(r, settle));
  const after = (await ids(base)).filter((x) => !before.has(x));
  const confirmed = Object.entries(statuses).filter(([s]) => /^2\d\d$/.test(s)).reduce((a, [, c]) => a + c, 0);
  const failed = Object.entries(statuses).filter(([s]) => !/^[24]\d\d$/.test(s)).reduce((a, [, c]) => a + c, 0);
  const unique = new Set(after).size;
  return { sent: total, confirmed, kept: after.length, lost: Math.max(0, confirmed - after.length), failed, duplicateIds: after.length - unique, statuses };
}

const results: Record<string, unknown> = {};
for (const b of bases) {
  results[b.name] = await race(b.url);
  console.log(b.name.padEnd(8), JSON.stringify(results[b.name]));
}
const report = { measuredAt: new Date().toISOString(), tool: 'packages/cappz-edge-node/tools/write-race.ts', path, requests: total, concurrency: conc, results };
if (out) { await Deno.mkdir(out, { recursive: true }); await Deno.writeTextFile(`${out}/write-race.json`, JSON.stringify(report, null, 1)); }
