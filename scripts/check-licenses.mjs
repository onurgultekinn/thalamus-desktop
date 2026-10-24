#!/usr/bin/env node
/**
 * Üretim bağımlılıklarında lisans kapısı.
 *
 * Amaç: AGPL/GPL/LGPL, proprietary veya lisanssız bir paketin farkında
 * olmadan pakete girmesini engellemek. `npm run license:check` ile çalışır.
 *
 * Not: Bu bir hukuki görüş değil; CI'da erken uyarı kapısıdır.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// Lisans ifadesi birden fazla seçenek sunuyorsa (OR) permissive olanı seçeriz.
const ALLOWED = [
  /^MIT\b/i,
  /^MIT-0$/i,
  /^Apache-2\.0\b/i,
  /^BSD-2-Clause$/i,
  /^BSD-3-Clause$/i,
  /^ISC$/i,
  /^0BSD$/i,
  /^Zlib$/i,
  /^Unlicense$/i,
  /^CC0-1\.0$/i,
  /^CC-BY-4\.0$/i,
  /^OFL-1\.1$/i,
  /^Unicode-3\.0$/i,
  /^CDLA-Permissive-2\.0$/i,
  /^BSL-1\.0$/i,
  /^MPL-2\.0$/i, // dosya bazlı copyleft; değiştirilmediyse bildirimle kullanılabilir
];

// Doğrudan yasak: bu paketler lisansı ne olursa olsun üretim ağacında olmamalı.
const FORBIDDEN_PACKAGES = [
  /^@file-viewer\/ppt$/,
  /^@flyfish-dev\/cad-viewer$/,
  /^dwf-viewer$/,
  /^@mlightcad\/libredwg-web$/,
  /^occt-import-js$/,
];

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
  return '';
}

function isAllowed(license) {
  if (!license) return false;
  const expr = String(license).replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!expr) return false;
  if (/SEE LICENSE|UNLICENSED|proprietary|Commons Clause/i.test(expr)) return false;

  // OR = seçeneklerden biri yeterli. "/" ve "," de pratikte OR gibi davranır.
  const alternatives = expr.split(/\s+OR\s+|\s*\/\s*|\s*,\s*/i);
  return alternatives.some((alt) =>
    alt
      .split(/\s+AND\s+/i)
      .every((part) => ALLOWED.some((re) => re.test(part.trim()))),
  );
}

function productionPackageDirs() {
  let out = '';
  try {
    out = execSync('npm ls --omit=dev --parseable --all', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    // npm ls, extraneous/missing kayıtlarında da sıfırdan farklı çıkabilir;
    // stdout yine de kullanılabilir.
    out = err.stdout ? String(err.stdout) : '';
  }
  return [...new Set(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))]
    .filter((p) => p !== ROOT && p.includes('node_modules'))
    .sort();
}

const failures = [];
const forbidden = [];
const checked = [];

for (const dir of productionPackageDirs()) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  if (!pkg.name) continue;

  const license = licenseString(pkg);
  checked.push({ name: pkg.name, version: pkg.version, license });

  if (FORBIDDEN_PACKAGES.some((re) => re.test(pkg.name))) {
    forbidden.push(`${pkg.name}@${pkg.version} (${license || 'lisans yok'})`);
  }
  if (!isAllowed(license)) {
    failures.push(`${pkg.name}@${pkg.version} — ${license || 'LİSANS YOK'} — ${dir}`);
  }
}

console.log(`Kontrol edilen üretim paketi: ${checked.length}`);

if (forbidden.length) {
  console.error('\nYASAKLI PAKET (üretim ağacında olmamalı):');
  for (const row of forbidden) console.error(`  - ${row}`);
}

if (failures.length) {
  console.error('\nLİSANS SORUNU:');
  for (const row of failures) console.error(`  - ${row}`);
  console.error('\nÇözüm: paketi kaldır, permissive bir alternatifle değiştir veya hukuki onay al.');
  process.exit(1);
}

if (forbidden.length) process.exit(1);

console.log('Lisans kapısı: temiz.');
