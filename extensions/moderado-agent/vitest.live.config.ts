import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const vendored = (name: string) =>
  fileURLToPath(new URL(`../../vendor/moderado/packages/${name}/dist/index.js`, import.meta.url));

// Separate config for the opt-in live provider check.
//
// `vitest.config.ts` only includes `test/**/*.test.ts`, so nothing under `live/`
// is ever picked up by the default suite or by CI. This config must be invoked
// explicitly:
//   MODERADO_LIVE=1 npx vitest run --config vitest.live.config.ts
export default defineConfig({
  resolve: {
    alias: {
      '@moderado/contracts': vendored('contracts'),
      '@moderado/core': vendored('core'),
      '@moderado/providers': vendored('providers'),
      '@moderado/tools': vendored('tools'),
    },
  },
  test: {
    include: ['live/**/*.live.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});