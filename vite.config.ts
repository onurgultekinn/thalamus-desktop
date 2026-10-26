import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'node:fs';

// App version is read from package.json at build time so the UI can show the
// exact build the user is running. Tauri's config keeps the same number.
const appVersion = JSON.parse(
  readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')
).version as string;

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    react(),
    // NOT: @file-viewer/vite-plugin BİLEREK kullanılmıyor. `config` kancası her
    // açılışta binlerce require.resolve yapıp ~54 sn harcıyordu (ölçüldü).
    // Uygulama eklentinin sanal modülünü kullanmıyor: renderer'ları doğrudan
    // `@file-viewer/preset-standard` üzerinden import ediyoruz
    // (src/lib/fileViewerSetup.ts) ve asset'leri kendi script'imiz kopyalıyor
    // (scripts/copy-file-viewer-assets.mjs → public/file-viewer). CAD alias'ları
    // aşağıda korunuyor; eklenti kaldırıldığında Vite paketleri normal Node
    // çözümlemesiyle bulur.
  ],
  
  // Tauri dev server settings
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },

  // Path Alias
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // AGPL CAD runtime'ını paket dışı bırak (ticari lisans). preset-all
      // renderer-cad'ı statik import ediyor; stub'a yönlendiriyoruz.
      '@file-viewer/renderer-cad': path.resolve(__dirname, './src/lib/fileViewerCadStub.ts'),
      '@flyfish-dev/cad-viewer': path.resolve(__dirname, './src/lib/fileViewerCadStub.ts'),
      'dwf-viewer': path.resolve(__dirname, './src/lib/fileViewerCadStub.ts'),
      // Eski binary `.ppt` runtime'ı proprietary (filigran zorunlu). Taban
      // `@file-viewer/react` + `preset-standard` bunu zaten ithal etmiyor;
      // alias yalnızca gelecekteki dolaylı ithallere karşı güvenlik ağı.
      '@file-viewer/ppt': path.resolve(__dirname, './src/lib/fileViewerPptStub.ts'),
      // heic2any MIT görünür ama içinde libheif (LGPL-3.0) WASM taşır.
      'heic2any': path.resolve(__dirname, './src/lib/heic2anyStub.ts'),
    },
  },

  build: {
    target: ['es2021', 'chrome100', 'safari13'],
    minify: !process.env.TAURI_DEBUG ? 'oxc' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});