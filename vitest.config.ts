import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
  resolve: { alias: [
    // The package's own subpaths, as a user imports them (examples, tests).
    { find: /^@cappz\/sdk\/(.*)$/, replacement: path.resolve(__dirname, './src/sdk/$1') },
  ] },
});
