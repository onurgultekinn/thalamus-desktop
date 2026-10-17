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
    fileViewerRenderers({ copyAssets: true }),
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
    },
  },

  build: {
    target: ['es2021', 'chrome100', 'safari13'],
    minify: !process.env.TAURI_DEBUG ? 'oxc' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});