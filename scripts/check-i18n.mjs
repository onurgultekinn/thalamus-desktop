#!/usr/bin/env node
// TR/EN is anlik denetimi.
//
// TypeScript derleyicisi `tr`'nin anahtar kumesini zaten zorluyor, ama bu
// kontrol iki seyi yakalar:
//   1) EN'de olup TR'de olmayan anahtarlar (derleme bir sebeple atlanirsa),
//   2) BOS ceviri (anahtar var, degeri "" veya yalniz bosluk).
// Bagimlilik eklemez: TypeScript zaten devDependency.
//
// Kullanim: node scripts/check-i18n.mjs [--json]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'src', 'lib', 'i18n.ts');
const source = ts.createSourceFile(
  file,
  readFileSync(file, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
);

/** `const <name> = {...}` bildirimini bulur; sözlük literal'ini döndürür. */
function findDictionary(name) {
  let found = null;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      let init = node.initializer;
      // `{...} as const` sarmalayicisini ac.
      if (init && ts.isAsExpression(init)) init = init.expression;
      if (init && ts.isObjectLiteralExpression(init)) found = init;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Obje literal'inden anahtar -> deger (string literalleri) haritasi. */
function entries(literal) {
  const map = new Map();
  for (const prop of literal.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = ts.isStringLiteral(prop.name) || ts.isIdentifier(prop.name)
      ? prop.name.text
      : null;
    if (!key) continue;
    let value = prop.initializer;
    if (ts.isAsExpression(value)) value = value.expression;
    map.set(key, ts.isStringLiteral(value) ? value.text : null);
  }
  return map;
}

const enLiteral = findDictionary('en');
const trLiteral = findDictionary('tr');
if (!enLiteral || !trLiteral) {
  console.error('i18n: `en` veya `tr` sozlugu bulunamadi — dosya yapisi degisti mi?');
  process.exit(2);
}

const en = entries(enLiteral);
const tr = entries(trLiteral);

const missingInTr = [...en.keys()].filter((k) => !tr.has(k));
const extraInTr = [...tr.keys()].filter((k) => !en.has(k));
const emptyInTr = [...tr.entries()]
  .filter(([, v]) => v === null || v.trim() === '')
  .map(([k]) => k);
const emptyInEn = [...en.entries()]
  .filter(([, v]) => v === null || v.trim() === '')
  .map(([k]) => k);

const problems = {
  missingInTr,
  extraInTr,
  emptyInTr,
  emptyInEn,
  placeholderMismatch: [],
};

// Yer tutucu denetimi: `{done}` gibi parametreler iki dilde ayni kumede
// olmali. Olmazsa translate() eksik parametrede "{key}" birakir — sessiz
// bozulma. Bu kontrol onu yakalar.
//
// ISTISNA: Ingilizce'ye ozgu cogul eki parametreleri ({s}) Turkce'de karsiligi
// olmadigi icin bilincli olarak yok. Bu tur anahtarlar burada gerekcesiyle
// listelenir; baska bir yer tutucu eksikse hata verilir.
const OPTIONAL_PLACEHOLDERS = {
  // EN: 'Load {n} older message{s}' — TR sayidan sonra cogul eki almaz.
  'chat.loadOlder': ['s'],
};

const PLACEHOLDER = /\{(\w+)\}/g;
function setOf(value) {
  const out = new Set();
  if (typeof value !== 'string') return out;
  for (const m of value.matchAll(PLACEHOLDER)) out.add(m[1]);
  return out;
}
for (const [key, enValue] of en) {
  const trValue = tr.get(key);
  if (trValue == null) continue;
  const optional = new Set(OPTIONAL_PLACEHOLDERS[key] ?? []);
  const a = setOf(enValue);
  const b = setOf(trValue);
  const missing = [...a].filter((p) => !b.has(p) && !optional.has(p));
  const extra = [...b].filter((p) => !a.has(p));
  if (missing.length || extra.length) {
    problems.placeholderMismatch.push({ key, missing, extra });
  }
}

const failed =
  missingInTr.length +
    extraInTr.length +
    emptyInTr.length +
    emptyInEn.length +
    problems.placeholderMismatch.length >
  0;

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ en: en.size, tr: tr.size, ...problems }, null, 2));
} else {
  console.log(`i18n: en=${en.size} anahtar, tr=${tr.size} anahtar`);
  if (missingInTr.length) {
    console.error(`\nTR'de EKSIK (${missingInTr.length}):`);
    for (const k of missingInTr) console.error(`  - ${k}`);
  }
  if (extraInTr.length) {
    console.error(`\nTR'de FAZLA (EN'de yok) (${extraInTr.length}):`);
    for (const k of extraInTr) console.error(`  - ${k}`);
  }
  if (emptyInTr.length) {
    console.error(`\nTR'de BOS ceviri (${emptyInTr.length}):`);
    for (const k of emptyInTr) console.error(`  - ${k}`);
  }
  if (emptyInEn.length) {
    console.error(`\nEN'de BOS ceviri (${emptyInEn.length}):`);
    for (const k of emptyInEn) console.error(`  - ${k}`);
  }
  if (problems.placeholderMismatch.length) {
    console.error(`\nYER TUTUCU UYUSMAZLIGI (${problems.placeholderMismatch.length}):`);
    for (const row of problems.placeholderMismatch) {
      console.error(
        `  - ${row.key}: eksik=${JSON.stringify(row.missing)} fazla=${JSON.stringify(row.extra)}`
      );
    }
  }
  console.log(failed ? '\ni18n: BASARISIZ' : '\ni18n: temiz');
}

process.exit(failed ? 1 : 0);
