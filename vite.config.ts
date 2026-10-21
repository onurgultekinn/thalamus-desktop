import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
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
    },
  },

  build: {
    target: ['es2021', 'chrome100', 'safari13'],
    minify: !process.env.TAURI_DEBUG ? 'oxc' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});