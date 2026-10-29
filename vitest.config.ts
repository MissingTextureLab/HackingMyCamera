import { defineConfig } from 'vitest/config';

// Kept apart from vite.config.ts: the engine tests are plain TS and don't need
// the Svelte plugin or the dev-server settings.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    pool: 'threads',
  },
});
