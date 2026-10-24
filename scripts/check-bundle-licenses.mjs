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

console.log('Paket lisans kapısı: temiz (dist içinde yasaklı runtime yok).');
