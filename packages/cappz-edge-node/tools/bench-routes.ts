/**
 * COPE node crystallized.
 * Node ID: v15-12-00-bench-routes
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Load the same request mix against several deployments of one app and write
 * report.json: requests per second, latency percentiles and status counts.
 *   deno run -A packages/cappz-edge-node/tools/bench-routes.ts --base php=http://127.0.0.1:58180 \
 *     --base shadow=http://127.0.0.1:58181 --base serve=http://127.0.0.1:58182 \
 *     --path "/api/orders.php" --path "/api/orders.php?status=open" --path "/api/orders.php?id=o-0042" \
 *     --path "/api/orders.php?id=o-9999" --requests 20000 --concurrency 32 --out ./bench
 * --clients N runs N load processes (one client tops out first). Warm-up requests are not counted.
 * Same machine, same mix, one deployment at a time.
 */
const args = Deno.args;
const flags = (n: string) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));
const flag = (n: string, d: string) => flags(n)[0] ?? d;
const bases = flags('base').map((b) => { const i = b.indexOf('='); return { name: b.slice(0, i), url: b.slice(i + 1) }; });
const paths = flags('path');
const total = Number(flag('requests', '20000')); const conc = Number(flag('concurrency', '32')); const out = flag('out', './bench');
const pct = (xs: number[], q: number) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];

async function run(base: string, n: number, withLatencies = false) {
  const lat: number[] = []; const statuses: Record<string, number> = {}; let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++; if (i >= n) return;
      const t0 = performance.now();
      const r = await fetch(base + paths[i % paths.length]); await r.arrayBuffer();
      lat.push(performance.now() - t0); statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: conc }, worker));
  const s = (performance.now() - t0) / 1000; lat.sort((a, b) => a - b);
  return { requests: n, seconds: +s.toFixed(3), rps: Math.round(n / s), p50Ms: +pct(lat, 0.5).toFixed(2), p95Ms: +pct(lat, 0.95).toFixed(2), p99Ms: +pct(lat, 0.99).toFixed(2), statuses, ...(withLatencies ? { lat: lat.map((x) => +x.toFixed(3)) } : {}) };
}

// --clients N: N load processes (one Deno client tops out near 25k req/s), latencies merged exactly.
const clients = Number(flag('clients', '1'));
if (args.includes('--child')) {
  const r = await run(bases[0].url, total, true);
  console.log(JSON.stringify(r));
  Deno.exit(0);
}

async function runMany(base: string, n: number) {
  if (clients <= 1) return run(base, n);
  const self = new URL(import.meta.url).pathname;
  const per = Math.ceil(n / clients);
  const t0 = performance.now();
  const outs = await Promise.all(Array.from({ length: clients }, () => new Deno.Command(Deno.execPath(), { args: ['run', '-A', self, '--child', '--base', `x=${base}`, ...paths.flatMap((p) => ['--path', p]), '--requests', String(per), '--concurrency', String(Math.ceil(conc / clients))], stdout: 'piped' }).output()));
  const s = (performance.now() - t0) / 1000;
  const parts = outs.map((o) => JSON.parse(new TextDecoder().decode(o.stdout).trim().split('\n').pop()!));
  const lat = parts.flatMap((p) => p.lat as number[]).sort((a, b) => a - b); const statuses: Record<string, number> = {};
  for (const p of parts) for (const [k, v] of Object.entries(p.statuses as Record<string, number>)) statuses[k] = (statuses[k] ?? 0) + v;
  // Wall time includes process start; each child's own window is the fairer rate.
  const window = Math.max(...parts.map((p) => p.seconds));
  return { requests: lat.length, seconds: +window.toFixed(3), rps: Math.round(lat.length / window), p50Ms: +pct(lat, 0.5).toFixed(2), p95Ms: +pct(lat, 0.95).toFixed(2), p99Ms: +pct(lat, 0.99).toFixed(2), statuses, clients, wallSeconds: +s.toFixed(3) };
}

const results: Record<string, unknown> = {};
for (const b of bases) {
  await run(b.url, Math.min(2000, total / 5));
  results[b.name] = await runMany(b.url, total);
  console.log(b.name.padEnd(10), JSON.stringify(results[b.name]));
}
await Deno.mkdir(out, { recursive: true });
await Deno.writeTextFile(`${out}/report.json`, JSON.stringify({ at: new Date().toISOString(), concurrency: conc, paths, results }, null, 2));
