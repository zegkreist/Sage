import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';

export default defineConfig({
  plugins: [svelte({ hot: !process.env.VITEST })],
  test: {
    globals:     true,
    environment: 'jsdom',
    setupFiles:  ['./src/tests/setup.js'],
    // Force Svelte to resolve the browser (client) bundle, not SSR
    server: {
      deps: { inline: [/^svelte/] },
    },
    coverage: {
      provider:   'v8',
      reporter:   ['text', 'lcov', 'html'],
      include:    ['src/lib/**', 'src/components/**'],
      thresholds: { statements: 70, branches: 70, functions: 70, lines: 70 },
    },
  },
  resolve: {
    alias: { $lib: resolve('./src/lib') },
    conditions: ['browser', 'import', 'module', 'default'],
  },
});
