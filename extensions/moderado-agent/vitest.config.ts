import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const vendored = (name: string) =>
  fileURLToPath(new URL(`../../vendor/moderado/packages/${name}/dist/index.js`, import.meta.url));

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
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});