/**
 * Bundle cappz-market into one file that runs on Node 20+ with no install:
 *   node packages/cappz-market/build.mjs   →  packages/cappz-market/dist/cappz-market.mjs
 * esbuild ships with vitest (vite), so no extra dependency is needed.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [join(here, 'main.ts')],
  outfile: join(here, 'dist', 'cappz-market.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node20', minify: true, legalComments: 'external',
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  define: { 'import.meta.env': '{}' },
  logLevel: 'warning',
});
console.log('built packages/cappz-market/dist/cappz-market.mjs');
