/**
 * COPE node crystallized.
 * Node ID: v15-12-00-php-port-tool
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Move a PHP app off php-fpm, one route at a time, with evidence:
 *
 *   # 1 · inventory + scaffold (reads code and logs; changes nothing)
 *   deno run -A packages/cappz-edge-node/tools/php-port.ts inventory --src /var/www/app \
 *     --log /var/log/nginx/access.log --crontab crontab.txt --out ./port
 *   #    → port/PLAN.md, port/inventory.json, port/routes.ts (every handler notPorted()), port/nginx.conf
 *
 *   # 2 · run the route host in front of PHP (all routes stay on PHP until a port is written)
 *   deno run -A --unstable-net packages/cappz-edge-node/tools/php-port.ts serve --port 41450 --routes ./port/routes.ts \
 *     --upstream http://127.0.0.1:8080 --data ./node-data
 *
 *   # 3 · write a handler in port/routes.ts — it is shadowed automatically; send only ported routes
 *   #     through the host (the rest stays nginx → php-fpm) and watch the evidence
 *   deno run -A packages/cappz-edge-node/tools/php-port.ts nginx > /etc/nginx/cappz-routes.conf && nginx -s reload
 *   deno run -A packages/cappz-edge-node/tools/php-port.ts status
 *
 *   # 4 · an operator key (once), then cut over when the gate passes; roll back any time
 *   deno run -A packages/cappz-edge-node/tools/php-port.ts operator --out operator.json --data ./node-data
 *   deno run -A packages/cappz-edge-node/tools/php-port.ts cutover  --route "GET /api/orders/:id" --operator operator.json
 *   deno run -A packages/cappz-edge-node/tools/php-port.ts rollback --route "GET /api/orders/:id" --operator operator.json --because "…"
 *
 * The node must run with CAPPZ_NODE_KEY (it signs the cut-over TX) and the operator's wallet in
 * CAPPZ_ROUTE_OPERATORS. In the CAPPZ console the same step is the admin verb edge.route.cutover.
 */

import { inventoryPhpApp, nginxSnippet, planMarkdown, scaffoldRoutes, type PhpSource } from '../../../src/lib/legacyPort/phpInventory.ts';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../../../src/lib/auth/wallet/session.ts';
import { generateSigningKey, importSigningKey } from '../../../src/lib/sync/helloSignature.ts';
import { declareKey } from '../../../src/lib/identity/keyDeclaration.ts';
import { requestSigner, signRequest } from '../../../src/lib/identity/edgeVerify.ts';

const args = Deno.args;
const flag = (name: string, d?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
const flags = (name: string) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const control = flag('control', 'http://127.0.0.1:41451')!;

async function walk(dir: string, base = dir, out: PhpSource[] = []): Promise<PhpSource[]> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) { if (!['vendor', 'node_modules', '.git', 'storage', 'cache'].includes(e.name)) await walk(p, base, out); continue; }
    if (e.isFile && (e.name.endsWith('.php') || e.name === 'artisan')) {
      const st = await Deno.stat(p); if (st.size > 2 * 1024 * 1024) continue;
      out.push({ path: p.slice(base.length + 1), text: await Deno.readTextFile(p) });
    }
  }
  return out;
}

const cmd = args[0];
if (cmd === 'inventory') {
  const src = flag('src'); const out = flag('out', './port')!;
  if (!src) { console.log('inventory --src <php app> [--log access.log]… [--crontab file] [--docroot public/] [--out ./port]'); Deno.exit(2); }
  const t0 = performance.now();
  const files = await walk(src.replace(/\/$/, ''));
  const logs = (await Promise.all(flags('log').map((f) => Deno.readTextFile(f)))).join('\n');
  const inv = inventoryPhpApp({ files, accessLog: logs || undefined, crontab: flag('crontab') ? await Deno.readTextFile(flag('crontab')!) : undefined, docroot: flag('docroot') });
  await Deno.mkdir(out, { recursive: true });
  await Deno.writeTextFile(`${out}/inventory.json`, JSON.stringify(inv, null, 2));
  await Deno.writeTextFile(`${out}/PLAN.md`, planMarkdown(inv));
  await Deno.writeTextFile(`${out}/nginx.conf`, nginxSnippet());
  // Route stubs import the route host from this checkout; never overwrite handlers already written.
  const rel = new URL('../../../src/lib/legacyPort/routeHost.ts', import.meta.url).pathname;
  try { await Deno.stat(`${out}/routes.ts`); console.log(`kept ${out}/routes.ts (already exists); new stubs are in ${out}/routes.new.ts`); await Deno.writeTextFile(`${out}/routes.new.ts`, scaffoldRoutes(inv, rel)); }
  catch { await Deno.writeTextFile(`${out}/routes.ts`, scaffoldRoutes(inv, rel)); }
  console.log(`${inv.framework.join(', ')}: ${inv.files} PHP files, ${inv.totals.routes} routes (wave 1: ${inv.totals.byWave[1]}, 2: ${inv.totals.byWave[2]}, 3: ${inv.totals.byWave[3]}, 4: ${inv.totals.byWave[4]}), ${inv.tables.length} tables, ${inv.cron.length} cron jobs — ${(performance.now() - t0).toFixed(0)} ms`);
  for (const w of inv.warnings) console.log(`warning: ${w}`);
  console.log(`plan: ${out}/PLAN.md`);
  Deno.exit(0);
}

if (cmd === 'serve') {
  const { serveRoutes } = await import('../routes.ts');
  if (flag('routes')) Deno.env.set('CAPPZ_ROUTES_MODULE', flag('routes')!);
  if (flag('upstream')) Deno.env.set('CAPPZ_ROUTES_UPSTREAM', flag('upstream')!);
  if (args.includes('--verify')) Deno.env.set('CAPPZ_ROUTES_VERIFY', '1');
  if (args.includes('--reuse-port')) Deno.env.set('CAPPZ_ROUTES_REUSE_PORT', '1');
  if (flag('default-mode')) Deno.env.set('CAPPZ_ROUTES_DEFAULT_MODE', flag('default-mode')!);
  const port = Number(flag('port', '41450'));
  if (flag('control-port')) Deno.env.set('CAPPZ_ROUTES_CONTROL_PORT', flag('control-port')!);
  if (flag('instance')) Deno.env.set('CAPPZ_ROUTES_INSTANCE', flag('instance')!);
  const dataDir = flag('data', Deno.env.get('CAPPZ_NODE_DATA') ?? './node-data')!;
  Deno.env.set('CAPPZ_NODE_DATA', dataDir); // ports that replay the node's TXs read the same log
  await serveRoutes({ port, dataDir, nodeAddress: Deno.env.get('CAPPZ_POW') ?? "m/44'/144'/0'/cappz/operational/route-host" });
} else if (cmd === 'operator') {
  // A wallet for the operator (or --phrase-file for an existing one) declares an Ed25519 signing key.
  const phrase = flag('phrase-file') ? (await Deno.readTextFile(flag('phrase-file')!)).trim() : generateRecoveryPhrase();
  const wallet = keyPairFromPhrase(phrase);
  const k = await generateSigningKey();
  const declaration = await declareKey(wallet.privateKey, wallet.address, { publicKey: k.publicKeyHex, algorithm: 'ed25519', purpose: 'signing' });
  const pkcs8 = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8', k.privateKey!))));
  const out = flag('out', 'operator.json')!;
  await Deno.writeTextFile(out, JSON.stringify({ walletAddress: wallet.address, declaration, key: { pkcs8, pub: k.publicKeyHex } }, null, 2), { mode: 0o600 });
  if (!flag('phrase-file')) { await Deno.writeTextFile(`${out}.phrase`, phrase + '\n', { mode: 0o600 }); console.log(`new operator wallet; recovery phrase in ${out}.phrase — move it offline`); }
  const data = flag('data');
  if (data) {
    let decls: unknown[] = []; try { decls = JSON.parse(await Deno.readTextFile(`${data}/key-declarations.json`)); } catch { /* none yet */ }
    decls.push(declaration);
    await Deno.writeTextFile(`${data}/key-declarations.json.tmp`, JSON.stringify(decls, null, 2)); await Deno.rename(`${data}/key-declarations.json.tmp`, `${data}/key-declarations.json`);
    console.log(`declaration added to ${data}/key-declarations.json`);
  }
  console.log(`operator ${wallet.address} — add it to CAPPZ_ROUTE_OPERATORS on the node`);
} else if (cmd === 'status') {
  const rows = await (await fetch(`${control}/cappz/routes`)).json() as Array<{ route: string; mode: string; requests: number; matchPct: number; mismatches: number; portErrors: number; ready: boolean; p50Ms: { legacy: number; port: number } }>;
  for (const r of rows) console.log(`${r.ready ? 'READY ' : '      '}${r.mode.padEnd(8)} ${r.route.padEnd(40)} ${String(r.requests).padStart(7)} compared  ${r.matchPct.toFixed(2).padStart(6)}% match  ${r.mismatches} mismatch  ${r.portErrors} errors  p50 PHP ${r.p50Ms.legacy.toFixed(2)} ms / port ${r.p50Ms.port.toFixed(2)} ms`);
} else if (cmd === 'nginx') {
  // Only ported routes go through the route host; write this to the include and reload nginx.
  Deno.stdout.writeSync(new TextEncoder().encode(await (await fetch(`${control}/cappz/routes/nginx`)).text()));
} else if (cmd === 'report') {
  console.log(JSON.stringify(await (await fetch(`${control}/cappz/routes/report?route=${encodeURIComponent(flag('route') ?? '')}`)).json(), null, 2));
} else if (cmd === 'cutover' || cmd === 'rollback') {
  const op = JSON.parse(await Deno.readTextFile(flag('operator', 'operator.json')!));
  const key = await importSigningKey(op.key.pkcs8, op.key.pub);
  const url = `${control}/cappz/routes/mode`;
  const report = cmd === 'cutover' ? await (await fetch(`${control}/cappz/routes/report?route=${encodeURIComponent(flag('route') ?? '')}`)).json() : null;
  const body = new TextEncoder().encode(JSON.stringify({ route: flag('route'), mode: cmd === 'cutover' ? 'serve' : flag('to', 'legacy'), because: flag('because', cmd === 'cutover' ? 'shadow report passed' : ''), reviewedHash: report?.reportHash }));
  const headers = await signRequest({ method: 'POST', url, body, walletAddress: op.walletAddress, declaration: op.declaration }, requestSigner(key));
  headers.set('content-type', 'application/json');
  const res = await fetch(url, { method: 'POST', headers, body });
  console.log(res.status, JSON.stringify(await res.json(), null, 2));
  Deno.exit(res.ok ? 0 : 1);
} else {
  console.log('usage: php-port.ts inventory | serve | nginx | status | report | operator | cutover | rollback  (see the header of this file)');
  Deno.exit(2);
}
