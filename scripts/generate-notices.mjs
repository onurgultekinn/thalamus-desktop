#!/usr/bin/env node
/**
 * Dağıtılan uygulama için üçüncü taraf bildirimlerini üretir.
 *
 * Çıktı: public/legal/THIRD_PARTY_NOTICES.txt (Vite tarafından dist'e kopyalanır).
 * Üretim bağımlılıklarını (npm ls --omit=dev) gezer, her paketin lisans metnini
 * bir kez toplar ve lisans grubuna göre listeler.
 *
 * Rust crate'leri için tam metinler yerine ad/sürüm/lisans listesi eklenir;
 * MPL-2.0 gibi dosya bazlı lisanslarda değişiklik yapılmadığı sürece bu liste
 * + crate kaynakları yeterlidir. Şüphede hukuki danışmanına başvur.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'public', 'legal');
const OUT_FILE = path.join(OUT_DIR, 'THIRD_PARTY_NOTICES.txt');

function productionPackageDirs() {
  let out = '';
  try {
    out = execSync('npm ls --omit=dev --parseable --all', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    out = err.stdout ? String(err.stdout) : '';
  }
  return [...new Set(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))]
    .filter((p) => p !== ROOT && p.includes('node_modules'))
    .sort();
}

function findLicenseFile(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const candidate = entries
    .filter((name) => /^(licen[cs]e|notice|copying)/i.test(name))
    .map((name) => path.join(dir, name))
    .find((file) => {
      try {
        return statSync(file).isFile() && statSync(file).size < 400_000;
      } catch {
        return false;
      }
    });
  return candidate ? readFileSync(candidate, 'utf8').trim() : null;
}

function licenseString(pkg) {
  const value = pkg.license ?? pkg.licenses;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item : item?.type || item?.name || ''))
      .filter(Boolean)
      .join(' OR ');
  }
  if (value && typeof value === 'object') return value.type || value.name || '';
  return 'UNKNOWN';
}

const packages = [];
for (const dir of productionPackageDirs()) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  if (!pkg.name) continue;
  const license = licenseString(pkg);
  packages.push({
    name: pkg.name,
    version: pkg.version,
    license,
    text: findLicenseFile(dir),
  });
}

const groups = new Map();
for (const pkg of packages) {
  if (!groups.has(pkg.license)) groups.set(pkg.license, []);
  groups.get(pkg.license).push(pkg);
}

const seenTexts = new Map();
const lines = [];
lines.push('THIRD-PARTY NOTICES');
lines.push('===================');
lines.push('');
lines.push('Bu uygulama, aşağıdaki açık kaynak ve üçüncü taraf bileşenleri içerir.');
lines.push('Proje lisansı: UNLICENSED (proprietary) — tüm hakları saklıdır.');
lines.push(`Üretim tarihi: ${new Date().toISOString().slice(0, 10)}`);
lines.push('');
lines.push('1) JavaScript / TypeScript paketleri');
lines.push('------------------------------------');

for (const [license, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  lines.push('');
  lines.push(`${license} — ${list.length} paket`);
  for (const pkg of list.sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`  - ${pkg.name}@${pkg.version}`);
  }

  const withText = list.find((pkg) => pkg.text);
  if (withText) {
    const digest = createHash('sha256').update(withText.text).digest('hex');
    if (!seenTexts.has(digest)) {
      seenTexts.set(digest, lines.length);
      lines.push('');
      lines.push(`--- ${license} lisans metni (${withText.name}) ---`);
      lines.push(withText.text);
    }
  } else {
    lines.push('  (Pakette lisans dosyası bulunamadı; lisans kimliği yukarıdadır.)');
  }
}

lines.push('');
lines.push('2) Rust crate\'leri');
lines.push('-------------------');
try {
  const raw = execSync(
    'cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1',
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 },
  );
  const meta = JSON.parse(raw);
  const crates = (meta.packages || [])
    .filter((p) => p.name !== 'app')
    .map((p) => ({ name: p.name, version: p.version, license: p.license || 'UNKNOWN' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const byLicense = new Map();
  for (const c of crates) {
    if (!byLicense.has(c.license)) byLicense.set(c.license, []);
    byLicense.get(c.license).push(c);
  }
  for (const [license, list] of [...byLicense.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push('');
    lines.push(`${license} — ${list.length} crate`);
    for (const c of list) lines.push(`  - ${c.name} ${c.version}`);
  }
} catch (err) {
  lines.push('  (cargo metadata çalıştırılamadı; src-tauri/Cargo.lock dosyasına bakın.)');
}

lines.push('');
lines.push('3) Bilerek paketlenmeyen bileşenler');
lines.push('-----------------------------------');
lines.push('- @flyfish-dev/cad-viewer, dwf-viewer, @mlightcad/libredwg-web (AGPL-3.0 / GPL-3.0)');
lines.push('  CAD renderer devre dışı; Vite alias ile stub\'a yönlendirilir.');
lines.push('- @file-viewer/ppt (Flyfish Public Watermarked Runtime License, proprietary)');
lines.push('  Eski binary .ppt renderer devre dışı; yalnız Apache-2.0 .pptx renderer var.');
lines.push('- occt-import-js (LGPL-2.1) ve @file-viewer/geometry-engine');
lines.push('  3D/STEP renderer devre dışı (STEP/IGES için OCCT gerekir).');
lines.push('- heic2any (MIT wrapper) → içinde libheif (LGPL-3.0) taşır.');
lines.push('  Vite alias ile stub\'a yönlendirilir; HEIC/HEIF için PNG/JPG dönüşümü önerilir.');
lines.push('- Drawio resmi entegrasyonu ve drawio varlıkları (Atlassian kısıtlı lisans).');
lines.push('  Alternatif: drawingRenderer üzerinden Mermaid/PlantUML.');
lines.push('');
lines.push('3b) Lisansı güvenli ek renderer\'lar (Apache-2.0)');
lines.push('-----------------------------------------------');
lines.push('- drawing (Mermaid/PlantUML), typst, mindmap, data (PSD/SQLite/Parquet),');
lines.push('  epub, geo (GeoJSON/KML/Shapefile), hangul (HWPX), iwork, wordperfect,');
lines.push('  chm, eda. Bunlar `thalamusRenderers` preset\'i ile yüklenir.');
lines.push('');
lines.push('4) Varlık bildirimleri');
lines.push('----------------------');
lines.push('- public/file-viewer/THIRD_PARTY_LICENSES.assets.json');
lines.push('  (File Viewer asset/worker/font bildirimleri; releaseApproval alanı ayrıca incelenmeli.)');
lines.push('');
lines.push('5) Fontlar');
lines.push('----------');
lines.push('- Cascadia Code: SIL Open Font License 1.1');
lines.push('- Noto Sans SC (@fontsource-variable/noto-sans-sc): SIL Open Font License 1.1');
lines.push('- caniuse-lite (yalnız derleme zamanı): CC-BY-4.0');
lines.push('');

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, lines.join('\n'), 'utf8');

// Font lisanslarını da paketle (varsa kopyala, yoksa OFL metnini kısa notla bırak).
const fontLicenseSources = [
  path.join(ROOT, 'node_modules', '@fontsource-variable', 'noto-sans-sc', 'LICENSE'),
  path.join(ROOT, 'public', 'file-viewer', 'vendor', 'pdf', 'fonts', 'OFL-1.1.txt'),
];
const target = path.join(OUT_DIR, 'OFL-1.1.txt');
const source = fontLicenseSources.find((p) => existsSync(p));
if (source) {
  writeFileSync(target, readFileSync(source));
} else {
  writeFileSync(target, 'SIL Open Font License 1.1\nhttps://openfontlicense.org/\n');
}

console.log(`Yazıldı: ${path.relative(ROOT, OUT_FILE)} (${packages.length} npm paketi)`);
