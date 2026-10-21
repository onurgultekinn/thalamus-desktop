// Generates the "Nord Red — hex-utility overrides" block that lives in src/App.css.
// The IDE chrome paints surfaces with literal Obsidian hex utilities (bg-[#1C1B1A] …)
// instead of theme tokens. Rather than touching every component, we emit higher-specificity
// overrides scoped to html[data-theme='nord-red']; dropping the attribute (-> Obsidian)
// simply disables the block, so the switch works both ways with no markup changes.
//
// Usage: node scripts/gen-nordred.mjs [out.css]   (no arg -> stdout)

import fs from 'fs';
import path from 'path';

const root = process.cwd();

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(tsx|ts)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const files = walk(path.join(root, 'src'));

// Obsidian -> "Obsidian-close ember" palette (key = uppercase hex as authored in the source).
// Subtle, low-saturation warm shift: surfaces stay near-Obsidian, accents warm up,
// while semantic colours (diff green) are intentionally LEFT untouched.
const map = {
  '#100F0F': '#15100F',
  '#1C1B1A': '#211A18',
  '#201F1D': '#261E1B',
  '#282726': '#2E2522',
  '#2E2C29': '#342B27',
  '#2A2A2C': '#302623',
  '#2B1918': '#341F1E',
  '#34332F': '#3A2F2A',
  '#3A3835': '#40342F',
  '#3A3936': '#40342F',
  '#403E3C': '#453833',
  '#3B181A': '#421F20',
  '#575654': '#6B5A54',
  '#5F5C57': '#6F5E57',
  '#6F6C66': '#7D6C64',
  '#7E7A73': '#8A786F',
  '#807C74': '#8A786F',
  '#87857F': '#8F8079',
  '#8A867E': '#96857C',
  '#A8A49E': '#AFA098',
  '#C6C0B2': '#C8BAB0',
  '#C6C1B8': '#C9BBB1',
  '#CECDC3': '#D2C8BF',
  '#CFCAC2': '#D3C9C0',
  '#F2F0E5': '#F3EDE6',
  '#F4F2ED': '#F5EFE8',
  // cool greys / blues -> warm neutrals (#1E2F22/#1E3A2B/#2D5A45 diff greens intentionally kept)
  '#282F3D': '#302623',
  '#353F4F': '#453833',
  '#35639E': '#7A4A44',
  '#1E3A52': '#3A2626',
  '#824449': '#8A4A50',
  // accents
  '#4385BE': '#C07A5A',
  '#205EA6': '#8F5340',
  '#3AA99F': '#D99A6C',
  '#45B8AD': '#E5A87A',
  '#DCB67A': '#DBA871',
  '#D14D41': '#E0564A',
  '#E0685C': '#EA7869',
  '#D0A215': '#D9A62A',
  '#071310': '#120B0A',
  '#FFFCF0': '#FBF3EC',
};

const re = /(?:(?:[a-z-]+):)*(?:bg|text|border|placeholder|caret|fill|stroke|outline|decoration)-\[#[0-9a-fA-F]{3,6}\](?:\/[0-9.]+)?/g;

const tokens = new Set();
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  for (const m of t.matchAll(re)) tokens.add(m[0]);
}

const utilProp = {
  bg: 'background-color',
  text: 'color',
  border: 'border-color',
  placeholder: 'color',
  caret: 'caret-color',
  fill: 'fill',
  stroke: 'stroke',
  outline: 'outline-color',
  decoration: 'text-decoration-color',
};

const escapeCls = (s) => s.replace(/[^a-zA-Z0-9-]/g, (c) => '\\' + c);
const toRgb = (hex) => `rgb(${parseInt(hex.slice(1, 3), 16)} ${parseInt(hex.slice(3, 5), 16)} ${parseInt(hex.slice(5, 7), 16)}`;

const rules = [];
const unmapped = new Set();
const skippedVariants = new Set();

for (const tok of [...tokens].sort()) {
  const parts = tok.split(':');
  const variants = parts.slice(0, -1);
  const cls = parts[parts.length - 1];
  const mm = cls.match(/^(bg|text|border|placeholder|caret|fill|stroke|outline|decoration)-\[(#[0-9a-fA-F]{3,6})\](?:\/([0-9.]+))?$/);
  if (!mm) continue;
  const [, util, hexRaw, op] = mm;
  const mapped = map[hexRaw.toUpperCase()];
  if (!mapped) { unmapped.add(hexRaw); continue; }

  let prefix = '', pseudo = '', ok = true;
  for (const v of variants) {
    if (v === 'group-hover') prefix += '.group:hover ';
    else if (v === 'hover') pseudo += ':hover';
    else if (v === 'focus') pseudo += ':focus';
    else if (v === 'focus-within') pseudo += ':focus-within';
    else if (v === 'selection') pseudo += '::selection';
    else if (v === 'active') pseudo += ':active';
    else if (v === 'disabled') pseudo += ':disabled';
    else { ok = false; skippedVariants.add(v); break; }
  }
  if (!ok) continue;
  if (util === 'placeholder') pseudo += '::placeholder';

  const colorVal = op ? `rgb(${toRgb(mapped).slice(4)} / ${op}%)` : mapped;
  const sel = `html[data-theme='nord-red'] ${prefix}.${escapeCls(tok)}${pseudo}`;
  rules.push(`${sel} { ${utilProp[util]}: ${colorVal} !important; }`);
}

const css = rules.join('\n') + '\n';
const out = process.argv[2];
if (out) fs.writeFileSync(out, css, 'utf8');
else process.stdout.write(css);

console.error(`tokens: ${tokens.size} | rules: ${rules.length} | unmapped: ${[...unmapped].join(',') || 'none'} | skipped variants: ${[...skippedVariants].join(',') || 'none'}`);
