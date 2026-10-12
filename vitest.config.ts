import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/** Unit tests for storage, saving and file handling. IndexedDB is provided by fake-indexeddb. */
export default defineConfig({
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/unit/setup.ts'],
  },
});
