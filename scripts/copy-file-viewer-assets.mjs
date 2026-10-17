// @file-viewer offline asset'lerini node_modules/@file-viewer/assets-* paketlerinden
// public/file-viewer/ altına kopyalar (tarayıcıda <base>/file-viewer/ olarak servis edilir).
// Böylece worker/wasm/font/CMap dosyaları CDN'siz (Tauri çevrimdışı) çalışır.
//
// dev/build öncesi otomatik çalışır (package.json: predev / prebuild).
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'public', 'file-viewer');

const PACKAGES = [
  '@file-viewer/assets-standard',
  '@file-viewer/assets-ppt',
  '@file-viewer/assets-chm',
  '@file-viewer/assets-drawing',
];

// Bayat asset'leri temizle (yeni sürümde dosya adı değişirse kalıntı kalmasın).
if (existsSync(target)) rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

let copied = 0;
for (const pkg of PACKAGES) {
  const viewerDir = join(root, 'node_modules', ...pkg.split('/'), 'viewer');
  if (!existsSync(viewerDir)) continue;
  cpSync(viewerDir, target, { recursive: true });
  copied++;
}

console.log(`[file-viewer] assets copied from ${copied}/${PACKAGES.length} packages -> public/file-viewer`);
