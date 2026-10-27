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
lines.push('Proje lisansı: Apache License 2.0 (bkz. LICENSE). "Thalamus" adı ve markası lisans kapsamı dışındadır (bkz. TRADEMARK.md).');
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
} catch {
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
lines.push('- public/legal/AOSP-NOTICE.txt + EMSCRIPTEN-LICENSE.txt');
lines.push('  (public/file-viewer/vendor/media/mp4v-decoder.wasm — Android AOSP mp4v çözücüsü,');
lines.push('  Apache-2.0; Emscripten araç zinciri, MIT/NCSA.)');
lines.push('- public/mediapipe/LICENSE (MediaPipe Tasks Vision ve paketlenen model dosyaları,');
lines.push('  Apache-2.0, Google).');
lines.push('');
lines.push('5) Fontlar');
lines.push('----------');
lines.push('Aşağıdaki font dosyaları public/fonts/ altında dağıtılır. Her birinin kendi');
lines.push('telif bildirimi ve lisans metni korunmuştur.');
lines.push('');
lines.push('- Cascadia Code — Copyright (c) 2019-Present, Microsoft Corporation,');
lines.push('  with Reserved Font Name Cascadia Code. SIL Open Font License 1.1.');
lines.push('- Caveat — Copyright 2014 The Caveat Project Authors');
lines.push('  (https://github.com/googlefonts/caveat). SIL Open Font License 1.1.');
lines.push('- Ubuntu Sans Mono — Copyright 2011, 2022, 2023 Canonical Ltd.');
lines.push('  Typeset by Dalton Maag Ltd. Ubuntu Font Licence 1.0.');
lines.push('  Metin: public/legal/UFL-1.0.txt (https://ubuntu.com/legal/font-licence).');
lines.push('- Noto Sans SC (@fontsource-variable/noto-sans-sc): SIL Open Font License 1.1');
lines.push('- caniuse-lite (yalnız derleme zamanı): CC-BY-4.0');
lines.push('');
lines.push('Not: MPL-2.0 kapsamındaki dosya bazlı lisanslı bileşenler (cssparser,');
lines.push('selectors, dtoa-short, option-ext, dompurify, lightningcss) DEĞİŞTİRİLMEMİŞ');
lines.push('haliyle kullanılır; her birinin kaynağı crates.io / npm kayıt defterinde ve');
lines.push('yukarıdaki upstream adreslerde erişilebilir durumdadır.');
lines.push('');

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, lines.join('\n'), 'utf8');

// OFL metni: gövde tek, ama BAŞLIK font bazında ayrı olmalı (OFL §1 telif
// bildiriminin korunmasını ister). Daha önce yalnız Noto'nun "Google Inc."
// başlığı kopyalanıyordu; Cascadia (Microsoft) ve Caveat (Impallari/Caveat
// Project) bildirimi kayboluyordu.
const oflBodySources = [
  path.join(ROOT, 'node_modules', '@fontsource-variable', 'noto-sans-sc', 'LICENSE'),
  path.join(ROOT, 'node_modules', '@file-viewer', 'assets-standard', 'viewer', 'vendor', 'pdf', 'fonts', 'OFL-1.1.txt'),
  path.join(ROOT, 'public', 'file-viewer', 'vendor', 'pdf', 'fonts', 'OFL-1.1.txt'),
];
const oflBody = (() => {
  for (const p of oflBodySources) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    // Gövdeyi "SIL OPEN FONT LICENSE" başlığından itibaren al; önceki
    // font-spesifik telif satırlarını at, yerine kendi listemizi yazacağız.
    const idx = text.search(/SIL OPEN FONT LICENSE/i);
    return idx >= 0 ? text.slice(idx) : text;
  }
  return 'SIL Open Font License 1.1\nhttps://openfontlicense.org/\n';
})();
writeFileSync(
  path.join(OUT_DIR, 'OFL-1.1.txt'),
  [
    'This application bundles the following fonts under the SIL Open Font License 1.1.',
    'Each copyright notice is reproduced verbatim from its upstream source.',
    '',
    'Cascadia Code',
    '  Copyright (c) 2019 - Present, Microsoft Corporation,',
    '  with Reserved Font Name Cascadia Code.',
    '',
    'Caveat',
    '  Copyright 2014 The Caveat Project Authors (https://github.com/googlefonts/caveat)',
    '',
    'Noto Sans SC',
    '  Copyright Google Inc.',
    '',
    '---------------------------------------------------------------------------',
    '',
    oflBody.trim(),
    '',
  ].join('\n'),
  'utf8'
);

// AOSP (mp4v) ve Emscripten bildirimlerini dağıtıma taşı. Bunlar
// @file-viewer/renderer-media içindeki vendor dizininde duruyor ama paket
// ağacına kopyalanmıyordu; Apache-2.0 §4(d) NOTICE metnini ister.
const extraNotices = [
  ['AOSP-NOTICE.txt', 'node_modules/@file-viewer/renderer-media/dist/vendor/mp4v/AOSP-NOTICE.txt'],
  ['EMSCRIPTEN-LICENSE.txt', 'node_modules/@file-viewer/renderer-media/dist/vendor/mp4v/EMSCRIPTEN-LICENSE.txt'],
  // assets-standard, libarchive.wasm'in yaninda hic bildirim tasimiyor
  // (upstream'e bildirildi). BSD-2-Clause metni cevrimici kaynaktan alinir.
  ['LIBARCHIVE-COPYING.txt', null],
];
for (const [targetName, sourceRel] of extraNotices) {
  const outPath = path.join(OUT_DIR, targetName);
  if (sourceRel === null) {
    // Kaynagi pakette olmayan bildirim: repo'da isaretlenmis kopya varsa koru.
    if (!existsSync(outPath)) {
      console.warn(
        `uyarı: ${targetName} yok — libarchive BSD metnini public/legal/ altına koyun ` +
          '(https://github.com/libarchive/libarchive/blob/master/COPYING)'
      );
    }
    continue;
  }
  const from = path.join(ROOT, sourceRel);
  if (existsSync(from)) {
    writeFileSync(outPath, readFileSync(from));
  } else {
    console.warn(`uyarı: ${sourceRel} bulunamadı — ${targetName} yazılmadı`);
  }
}

// MediaPipe (Tasks Vision + model dosyaları) Apache-2.0: lisans metni
// public/mediapipe/ altında modelle birlikte dursun.
const mediapipeLicense = path.join(ROOT, 'public', 'mediapipe', 'LICENSE');
if (!existsSync(mediapipeLicense)) {
  mkdirSync(path.dirname(mediapipeLicense), { recursive: true });
  writeFileSync(
    mediapipeLicense,
    [
      'MediaPipe Tasks Vision and the bundled model files (object_detector.tflite)',
      'are Copyright Google LLC and licensed under the Apache License, Version 2.0.',
      '',
      'License: https://www.apache.org/licenses/LICENSE-2.0',
      'Upstream: https://github.com/google-ai-edge/mediapipe',
      '',
      'The full Apache-2.0 text also ships in LICENSE at the application root and in',
      'public/legal/THIRD_PARTY_NOTICES.txt.',
      '',
    ].join('\n'),
    'utf8'
  );
}

console.log(`Yazıldı: ${path.relative(ROOT, OUT_FILE)} (${packages.length} npm paketi)`);
