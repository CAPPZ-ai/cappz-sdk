/**
 * COPE node crystallized.
 * Node ID: v15-11-00-compare-verifiers
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Compare a legacy verifier (a PHP route checking signatures itself) with
 * KeyZ Gate (the CAPPZ edge verification gateway) on the same machine, then decide whether the legacy
 * path can retire. Run it on the instance type you will deploy (ARM or not):
 *
 *   deno run -A packages/cappz-edge-node/tools/compare-verifiers.ts setup \
 *     --node-data ./node-data --php-keys ./php/keys.json --out ./bench
 *   # start: the edge node (CAPPZ_VERIFY_SHADOW=1, CAPPZ_VERIFY_UPSTREAM=<php route>), nginx, php-fpm
 *   deno run -A packages/cappz-edge-node/tools/compare-verifiers.ts run --out ./bench \
 *     --legacy http://127.0.0.1:58080/legacy-only/pay \
 *     --shadow http://127.0.0.1:58080/api/pay \
 *     --enforce http://127.0.0.1:58080/edge/pay \
 *     --auth http://127.0.0.1:58080/auth/pay \
 *     --shadow-report http://127.0.0.1:51446/cappz/verify/shadow \
 *     --requests 4000 --concurrency 16 --usd-per-hour 0.034 --vcpus 2 --label "c7g.large (assumption)"
 *
 * setup writes a wallet with two declared device keys: key A in good standing,
 * key B declared then revoked by the wallet. The PHP key list holds both (it
 * cannot know about the revocation). run sends one traffic mix to every path:
 * valid (A), tampered body, unknown key, replayed request, revoked key (B).
 * Output: <out>/report.json and <out>/report.md — verdicts per path and class,
 * end-to-end latency, the gateway's shadow report (verdict agreement, both
 * verify times, cost per million at the stated price) and its retire gate.
 */

import { generateRecoveryPhrase, keyPairFromPhrase } from '../../../src/lib/auth/wallet/session.ts';
import { generateSigningKey, importSigningKey } from '../../../src/lib/sync/helloSignature.ts';
import { declareKey, revokeKeyDeclaration } from '../../../src/lib/identity/keyDeclaration.ts';
import { requestSigner, signRequest } from '../../../src/lib/identity/edgeVerify.ts';

const args = Deno.args;
const flag = (name: string, d?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
const out = flag('out', './bench')!;

async function exportKey(k: Awaited<ReturnType<typeof generateSigningKey>>) {
  // generateSigningKey makes an extractable WebCrypto key where Ed25519 exists (Deno has it).
  return { pkcs8: btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8', k.privateKey!)))), pub: k.publicKeyHex };
}

if (args[0] === 'setup') {
  await Deno.mkdir(out, { recursive: true });
  // Many clients, as in production: --wallets N (default 32), each with one declared key; wallet 0 also has
  // key B, declared then revoked. Spreading signers lets gateways scale by hashing on cappz-wallet.
  const n = Number(flag('wallets', '32'));
  const decls = []; const php: Record<string, string[]> = {}; const clients = [];
  let revoked; let b;
  for (let i = 0; i < n; i++) {
    const wallet = keyPairFromPhrase(generateRecoveryPhrase());
    const a = await generateSigningKey();
    decls.push(await declareKey(wallet.privateKey, wallet.address, { publicKey: a.publicKeyHex, algorithm: 'ed25519', purpose: 'signing' }));
    php[wallet.address] = [a.publicKeyHex];
    if (i === 0) {
      b = await generateSigningKey();
      const db = await declareKey(wallet.privateKey, wallet.address, { publicKey: b.publicKeyHex, algorithm: 'ed25519', purpose: 'signing' });
      decls.push(db);
      revoked = await revokeKeyDeclaration(wallet.privateKey, db, 'benchmark: revoked key still in the PHP key list');
      php[wallet.address].push(b.publicKeyHex);
    }
    clients.push({ wallet: wallet.address, a: await exportKey(a) });
  }
  const nodeData = flag('node-data')!; const phpKeys = flag('php-keys')!;
  await Deno.mkdir(nodeData, { recursive: true });
  await Deno.writeTextFile(`${nodeData}/key-declarations.json`, JSON.stringify(decls, null, 2));
  await Deno.writeTextFile(`${nodeData}/key-revocations.json`, JSON.stringify([revoked], null, 2));
  await Deno.writeTextFile(phpKeys, JSON.stringify(php, null, 2));
  await Deno.writeTextFile(`${out}/keys.json`, JSON.stringify({ clients, b: { wallet: clients[0].wallet, key: await exportKey(b!) } }));
  console.log(`setup: ${n} client wallets with a declared key each; wallet 0 also has key B, declared then revoked; the PHP key list holds all`);
  Deno.exit(0);
}

if (args[0] !== 'run') { console.log('usage: compare-verifiers.ts setup|run …'); Deno.exit(2); }

const keys = JSON.parse(await Deno.readTextFile(`${out}/keys.json`));
const clients = await Promise.all(keys.clients.map(async (c: { wallet: string; a: { pkcs8: string; pub: string } }) => ({ wallet: c.wallet, key: await importSigningKey(c.a.pkcs8, c.a.pub) })));
const B = { wallet: keys.b.wallet as string, key: await importSigningKey(keys.b.key.pkcs8, keys.b.key.pub) };
const stranger = await generateSigningKey();
const total = Number(flag('requests', '4000')); const conc = Number(flag('concurrency', '16'));
// legacy: PHP verifies · shadow: gateway beside PHP · enforce: gateway proxies to the app · auth: nginx auth_request to the gateway, PHP checks only the body digest
const paths: Record<string, string | undefined> = { legacy: flag('legacy'), shadow: flag('shadow'), enforce: flag('enforce'), auth: flag('auth') };

type Kind = 'valid' | 'tampered' | 'unknown-key' | 'replayed' | 'revoked-key';
// The mix: mostly good traffic, enough bad traffic that every check is exercised.
const MIX: Array<[Kind, number]> = [['valid', 0.88], ['tampered', 0.03], ['unknown-key', 0.03], ['replayed', 0.03], ['revoked-key', 0.03]];
const kindAt = (i: number): Kind => { const x = (i * 0.6180339887) % 1; let acc = 0; for (const [k, p] of MIX) { acc += p; if (x < acc) return k; } return 'valid'; };

async function build(url: string, kind: Kind, replayOf?: { headers: Headers; body: Uint8Array }, i = 0) {
  if (kind === 'replayed' && replayOf) return { headers: new Headers(replayOf.headers), body: replayOf.body };
  const body = new TextEncoder().encode(JSON.stringify({ amount: '25.00', ref: crypto.randomUUID() }));
  const c = clients[i % clients.length];
  const signer = kind === 'revoked-key' ? B : { wallet: c.wallet, key: kind === 'unknown-key' ? stranger : c.key };
  const headers = await signRequest({ method: 'POST', url, body, walletAddress: signer.wallet }, requestSigner(signer.key));
  headers.set('content-type', 'application/json');
  return { headers, body: kind === 'tampered' ? new TextEncoder().encode('{"amount":"99999.00"}') : body };
}

const pct = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };

const results: Record<string, unknown> = {};
for (const [name, url] of Object.entries(paths)) {
  if (!url) continue;
  // Warm up (connections, opcache, JIT) without counting.
  for (let i = 0; i < 50; i++) { const r = await build(url, 'valid'); await fetch(url, { method: 'POST', headers: r.headers, body: r.body as BodyInit }).then((x) => x.arrayBuffer()).catch(() => {}); }
  const lat: number[] = []; const byKind: Record<string, Record<string, number>> = {};
  let lastValid: { headers: Headers; body: Uint8Array } | undefined;
  let next = 0; const t0 = performance.now();
  await Promise.all(Array.from({ length: conc }, async () => {
    for (;;) {
      const i = next++; if (i >= total) return;
      // A replay needs a completed request to copy; until one exists the slot is ordinary valid traffic.
      const kind: Kind = kindAt(i) === 'replayed' && !lastValid ? 'valid' : kindAt(i);
      const req = await build(url, kind, lastValid, i);
      const t = performance.now();
      const res = await fetch(url, { method: 'POST', headers: req.headers, body: req.body as BodyInit });
      await res.arrayBuffer();
      // Replay only requests that completed: a copy sent while its original is in flight may win the race
      // (first seen is accepted, the other refused) — correct anti-replay, but it would mislabel the classes.
      if (kind === 'valid') lastValid = { headers: new Headers(req.headers), body: req.body };
      lat.push(performance.now() - t);
      (byKind[kind] ??= {})[String(res.status)] = ((byKind[kind] ?? {})[String(res.status)] ?? 0) + 1;
    }
  }));
  const secs = (performance.now() - t0) / 1000;
  results[name] = { url, requests: total, concurrency: conc, seconds: secs, rps: total / secs, latencyMs: { p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99) }, statusByKind: byKind };
  console.log(`${name.padEnd(8)} ${(total / secs).toFixed(0)} req/s  p50 ${pct(lat, 0.5).toFixed(2)} ms  p95 ${pct(lat, 0.95).toFixed(2)} ms  ${JSON.stringify(byKind)}`);
}

const reportUrl = flag('shadow-report');
const shadow = reportUrl ? await fetch(reportUrl).then((r) => r.json()).catch((e) => ({ error: String(e) })) : null;
const cpu = await (async () => { try { return (await Deno.readTextFile('/proc/cpuinfo')).match(/model name\s*:\s*(.+)/)?.[1] ?? Deno.build.arch; } catch { return Deno.build.arch; } })();
const report = {
  at: new Date().toISOString(),
  machine: { arch: Deno.build.arch, os: Deno.build.os, cpu, note: flag('label', 'assumption: price per hour is an input, not a quote') },
  price: { usdPerHour: Number(flag('usd-per-hour', '0.034')), vcpus: Number(flag('vcpus', '2')), source: 'assumption' },
  mix: Object.fromEntries(MIX), paths: results, shadow,
};
await Deno.writeTextFile(`${out}/report.json`, JSON.stringify(report, null, 2));
const row = (n: string) => { const r = results[n] as { rps: number; latencyMs: { p50: number; p95: number } } | undefined; return r ? `| ${n} | ${r.rps.toFixed(0)} | ${r.latencyMs.p50.toFixed(2)} | ${r.latencyMs.p95.toFixed(2)} |` : ''; };
const md = [
  `# Legacy verifier vs KeyZ Gate — ${report.at}`, '',
  `Machine: ${cpu} (${Deno.build.arch}). Price: $${report.price.usdPerHour}/hour, ${report.price.vcpus} vCPU — ${report.machine.note}.`, '',
  '| Path | req/s | p50 ms | p95 ms |', '|---|---|---|---|', row('legacy'), row('shadow'), row('enforce'), row('auth'), '',
  shadow && !('error' in shadow) ? [
    `Verdicts: ${shadow.counts.agree} agree, ${shadow.counts['cappz-stricter']} CAPPZ stricter (${Object.entries(shadow.stricterReasons).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'}), ${shadow.counts['cappz-looser']} CAPPZ looser, ${shadow.counts['legacy-missing']} without a legacy verdict.`,
    `Verify time p50: CAPPZ ${shadow.latencyMs.cappz.p50.toFixed(3)} ms, legacy ${shadow.latencyMs.legacy.p50.toFixed(3)} ms. Cost per million verifications at the stated price: CAPPZ $${shadow.usdPerMillion.cappz.toFixed(4)}, legacy $${shadow.usdPerMillion.legacy.toFixed(4)}.`,
    `Retire gate: ${shadow.retire.ready ? 'READY' : 'not yet'} — ${shadow.retire.because.join('; ')}. Report hash ${shadow.reportHash}.`,
  ].join('\n') : 'No shadow report.',
].join('\n');
await Deno.writeTextFile(`${out}/report.md`, md + '\n');
console.log('\n' + md);
