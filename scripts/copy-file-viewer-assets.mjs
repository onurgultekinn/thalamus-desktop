// @file-viewer offline asset'lerini node_modules/@file-viewer/assets-* paketlerinden
// public/file-viewer/ altına kopyalar (tarayıcıda <base>/file-viewer/ olarak servis edilir).
// Böylece worker/wasm/font/CMap dosyaları CDN'siz (Tauri çevrimdışı) çalışır.
//
// dev/build öncesi otomatik çalışır (package.json: predev / prebuild).
//
// Her açılışta 78 MB / ~2700 dosyayı yeniden kopyalamak ~18 sn sürüyordu.
// Artık paket sürümleri + script imzası değişmediyse ve kritik dosyalar
// yerindeyse kopyalama atlanır (tipik açılış: <0,2 sn).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'public', 'file-viewer');
const stampPath = join(target, '.asset-stamp.json');

// Kopyalama/purge mantığı değişince artır.
const SCRIPT_VERSION = 2;

const PACKAGES = [
  '@file-viewer/assets-standard',
  '@file-viewer/assets-ppt',
  '@file-viewer/assets-chm',
  '@file-viewer/assets-drawing',
];

// Eski .ppt (.ppt/.pot — PowerPoint 97-2003) motoru font/wasm/worker yollarını
// `presentation.pptFontUrl|pptWasmUrl|pptWorkerUrl` seçeneklerinden okur
// (renderer-presentation → @file-viewer/ppt). Uygulama bu seçenekleri VERMİYOR
// (bkz. src/lib/fileViewerSetup.ts → createFullAssetOptions yalnız archive/docx/
// pdf/presentation/spreadsheet anahtarlarını üretir), bu yüzden motor kendi
// gömülü `/assets/ppt-font-cjk-*.otf` / `ppt-native-*.wasm` kopyalarını kullanır.
// Buradaki kopyalar hiç istenmiyor: 16 MB CJK font + 1.5 MB wasm gereksiz.
// LICENSE/NOTICE korunur. (Geri almak için bu bloğu silip scripti yeniden çalıştırın;
// dosyalar node_modules/@file-viewer/assets-ppt içinde duruyor.)
const PPT_UNUSED_RUNTIME = [
  'vendor/ppt/ppt-font-cjk.otf',
  'vendor/ppt/ppt-native.wasm',
  'vendor/ppt/index.mjs',
  'vendor/ppt/worker.mjs',
  'vendor/ppt/frame-cache.mjs',
];

// Hedef ağacın sağlıklı olduğunu gösteren kritik dosyalar. Kullanıcı
// public/file-viewer'ı elle silerse stamp eşleşse bile yeniden kopyalanır.
const SENTINELS = [
  'vendor/pdf/cmaps/78-EUC-H.bcmap',
  'vendor/pdf/wasm/jbig2.wasm',
  'vendor/docx/docx.worker.js',
  'vendor/xlsx/sheet.worker.js',
  'vendor/pptx/pptx.worker.js',
];

const scriptSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
const packageMeta = PACKAGES.map((pkg) => {
  const pkgJson = join(root, 'node_modules', ...pkg.split('/'), 'package.json');
  if (!existsSync(pkgJson)) return { pkg, version: null, mtime: 0 };
  try {
    const st = statSync(pkgJson);
    return { pkg, version: JSON.parse(readFileSync(pkgJson, 'utf8')).version ?? null, mtime: st.mtimeMs };
  } catch {
    return { pkg, version: null, mtime: 0 };
  }
});

const signature = createHash('sha1')
  .update(
    JSON.stringify({
      SCRIPT_VERSION,
      scriptSource,
      packageMeta,
      purge: PPT_UNUSED_RUNTIME,
    })
  )
  .digest('hex');

function upToDate() {
  if (!existsSync(target) || !existsSync(stampPath)) return false;
  try {
    const saved = JSON.parse(readFileSync(stampPath, 'utf8'));
    if (saved.signature !== signature) return false;
  } catch {
    return false;
  }
  return SENTINELS.every((rel) => existsSync(join(target, rel)));
}

function purgeUnusedPptRuntime() {
  let purged = 0;
  for (const rel of PPT_UNUSED_RUNTIME) {
    const file = join(target, rel);
    if (existsSync(file)) {
      rmSync(file, { force: true });
      purged++;
    }
  }
  if (purged > 0) {
    console.log(`[file-viewer] dropped ${purged} unused legacy .ppt runtime file(s) from public/file-viewer/vendor/ppt`);
  }
}

if (upToDate()) {
  // Önceki çalıştırmada purge edilmiş dosyalar geri gelmiş olabilir; ucuz kontrol.
  purgeUnusedPptRuntime();
  console.log('[file-viewer] assets up to date (copy skipped) -> public/file-viewer');
  process.exit(0);
}

// Temiz başla: eski/tam-payload (CAD dahil) kalıntı kalmasın. Eklenti copyAssets
// kapalı olduğundan public→dist kopyasıyla yarış yok.
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

purgeUnusedPptRuntime();

writeFileSync(stampPath, JSON.stringify({ signature, SCRIPT_VERSION, packageMeta }, null, 2));
