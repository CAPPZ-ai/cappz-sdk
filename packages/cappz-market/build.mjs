/**
 * Bundle cappz-market into one file that runs on Node 20+ with no install:
 *   node packages/cappz-market/build.mjs   →  packages/cappz-market/dist/cappz-market.mjs
 * esbuild ships with vitest (vite), so no extra dependency is needed.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
// The bundle is published to npm by CI, which rebuilds it from an npm install and refuses a committed
// bundle that differs. Deno (deno.json nodeModulesDir: auto) can re-lay node_modules out as symlinks
// into node_modules/.deno; esbuild then sees other paths and minifies to different bytes. Build from npm's layout.
if (existsSync(join(here, '..', '..', 'node_modules', '.deno'))) {
  console.error('node_modules is laid out by Deno (node_modules/.deno), so this build would not match the one CI publishes.\nReinstall with npm, then build again:  rm -rf node_modules && npm ci && npm run market:build');
  process.exit(1);
}
await build({
  entryPoints: [join(here, 'main.ts')],
  outfile: join(here, 'dist', 'cappz-market.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node20', minify: true, legalComments: 'external',
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  define: { 'import.meta.env': '{}' },
  logLevel: 'warning',
});
console.log('built packages/cappz-market/dist/cappz-market.mjs');
