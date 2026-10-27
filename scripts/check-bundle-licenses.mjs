#!/usr/bin/env node
/**
 * Paket (dist) lisans kapısı.
 *
 * `license:check` npm ağacını denetler; bu script ise gerçekten dağıtılan
 * dosyalarda copyleft/proprietary runtime izi arar. Build sonrası çalışır.
 *
 * Not: `@file-viewer/core` asset kayıt defterinde CAD/OCCT/PPT için yalnızca
 * açıklama string'leri bulunur; bunlar kod değildir. Bu yüzden yalnızca
 * gerçek binary dosya adları ve HEIC çözücü kodu aranır.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');

const FORBIDDEN_FILE = /(ppt-native|libredwg|dwf-render|occt-import-js|libheif)/i;
const FORBIDDEN_CODE = /libheif/i;

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

if (!statSync(DIST, { throwIfNoEntry: false })) {
  console.error('dist/ yok; önce npm run build çalıştırın.');
  process.exit(1);
}

const failures = [];
for (const file of walk(DIST)) {
  const rel = path.relative(ROOT, file);
  if (FORBIDDEN_FILE.test(path.basename(file))) {
    failures.push(`${rel} — yasaklı dosya adı`);
    continue;
  }
  if (/\.(js|mjs|cjs)$/i.test(file)) {
    const text = readFileSync(file, 'utf8');
    if (FORBIDDEN_CODE.test(text)) failures.push(`${rel} — yasaklı kod izi (libheif)`);
  }
}

if (failures.length) {
  console.error('Paket lisans kapısı: SORUN');
  for (const row of failures) console.error(`  - ${row}`);
  process.exit(1);
}

// -- Bildirim kapsamı ------------------------------------------------------
// Lisansı ne olursa olsun, dağıtılan her üçüncü taraf binary'nin (wasm/ttf/
// tflite) yanında bir lisans/bildirim metni bulunmalı. Apache-2.0 §4(d) NOTICE
// ister, OFL/UFL telif bildirimi ister. Bu kontrol, bir paket güncellemesiyle
// bildirimsiz yeni bir binary girmesini yakalar.
const NOTICE_RE = /(licen[cs]e|notice|copying|ofl|ufl)/i;

function noticeNearby(file) {
  const dir = path.dirname(file);
  // Aynı dizinde veya bir üst dizinde bildirim ara (vendor/<x>/LICENSE deseni).
  for (const candidate of [dir, path.dirname(dir)]) {
    let entries;
    try {
      entries = readdirSync(candidate, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => !e.isDirectory() && NOTICE_RE.test(e.name))) return true;
  }
  return false;
}

const BINARY_RE = /\.(wasm|tflite|ttf|otf|woff2?)$/i;
// Bildirimi MERKEZİ olarak dist/legal/ altında taşınan binary'ler (paketin
// kendi vendor dizinine kopyalanamıyor, hashed asset adı altında üretiliyor).
const CENTRAL_NOTICE_FILES = [
  // @file-viewer/renderer-media → dist/legal/AOSP-NOTICE.txt + EMSCRIPTEN-LICENSE.txt
  /mp4v-(decoder|worker)/i,
  // @file-viewer/assets-standard → dist/legal/LIBARCHIVE-COPYING.txt
  // (upstream paket bu wasm'ın yanında hiç bildirim taşımıyor)
  /^libarchive\.wasm$/i,
];
const coverage = [];
for (const file of walk(DIST)) {
  if (!BINARY_RE.test(file)) continue;
  // Windows'ta path.relative ters bölü üretir; ayırıcıyı normalleştir.
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  // Fontlar ve model tek bir merkezi lisans dosyasıyla kapsanıyor; onları
  // ayrı kontrol ediyoruz (aşağıdaki merkezi bildirim listesi).
  if (rel.includes('/fonts/') || rel.includes('/mediapipe/')) continue;
  if (CENTRAL_NOTICE_FILES.some((re) => re.test(path.basename(file)))) continue;
  if (!noticeNearby(file)) coverage.push(rel);
}

// Merkezi bildirim dosyaları gerçekten pakette mi?
const centralNotices = [
  'dist/legal/THIRD_PARTY_NOTICES.txt',
  'dist/legal/OFL-1.1.txt',
  'dist/legal/UFL-1.0.txt',
  'dist/legal/AOSP-NOTICE.txt',
  'dist/legal/EMSCRIPTEN-LICENSE.txt',
  'dist/legal/LIBARCHIVE-COPYING.txt',
  'dist/mediapipe/LICENSE',
];
for (const rel of centralNotices) {
  const full = path.join(ROOT, rel);
  if (!statSync(full, { throwIfNoEntry: false })) {
    coverage.push(`${rel} — merkezi bildirim eksik`);
  }
}

if (coverage.length) {
  console.error('Paket lisans kapısı: BİLDİRİM EKSİK');
  for (const row of coverage) console.error(`  - ${row}`);
  console.error(
    '\nÇözüm: ilgili paketin LICENSE/NOTICE dosyasını `generate-notices.mjs` ile\n' +
      'public/legal/ altına kopyalayın (veya exception listesine gerekçesiyle ekleyin).'
  );
  process.exit(1);
}

console.log('Paket lisans kapısı: temiz (dist içinde yasaklı runtime ve eksik bildirim yok).');
