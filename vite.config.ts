import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const srcDir = resolve(import.meta.dirname, 'src');

/**
 * pdf.js loads fonts, character maps, colour profiles and image decoders (WebAssembly) at run
 * time. Extensions can't load code from the network, so they ship with it under `dist/pdfjs/`.
 */
function pdfjsAssets(): Plugin {
  const root = resolve(import.meta.dirname, 'node_modules', 'pdfjs-dist');
  return {
    name: 'zoomcapture-pdfjs-assets',
    generateBundle() {
      for (const folder of ['cmaps', 'standard_fonts', 'iccs', 'wasm']) {
        for (const file of readdirSync(join(root, folder))) {
          this.emitFile({ type: 'asset', fileName: `pdfjs/${folder}/${file}`, source: readFileSync(join(root, folder, file)) });
        }
      }
    },
  };
}

/**
 * Multi-entry build that emits a loadable Manifest V3 extension into `dist/`.
 *
 * - Each extension page is an HTML entry (`src/<page>/index.html` → `dist/<page>/index.html`).
 * - The service worker is emitted at a fixed path (`dist/background.js`) because the
 *   manifest references it by name. It is an ES module worker (`"type": "module"`).
 * - `public/` (manifest + icons) is copied verbatim to the root of `dist/`.
 */
/**
 * The speech-to-text engine (transformers.js) runs ONNX Runtime's WebAssembly build. Its loader and
 * binary are loaded at run time, so they ship with the extension under `dist/ort/` (never from a
 * CDN). The plain WebAssembly build is used: the WebGPU one is twice as large and not needed.
 */
function onnxRuntimeAssets(): Plugin {
  const dist = resolve(import.meta.dirname, 'node_modules', 'onnxruntime-web', 'dist');
  return {
    name: 'zoomcapture-onnxruntime-assets',
    generateBundle() {
      for (const file of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
        this.emitFile({ type: 'asset', fileName: `ort/${file}`, source: readFileSync(join(dist, file)) });
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  root: srcDir,
  publicDir: resolve(import.meta.dirname, 'public'),
  base: '/',
  plugins: [react(), tailwindcss(), pdfjsAssets(), onnxRuntimeAssets()],
  resolve: {
    alias: [
      { find: '@', replacement: srcDir },
      // transformers.js asks for the WebGPU build; the WebAssembly one is enough (see above).
      { find: /^onnxruntime-web\/webgpu$/, replacement: 'onnxruntime-web/wasm' },
    ],
  },
  worker: { format: 'es' },
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
