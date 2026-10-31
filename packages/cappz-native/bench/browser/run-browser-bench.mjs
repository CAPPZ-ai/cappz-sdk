/**
 * Run bench.ts in the browsers installed on this machine and print a table.
 *
 *   npm i --no-save playwright-core esbuild hash-wasm   (once; uses installed browsers, downloads none)
 *   node packages/cappz-native/bench/browser/run-browser-bench.mjs [msedge] [chrome]
 *
 * The page is served on 127.0.0.1 only. Results: bench/browser/results-<browser>.json
 */
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const sdk = path.resolve(here, '../../../..');
const out = mkdtempSync(path.join(tmpdir(), 'cappz-browser-bench-'));
await build({ entryPoints: [path.join(here, 'bench.ts')], bundle: true, format: 'esm', target: 'es2022', outfile: path.join(out, 'bench.js'), nodePaths: [path.join(sdk, 'node_modules')], logLevel: 'error' });
await build({ entryPoints: [path.join(here, 'kernel-worker-entry.ts')], bundle: true, format: 'esm', target: 'es2022', outfile: path.join(out, 'kernel-worker.js'), nodePaths: [path.join(sdk, 'node_modules')], logLevel: 'error' });
copyFileSync(path.join(sdk, 'src/lib/native/wasm/cappz_native.wasm'), path.join(out, 'cappz_native.wasm'));
for (const extra of ['cappz_native_sig.wasm']) { try { copyFileSync(path.join(sdk, 'src/lib/native/wasm', extra), path.join(out, extra)); } catch { /* optional */ } }
writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><title>cappz bench</title><pre id="log"></pre><script type="module" src="bench.js"></script>');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  const file = path.join(out, path.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[\\/]+/, '') || 'index.html');
  if (!file.startsWith(out)) { res.writeHead(403).end(); return; }
  try { const body = readFileSync(file); res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' }).end(body); }
  catch { res.writeHead(404).end(); }
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}/index.html`;

const channels = process.argv.slice(2).length ? process.argv.slice(2) : ['msedge', 'chrome'];
for (const channel of channels) {
  const browser = await chromium.launch({ channel, headless: true });
  const page = await browser.newPage();
  await page.goto(url);
  const result = await page.waitForFunction(() => window.__benchResults, null, { timeout: 15 * 60_000, polling: 1000 }).then((h) => h.jsonValue());
  await browser.close();
  writeFileSync(path.join(here, `results-${channel}.json`), JSON.stringify({ date: new Date().toISOString(), ...result }, null, 2) + '\n');
  console.log(`\n## ${channel} — ${result.ua}`);
  if (result.error) console.log('ERROR', result.error);
  let group = '';
  for (const r of result.rows) {
    if (r.group !== group) { group = r.group; console.log(`\n${group}`); }
    console.log(r.unit ? `  ${r.name.padEnd(42)} ${r.rate.toFixed(r.rate < 10 ? 2 : 0).padStart(9)} ${r.unit}   ${r.ms.toFixed(1)} ms` : `  ${r.name}`);
  }
}
server.close();
