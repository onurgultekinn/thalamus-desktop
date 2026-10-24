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
const SCRIPT_VERSION = 4;

// `assets-ppt` eski binary .ppt runtime'ını (proprietary, filigran zorunlu),
// `assets-drawing` drawio varlıklarını (Atlassian kısıtlı lisans) taşır; ikisi
// de bilerek kopyalanmaz. CHM Apache-2.0 olduğu için geri getirildi.
const PACKAGES = ['@file-viewer/assets-standard', '@file-viewer/assets-chm'];

// Bu dizinler preset'te yok; eski kopyalardan kalmışsa temizle.
const PURGE_DIRS = ['vendor/ppt', 'vendor/drawio'];

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
      purge: PURGE_DIRS,
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

function purgeUnusedRuntimeDirs() {
  let purged = 0;
  for (const rel of PURGE_DIRS) {
    const file = join(target, rel);
    if (existsSync(file)) {
      rmSync(file, { recursive: true, force: true });
      purged++;
    }
  }
  if (purged > 0) {
    console.log(`[file-viewer] dropped ${purged} unused/restricted asset dir(s) from public/file-viewer`);
  }
}

if (upToDate()) {
  // Önceki çalıştırmada purge edilmiş dosyalar geri gelmiş olabilir; ucuz kontrol.
  purgeUnusedRuntimeDirs();
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

purgeUnusedRuntimeDirs();

writeFileSync(stampPath, JSON.stringify({ signature, SCRIPT_VERSION, packageMeta }, null, 2));
