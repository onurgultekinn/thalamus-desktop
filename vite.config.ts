import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileViewerRenderers } from '@file-viewer/vite-plugin';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // @file-viewer: worker/wasm/font asset'lerini <base>/file-viewer/ altına
    // kopyalar (offline). Renderer'ları biz import ediyoruz (CAD'siz preset,
    // bkz. src/lib/fileViewerSetup.ts); eklenti yalnız asset kopyalar/parçalar.
    // Dokümandaki varsayılan: kurulu preset-* paketlerini otomatik keşfeder,
    // renderer kaydını enjekte eder ve asset'leri <base>/file-viewer'e kopyalar.
    // (CAD yok: preset-standard kurulu; preset-all/engineering kurulu değil.)
    // copyAssets KAPALI: tam asset payload'ı (file-viewer-copy-assets) CAD/AGPL
    // asset'leri içeriyor. CAD'siz asset'leri kendimiz kopyalıyoruz
    // (scripts/copy-file-viewer-assets.mjs → public/file-viewer).
    fileViewerRenderers({ copyAssets: false }),
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