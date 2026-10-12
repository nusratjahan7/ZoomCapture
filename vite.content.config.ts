import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Builds the click-tracker content script as one self-contained classic script
 * (dist/content/click-tracker.js). Files injected with chrome.scripting.executeScript cannot be
 * ES modules that import shared chunks, so it is bundled separately from the extension pages.
 */
export default defineConfig(({ mode }) => ({
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
  },
  publicDir: false,
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: false,
    target: 'chrome120',
    sourcemap: mode === 'development' ? 'inline' : false,
    minify: mode !== 'development',
    lib: {
      entry: resolve(import.meta.dirname, 'src/content/clickTracker.ts'),
      formats: ['iife'],
      name: 'ZoomCaptureClickTracker',
      fileName: () => 'content/click-tracker.js',
    },
  },
}));
