import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const srcDir = resolve(import.meta.dirname, 'src');

/**
 * Multi-entry build that emits a loadable Manifest V3 extension into `dist/`.
 *
 * - Each extension page is an HTML entry (`src/<page>/index.html` → `dist/<page>/index.html`).
 * - The service worker is emitted at a fixed path (`dist/background.js`) because the
 *   manifest references it by name. It is an ES module worker (`"type": "module"`).
 * - `public/` (manifest + icons) is copied verbatim to the root of `dist/`.
 */
export default defineConfig(({ mode }) => ({
  root: srcDir,
  publicDir: resolve(import.meta.dirname, 'public'),
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': srcDir },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: mode === 'development' ? 'inline' : false,
    minify: mode !== 'development',
    // Extension pages are local; the modulepreload polyfill would also leak `document` into the worker.
    modulePreload: { polyfill: false },
    rolldownOptions: {
      input: {
        popup: resolve(srcDir, 'popup/index.html'),
        recording: resolve(srcDir, 'recording/index.html'),
        editor: resolve(srcDir, 'editor/index.html'),
        settings: resolve(srcDir, 'settings/index.html'),
        background: resolve(srcDir, 'background/index.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
}));
