import { useEffect, useRef, useState } from 'react';
import { useT } from '../lib/i18n';

export interface PixelAgent {
  id: string;
  name: string;
  role: string;
}

interface Props {
  agents: PixelAgent[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}

const TILE = 16;
const COLS = 42;
const ROWS = 22;
const W = COLS * TILE;
const H = ROWS * TILE;
const SCALE = 4;
const S = SCALE;
const SW = 16;
const SH = 32;

const WORK = { x: 16, y: 32, w: 384, h: 196 };
const MEET = { x: 424, y: 32, w: 232, h: 196 };
const LOUNGE = { x: 16, y: 244, w: 384, h: 104 };
const SERVER = { x: 424, y: 244, w: 232, h: 104 };
const PART_V = { x: 406, w: 12, y0: 32, y1: 232, door0: 112, door1: 144 };
const PART_H = { y: 232, h: 12, x0: 16, x1: 656, doors: [[150, 182], [520, 552]] };

type C2D = CanvasRenderingContext2D;
type Dir = 'front' | 'back' | 'side';

function rect(c: C2D, x: number, y: number, w: number, h: number, col: string) {
  c.fillStyle = col;
  c.fillRect(Math.round(x * S), Math.round(y * S), Math.round(w * S), Math.round(h * S));
}

function pxLine(c: C2D, x0: number, y0: number, x1: number, y1: number, col: string) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  c.fillStyle = col;
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    c.fillRect(Math.round((x0 + dx * t) * S), Math.round((y0 + dy * t) * S), S, S);
  }
}

function shadow(c: C2D, cx: number, cy: number, rx: number, ry: number, a: number) {
  c.save();
  c.fillStyle = `rgba(0,0,0,${a})`;
  c.beginPath();
  c.ellipse(cx * S, cy * S, rx * S, ry * S, 0, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

type Grid = string[];

const FRONT: Grid = [
  '.....oooooo.....',
  '...oohhhhhhoo...',
  '..ohhhhhhhhhho..',
  '..ohhhHHHHhhho..',
  '..ohhhhhhhhhho..',
  '..ohhhhhhhhhho..',
  '..ohhsssssshho..',
  '..ohsssssssssho.',
  '..ohsswesswessho.',
  '..ohsseesseesho.',
  '..ohssssSssssho.',
  '..ohssssmmsssho.',
  '..ohSssssssSho..',
  '.....osssso.....',
  '..obbbbbbbbbbo..',
  '..obccbbbbccbo..',
  '..obbbbbbbbbbo..',
  '..obbbbbbbbbbo..',
  '..obbbbbbbbbbo..',
  '..obbbbbbbbbbo..',
  '..osbbbbbbbbso..',
  '..osbbbbbbbbso..',
  '..oppppppppppo..',
  '..oppppppppppo..',
  '..oppppppppppo..',
  '..opppp..ppppo..',
  '..opppp..ppppo..',
  '..opppp..ppppo..',
  '..opppp..ppppo..',
  '..opppp..ppppo..',
  '..okkkk..kkkko..',
  '..okkkk..kkkko..',
];

const BACK: Grid = [
  '.....oooooo.....',
  '...oohhhhhhoo...',
  '..ohhhhhhhhhho..',
  '..ohhhHHHHhhho..',
  '..ohhhhhhhhhho..',
  '..ohhhhhhhhhho..',
  '..ohhhhhhhhhho..',
  '..ohhhhhhhhhho..',
  '..ohhhhhhhhhho..',
  '..ohhhhhhhhhho..',
  '..ohhhhhhhhhho..',
  '....osssssso....',
  '...obbbbbbbbo...',
  '..obbbbbbbbbbo..',
  '..obbbbbbbbbbo..',
  '..obbbbbbbbbbo..',
  '..obbbbbbbbbbo..',
  '..obbbbbbbbbbo..',
  '..obbbbbbbbbbo..',
  '..obbbbbbbbbbo..',
  '..osbbbbbbbbso..',
  '..osbbbbbbbbso..',
  '..oppppppppppo..',
  '..oppppppppppo..',
  '..oppppppppppo..',
  '..opppp..ppppo..',
  '..opppp..ppppo..',
  '..opppp..ppppo..',
  '..opppp..ppppo..',
  '..opppp..ppppo..',
  '..okkkk..kkkko..',
  '..okkkk..kkkko..',
];

const SIDE: Grid = [
  '.....oooooo.....',
  '....ohhhhhho....',
  '...ohhhhhhhho...',
  '...ohHHhhhhhho..',
  '...ohhhhhhhhhho.',
  '...ohhhssssssho.',
  '...ohhsssssssho.',
  '...ohhsseessho..',
  '...ohhsseessho..',
  '...ohhsssSssho..',
  '...ohhsssmmho...',
  '...ohhsssssho...',
  '...ohSsssssho...',
  '....ohsssso.....',
  '....obbbbbbo....',
  '...obbbbbbbbo...',
  '...obbbbbbbbo...',
  '...obbbbbbbbo...',
  '...obbbbbbbbo...',
  '...obbbbbbbbo...',
  '...osbbbbbbso...',
  '...osbbbbbbso...',
  '....oppppppo....',
  '....oppppppo....',
  '....oppppppo....',
  '....oppppo......',
  '....oppppo......',
  '....oppppo......',
  '....oppppo......',
  '....oppppo......',
  '....okkko.......',
  '....okkko.......',
];

function padCentered(grid: Grid, w: number): Grid {
  return grid.map(r => {
    if (r.length >= w) return r.slice(0, w);
    const total = w - r.length;
    const left = Math.floor(total / 2);
    return '.'.repeat(left) + r + '.'.repeat(total - left);
  });
}

const SP = {
  front: padCentered(FRONT, 16),
  back: padCentered(BACK, 16),
  side: padCentered(SIDE, 16),
};

const LEG_Y = 25;

function shiftSeg(row: string[], from: number, to: number, dx: number) {
  const seg = row.slice(from, to);
  for (let i = from; i < to; i++) row[i] = '.';
  for (let i = 0; i < seg.length; i++) {
    const tx = from + i + dx;
    if (tx >= 0 && tx < row.length && seg[i] !== '.') row[tx] = seg[i];
  }
}

function walkGrid(grid: Grid, dir: Dir, frame: number): Grid {
  if (frame === 0) return grid;
  const out = grid.map(r => r.split(''));
  for (let y = LEG_Y; y < grid.length; y++) {
    if (dir === 'side') {
      shiftSeg(out[y], 3, 13, frame);
    } else {
      shiftSeg(out[y], 3, 8, -frame);
      shiftSeg(out[y], 8, 13, frame);
    }
  }
  return out.map(r => r.join(''));
}

const COL = {
  o: '#1b1e26',
  h: '#3a2a1c',
  H: '#5a4228',
  s: '#e0a878',
  S: '#b87a4e',
  e: '#20242c',
  m: '#7a3f36',
  g: '#2b1e14',
  b: '#4385BE',
  c: '#6fa8dc',
  B: '#2f5f8c',
  p: '#33384a',
  P: '#242838',
  k: '#15171d',
  w: '#f2ede4',
};

const HAIRS: [string, string][] = [
  ['#2f2117', '#4a3624'],
  ['#4a3320', '#6b4c2e'],
  ['#15161a', '#2c2e36'],
  ['#6b4a22', '#8a6636'],
  ['#7a2f2f', '#9a4a42'],
  ['#4a4a55', '#666774'],
  ['#a8894f', '#c8a96c'],
];
const SHIRTS = ['#4385BE', '#3AA99F', '#D0A215', '#D14D41', '#8a7be0', '#d98a5a', '#5aa7d9', '#c46bab'];
const SKINS: [string, string][] = [
  ['#f2cca8', '#d6a478'],
  ['#e6b184', '#c68f63'],
  ['#cf9464', '#aa7046'],
  ['#a96f45', '#845230'],
  ['#7f4f2e', '#5f3a22'],
];
const HATS = ['#c0504d', '#3a6ea5', '#3f8f5a', '#d0a215', '#5a5f68'];
const TIES = ['#c0504d', '#3a6ea5', '#d0a215', '#7a2f2f'];

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

function paletteFor(id: string) {
  const k = hash(id);
  const [hair, hairHi] = HAIRS[k % HAIRS.length];
  const [skin, skinShade] = SKINS[(k >>> 3) % SKINS.length];
  return {
    ...COL,
    h: hair,
    H: hairHi,
    s: skin,
    S: skinShade,
    b: SHIRTS[k % SHIRTS.length],
    g: hair,
  };
}

interface Look {
  hairStyle: 'short' | 'long' | 'bun' | 'cap' | 'ponytail';
  glasses: boolean;
  beard: boolean;
  headphones: boolean;
  tie: boolean;
  hatColor: string;
  tieColor: string;
}

function lookFor(id: string): Look {
  const h = hash(id);
  return {
    hairStyle: (['short', 'long', 'bun', 'cap', 'ponytail'] as const)[h % 5],
    glasses: ((h >> 5) & 3) === 0,
    beard: ((h >> 7) & 3) === 0,
    headphones: ((h >> 9) & 3) === 0,
    tie: ((h >> 11) & 1) === 1,
    hatColor: HATS[(h >>> 13) % HATS.length],
    tieColor: TIES[(h >>> 15) % TIES.length],
  };
}

function dr(c: C2D, x: number, y: number, w: number, h: number, col: string) {
  c.fillStyle = col;
  c.fillRect(x, y, w, h);
}

type RoleKind = 'dev' | 'design' | 'qa' | 'ops' | 'data' | 'lead';

const ROLE_COLORS: Record<RoleKind, string> = {
  dev: '#3a6ea5',
  design: '#b25c9e',
  qa: '#3f8f5a',
  ops: '#b8862a',
  data: '#2f8d86',
  lead: '#b8483f',
};

function roleFor(role: string): RoleKind {
  const r = (role || '').toLowerCase();
  if (/(design|ui|ux|brand|art|creative)/.test(r)) return 'design';
  if (/(test|qa|quality|review|audit)/.test(r)) return 'qa';
  if (/(ops|infra|devops|sre|security|platform|deploy)/.test(r)) return 'ops';
  if (/(data|analy|ml|science|research|brain|model)/.test(r)) return 'data';
  if (/(lead|manager|head|chief|ceo|cto|founder|architect|director)/.test(r)) return 'lead';
  return 'dev';
}

function drawRoleGlyph(c: C2D, kind: RoleKind, cx: number, cy: number, r: number) {
  c.save();
  c.strokeStyle = '#f4f7fa';
  c.fillStyle = '#f4f7fa';
  c.lineWidth = Math.max(1.2, r * 0.38);
  c.lineJoin = 'round';
  c.lineCap = 'round';
  c.beginPath();
  if (kind === 'dev') {
    c.moveTo(cx - 0.25 * r, cy - 0.75 * r);
    c.lineTo(cx - 0.95 * r, cy);
    c.lineTo(cx - 0.25 * r, cy + 0.75 * r);
    c.moveTo(cx + 0.25 * r, cy - 0.75 * r);
    c.lineTo(cx + 0.95 * r, cy);
    c.lineTo(cx + 0.25 * r, cy + 0.75 * r);
    c.stroke();
  } else if (kind === 'design') {
    c.moveTo(cx - 0.75 * r, cy + 0.75 * r);
    c.lineTo(cx + 0.65 * r, cy - 0.65 * r);
    c.lineTo(cx + 0.95 * r, cy - 0.95 * r);
    c.lineTo(cx + 0.4 * r, cy - 0.4 * r);
    c.closePath();
    c.fill();
    c.beginPath();
    c.moveTo(cx - 0.85 * r, cy + 0.55 * r);
    c.lineTo(cx - 0.45 * r, cy + 0.95 * r);
    c.stroke();
  } else if (kind === 'qa') {
    c.moveTo(cx - 0.95 * r, cy + 0.05 * r);
    c.lineTo(cx - 0.25 * r, cy + 0.75 * r);
    c.lineTo(cx + 0.95 * r, cy - 0.75 * r);
    c.stroke();
  } else if (kind === 'ops') {
    c.arc(cx, cy, 0.55 * r, 0, Math.PI * 2);
    c.stroke();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * 0.65 * r, cy + Math.sin(a) * 0.65 * r);
      c.lineTo(cx + Math.cos(a) * 1.0 * r, cy + Math.sin(a) * 1.0 * r);
      c.stroke();
    }
  } else if (kind === 'data') {
    c.fillRect(cx - 0.9 * r, cy + 0.05 * r, 0.45 * r, 0.85 * r);
    c.fillRect(cx - 0.2 * r, cy - 0.45 * r, 0.45 * r, 1.35 * r);
    c.fillRect(cx + 0.5 * r, cy - 0.85 * r, 0.45 * r, 1.75 * r);
  } else {
    const R = 0.95 * r;
    const r2 = 0.42 * r;
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 === 0 ? R : r2;
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr;
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.closePath();
    c.fill();
  }
  c.restore();
}

function drawLook(c: C2D, id: string, dir: Dir, pal: Record<string, string>) {
  const L = lookFor(id);
  const ink = '#1b1e26';
  if (L.hairStyle !== 'cap') {
    dr(c, 5, 3, 1, 1, 'rgba(255,255,255,0.18)');
    dr(c, 6, 2, 2, 1, 'rgba(255,255,255,0.10)');
  }
  if (dir === 'front') {
    if (L.hairStyle === 'short') {
      dr(c, 2, 9, 1, 2, pal.S); dr(c, 13, 9, 1, 2, pal.S);
    }
    if (L.hairStyle === 'long') {
      dr(c, 2, 7, 1, 10, pal.h); dr(c, 13, 7, 1, 10, pal.h);
      dr(c, 1, 8, 1, 7, pal.h); dr(c, 14, 8, 1, 7, pal.h);
      dr(c, 3, 8, 1, 8, 'rgba(0,0,0,0.12)'); dr(c, 12, 8, 1, 8, 'rgba(0,0,0,0.12)');
    }
    if (L.hairStyle === 'ponytail') {
      dr(c, 13, 8, 2, 8, pal.h); dr(c, 14, 9, 1, 6, pal.H);
      dr(c, 2, 7, 1, 4, pal.h);
    }
    if (L.hairStyle === 'bun') { dr(c, 6, 0, 4, 2, pal.h); dr(c, 7, 0, 2, 1, pal.H); }
    if (L.hairStyle === 'cap') {
      dr(c, 4, 1, 8, 4, L.hatColor); dr(c, 4, 1, 8, 1, 'rgba(255,255,255,0.18)');
      dr(c, 3, 5, 10, 1, L.hatColor);
      dr(c, 4, 5, 8, 1, 'rgba(0,0,0,0.12)');
    }
    dr(c, 6, 7, 1, 1, pal.h); dr(c, 11, 7, 1, 1, pal.h);
    if (L.glasses) { dr(c, 4, 8, 1, 1, ink); dr(c, 12, 8, 1, 1, ink); dr(c, 8, 8, 1, 1, ink); }
    if (L.beard) {
      dr(c, 4, 10, 1, 3, pal.h); dr(c, 11, 10, 1, 3, pal.h);
      dr(c, 5, 12, 6, 1, pal.h);
      dr(c, 8, 10, 2, 1, pal.h);
    }
    if (L.headphones) {
      dr(c, 4, 4, 8, 1, ink);
      dr(c, 1, 7, 2, 5, ink); dr(c, 13, 7, 2, 5, ink);
      dr(c, 2, 7, 1, 5, '#4a4a55'); dr(c, 13, 7, 1, 5, '#4a4a55');
    }
    dr(c, 4, 10, 1, 1, 'rgba(190,80,60,0.22)');
    dr(c, 11, 10, 1, 1, 'rgba(190,80,60,0.22)');
    dr(c, 8, 10, 1, 1, 'rgba(255,255,255,0.10)');
    dr(c, 6, 13, 4, 1, 'rgba(0,0,0,0.07)');
    dr(c, 5, 2, 1, 5, 'rgba(255,255,255,0.05)');
    if (L.tie) {
      dr(c, 7, 14, 2, 3, L.tieColor); dr(c, 7, 17, 2, 4, L.tieColor);
      dr(c, 7, 15, 1, 5, 'rgba(255,255,255,0.16)');
    } else {
      dr(c, 6, 14, 4, 1, pal.c);
      dr(c, 6, 15, 1, 4, '#2b303a');
      dr(c, 9, 15, 1, 4, '#2b303a');
      dr(c, 7, 15, 2, 1, '#2b303a');
      dr(c, 7, 17, 2, 2, '#e8eef2');
      dr(c, 7, 17, 2, 1, L.tieColor);
    }
    dr(c, 4, 31, 2, 1, '#3a4150');
    dr(c, 10, 31, 2, 1, '#3a4150');
  } else if (dir === 'back') {
    if (L.hairStyle === 'long') {
      dr(c, 2, 7, 1, 11, pal.h); dr(c, 13, 7, 1, 11, pal.h);
      dr(c, 1, 8, 1, 7, pal.h); dr(c, 14, 8, 1, 7, pal.h);
    }
    if (L.hairStyle === 'ponytail') {
      dr(c, 12, 8, 3, 9, pal.h); dr(c, 13, 9, 1, 7, pal.H);
    }
    if (L.hairStyle === 'bun') { dr(c, 6, 0, 4, 2, pal.h); dr(c, 7, 0, 2, 1, pal.H); }
    if (L.hairStyle === 'cap') {
      dr(c, 4, 1, 8, 4, L.hatColor); dr(c, 4, 1, 8, 1, 'rgba(255,255,255,0.18)');
      dr(c, 3, 5, 10, 1, L.hatColor);
    }
    if (L.headphones) {
      dr(c, 4, 4, 8, 1, ink);
      dr(c, 1, 7, 2, 5, ink); dr(c, 13, 7, 2, 5, ink);
      dr(c, 2, 7, 1, 5, '#4a4a55'); dr(c, 13, 7, 1, 5, '#4a4a55');
    }
    dr(c, 7, 2, 1, 9, pal.H);
    dr(c, 4, 8, 1, 3, 'rgba(255,255,255,0.06)');
    dr(c, 5, 4, 1, 6, 'rgba(255,255,255,0.04)');
    dr(c, 10, 4, 1, 6, 'rgba(0,0,0,0.10)');
    dr(c, 4, 13, 1, 4, 'rgba(0,0,0,0.08)');
    dr(c, 11, 13, 1, 4, 'rgba(0,0,0,0.08)');
    dr(c, 4, 22, 8, 1, 'rgba(0,0,0,0.18)');
    dr(c, 6, 13, 4, 1, pal.c);
    dr(c, 6, 14, 1, 4, '#2b303a');
    dr(c, 9, 14, 1, 4, '#2b303a');
    dr(c, 4, 31, 2, 1, '#3a4150');
    dr(c, 10, 31, 2, 1, '#3a4150');
  } else {
    if (L.hairStyle === 'long') { dr(c, 2, 7, 2, 10, pal.h); dr(c, 1, 8, 1, 7, pal.h); }
    if (L.hairStyle === 'ponytail') { dr(c, 2, 9, 3, 8, pal.h); dr(c, 3, 10, 1, 6, pal.H); }
    if (L.hairStyle === 'bun') { dr(c, 6, 0, 4, 2, pal.h); dr(c, 7, 0, 2, 1, pal.H); }
    if (L.hairStyle === 'cap') {
      dr(c, 3, 1, 8, 4, L.hatColor); dr(c, 3, 1, 8, 1, 'rgba(255,255,255,0.18)');
      dr(c, 8, 5, 5, 1, L.hatColor);
    }
    if (L.glasses) dr(c, 6, 8, 3, 1, ink);
    if (L.beard) { dr(c, 6, 10, 1, 2, pal.h); dr(c, 7, 12, 4, 1, pal.h); }
    if (L.headphones) {
      dr(c, 4, 4, 7, 1, ink);
      dr(c, 9, 7, 3, 4, ink); dr(c, 9, 8, 2, 2, '#4a4a55');
    }
    dr(c, 8, 7, 1, 1, 'rgba(255,255,255,0.50)');
    dr(c, 7, 13, 3, 1, 'rgba(0,0,0,0.07)');
    dr(c, 5, 2, 1, 6, 'rgba(255,255,255,0.05)');
    dr(c, 7, 22, 4, 1, 'rgba(0,0,0,0.18)');
    dr(c, 12, 9, 1, 1, pal.s);
    if (L.tie) { dr(c, 6, 14, 2, 3, L.tieColor); dr(c, 6, 17, 2, 4, L.tieColor); }
    else {
      dr(c, 7, 14, 3, 1, pal.c);
      dr(c, 7, 15, 1, 4, '#2b303a');
      dr(c, 8, 17, 2, 2, '#e8eef2');
      dr(c, 8, 17, 2, 1, L.tieColor);
    }
    dr(c, 8, 21, 1, 1, pal.s);
    dr(c, 4, 31, 3, 1, '#3a4150');
    dr(c, 9, 31, 3, 1, '#3a4150');
  }
}

const spriteCache = new Map<string, HTMLCanvasElement>();

function bakeSprite(id: string, dir: Dir, frame: number): HTMLCanvasElement {
  const key = `${id}|${dir}|${frame}`;
  const hit = spriteCache.get(key);
  if (hit) return hit;
  const cv = document.createElement('canvas');
  cv.width = SW;
  cv.height = SH;
  const c = cv.getContext('2d')!;
  const pal: Record<string, string> = paletteFor(id);
  const base = SP[dir];
  const grid = walkGrid(base, dir, frame);
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.') continue;
      c.fillStyle = pal[ch] || '#f0f';
      c.fillRect(x, y, 1, 1);
    }
  }
  drawLook(c, id, dir, pal);
  spriteCache.set(key, cv);
  return cv;
}

function frameFor(phase: number, moving: boolean): number {
  if (!moving) return 0;
  return Math.max(-1, Math.min(1, Math.round(Math.sin(phase))));
}

function drawFloor(c: C2D) {
  const fx0 = TILE;
  const fy0 = 2 * TILE;
  const fx1 = (COLS - 1) * TILE;
  const fy1 = ROWS * TILE;
  rect(c, 0, 0, W, H, '#12151b');
  const ph = 8;
  const pw = 32;
  let ri = 0;
  for (let y = fy0; y < fy1; y += ph) {
    for (let x = fx0; x < fx1; x += pw) {
      const w = Math.min(pw, fx1 - x);
      const alt = (ri + Math.floor(x / pw)) % 2 === 0;
      rect(c, x, y, w, ph, alt ? '#6f4d2f' : '#674628');
      rect(c, x, y, w, 1, alt ? '#835d38' : '#7a5532');
      rect(c, x, y + ph - 1, w, 1, '#4c3118');
      rect(c, x, y, 1, ph, '#4a2f17');
      rect(c, x + w - 1, y, 1, ph, 'rgba(255,220,160,0.10)');
      for (let g = 0; g < 3; g++) {
        const gy = y + 2 + ((x * 7 + ri * 11 + g * 5) % (ph - 3));
        const gx = x + 2 + ((x * 13 + g * 17 + ri * 3) % Math.max(1, w - 10));
        rect(c, gx, gy, 3 + (g % 3) * 2, 1, 'rgba(0,0,0,0.07)');
      }
      if (ri % 2 === 1) rect(c, x + 16, y + 1, 1, ph - 1, 'rgba(0,0,0,0.16)');
    }
    ri++;
  }
  const knots = [
    [70, 74], [190, 58], [310, 118], [120, 176], [250, 196], [360, 158],
  ];
  for (const [kx, ky] of knots) {
    rect(c, kx, ky, 4, 2, 'rgba(60,38,18,0.5)');
    rect(c, kx + 1, ky - 1, 2, 4, 'rgba(60,38,18,0.4)');
    rect(c, kx + 1, ky, 2, 2, '#4a2f17');
    rect(c, kx + 1, ky, 1, 1, 'rgba(255,220,160,0.10)');
  }
  for (let i = 0; i < 70; i++) {
    const x = fx0 + ((i * 97) % (fx1 - fx0 - 2));
    const y = fy0 + ((i * 53) % (fy1 - fy0 - 2));
    rect(c, x, y, 1, 1, 'rgba(0,0,0,0.16)');
  }
  for (let i = 0; i < 40; i++) {
    const x = fx0 + ((i * 61 + 23) % (fx1 - fx0 - 2));
    const y = fy0 + ((i * 89 + 11) % (fy1 - fy0 - 2));
    rect(c, x, y, 1, 1, 'rgba(255,226,170,0.10)');
  }
}

function drawRoomFloors(c: C2D) {
  rect(c, MEET.x, MEET.y, MEET.w, MEET.h, '#454455');
  rect(c, MEET.x, MEET.y, MEET.w, MEET.h, 'rgba(255,255,255,0.015)');
  for (let y = MEET.y + 6; y < MEET.y + MEET.h - 4; y += 8) {
    for (let x = MEET.x + 6; x < MEET.x + MEET.w - 4; x += 8) {
      const on = ((x / 8) | 0) % 2 === ((y / 8) | 0) % 2;
      rect(c, x + (on ? 0 : 3), y, 1, 1, 'rgba(255,255,255,0.05)');
    }
  }
  rect(c, MEET.x, MEET.y, MEET.w, 3, '#38374a');
  rect(c, MEET.x, MEET.y + MEET.h - 3, MEET.w, 3, '#38374a');
  rect(c, MEET.x, MEET.y, 3, MEET.h, '#38374a');
  rect(c, MEET.x + MEET.w - 3, MEET.y, 3, MEET.h, '#38374a');
  rect(c, MEET.x + 4, MEET.y + 4, MEET.w - 8, 1, 'rgba(255,255,255,0.07)');

  rect(c, SERVER.x, SERVER.y, SERVER.w, SERVER.h, '#39414c');
  for (let y = SERVER.y; y < SERVER.y + SERVER.h; y += TILE) {
    for (let x = SERVER.x; x < SERVER.x + SERVER.w; x += TILE) {
      rect(c, x, y, TILE, 1, 'rgba(0,0,0,0.22)');
      rect(c, x, y, 1, TILE, 'rgba(0,0,0,0.22)');
      rect(c, x + 1, y + 1, TILE - 1, 1, 'rgba(255,255,255,0.035)');
      rect(c, x + TILE - 2, y + 2, 1, 1, 'rgba(255,255,255,0.06)');
    }
  }
  rect(c, SERVER.x, SERVER.y, SERVER.w, 2, '#2c333d');

  rect(c, LOUNGE.x, LOUNGE.y, LOUNGE.w, LOUNGE.h, '#5f4529');
  for (let y = LOUNGE.y + 4; y < LOUNGE.y + LOUNGE.h; y += 8) {
    for (let x = LOUNGE.x + 4; x < LOUNGE.x + LOUNGE.w; x += 32) {
      rect(c, x, y, 28, 1, 'rgba(0,0,0,0.10)');
    }
  }
  rect(c, LOUNGE.x, LOUNGE.y, LOUNGE.w, 2, 'rgba(255,220,160,0.10)');
}

function drawPartitions(c: C2D) {
  const gx = PART_V.x;
  const gw = PART_V.w;
  const gy0 = PART_V.y0;
  const gy1 = PART_V.y1;
  rect(c, gx, gy0, gw, gy1 - gy0, '#2f3744');
  rect(c, gx, gy0, gw, 1, '#4b5664');
  rect(c, gx, gy1 - 1, gw, 1, '#21262f');
  rect(c, gx + 1, gy0, gw - 2, gy1 - gy0, 'rgba(170,210,225,0.10)');
  const segs: [number, number][] = [[gy0, PART_V.door0], [PART_V.door1, gy1]];
  for (const [a, b] of segs) {
    rect(c, gx + 2, a, gw - 4, b - a, 'rgba(160,205,220,0.16)');
    rect(c, gx + 2, a, gw - 4, b - a, 'rgba(255,255,255,0.03)');
    for (let y = a + 6; y + 10 < b; y += 26) {
      pxLine(c, gx + 3, y + 10, gx + gw - 4, y, 'rgba(255,255,255,0.10)');
      pxLine(c, gx + 3, y + 13, gx + gw - 5, y + 4, 'rgba(255,255,255,0.05)');
    }
  }
  for (let y = gy0; y <= gy1; y += 40) {
    rect(c, gx, Math.min(y, gy1 - 2), 2, 2, '#6a7688');
    rect(c, gx + gw - 2, Math.min(y, gy1 - 2), 2, 2, '#6a7688');
  }
  rect(c, gx + 1, PART_V.door0 - 2, 2, 3, '#8a97a8');
  rect(c, gx + 1, PART_V.door1 - 1, 2, 3, '#8a97a8');
  rect(c, gx, PART_V.door0, gw, 2, '#5a6578');
  rect(c, gx, PART_V.door1 - 2, gw, 2, '#5a6578');
  rect(c, gx + gw, PART_V.door0 + 2, 26, 2, '#9fb6c4');
  rect(c, gx + gw, PART_V.door0 + 2, 26, 1, '#c3d7e2');
  rect(c, gx + gw, PART_V.door1 - 4, 26, 2, '#7f95a4');
  rect(c, gx + gw + 21, PART_V.door0 + 3, 2, 1, '#e8edf4');
  rect(c, gx + gw + 21, PART_V.door0 + 4, 1, 3, '#8a97a8');

  const y = PART_H.y;
  const h = PART_H.h;
  let x = PART_H.x0;
  const bar = (a: number, b: number) => {
    if (b <= a) return;
    rect(c, a, y, b - a, h, '#39434f');
    rect(c, a, y, b - a, 1, '#4f5a6a');
    rect(c, a, y + h - 1, b - a, 1, '#242a34');
    for (let px = a + 10; px < b - 4; px += 24) rect(c, px, y + 2, 1, h - 4, 'rgba(0,0,0,0.20)');
    rect(c, a, y + h, b - a, 2, 'rgba(0,0,0,0.22)');
  };
  for (const d of PART_H.doors) {
    bar(x, d[0]);
    rect(c, d[0], y, d[1] - d[0], h, '#2a303b');
    rect(c, d[0], y, d[1] - d[0], 1, '#3a4351');
    rect(c, d[0], y + h - 3, d[1] - d[0], 3, '#1f242c');
    rect(c, d[0] + 2, y + 1, 2, h - 2, '#5a6578');
    rect(c, d[1] - 4, y + 1, 2, h - 2, '#5a6578');
    rect(c, d[0] + 3, y + h, d[1] - d[0] - 6, 3, 'rgba(90,212,200,0.16)');
    x = d[1];
  }
  bar(x, PART_H.x1);
}

function drawMeetingChair(c: C2D, x: number, y: number) {
  shadow(c, x + 6, y + 14, 7, 2, 0.16);
  rect(c, x + 2, y, 8, 2, '#39424f');
  rect(c, x + 1, y + 2, 10, 7, '#39424f');
  rect(c, x + 1, y + 2, 10, 1, '#525d72');
  rect(c, x + 2, y + 3, 8, 6, '#2f3745');
  rect(c, x + 2, y + 3, 8, 1, '#414b5e');
  rect(c, x, y + 9, 12, 3, '#333c49');
  rect(c, x, y + 9, 12, 1, '#4a5570');
  rect(c, x + 1, y + 12, 1, 3, '#262c36');
  rect(c, x + 10, y + 12, 1, 3, '#262c36');
  rect(c, x + 2, y + 15, 1, 1, '#1b2029');
  rect(c, x + 9, y + 15, 1, 1, '#1b2029');
}

function drawMeetingRoom(c: C2D) {
  drawRug(c, 468, 100, 156, 76);
  const tx = 487;
  const ty = 112;
  const tw = 118;
  const th = 40;
  for (const cxx of [tx + 26, tx + tw / 2, tx + tw - 26]) drawMeetingChair(c, cxx, ty - 9);
  shadow(c, tx + tw / 2, ty + th + 3, tw / 2 - 3, 4, 0.22);
  rect(c, tx, ty, tw, th, '#6b4a2a');
  rect(c, tx, ty, tw, 2, '#8a5f36');
  rect(c, tx, ty, tw, 1, '#a0733f');
  rect(c, tx, ty + th - 2, tw, 2, '#4d341c');
  rect(c, tx + 10, ty + 7, tw - 20, th - 14, '#5d4023');
  rect(c, tx + 10, ty + 7, tw - 20, 1, 'rgba(255,255,255,0.05)');
  rect(c, tx + 10, ty + th - 8, tw - 20, 1, 'rgba(0,0,0,0.14)');
  for (const cx of [tx + 26, tx + tw / 2, tx + tw - 26]) {
    rect(c, cx - 7, ty + 13, 14, 2, '#1b2029');
    rect(c, cx - 6, ty + 15, 12, 8, '#2b4a6e');
    rect(c, cx - 6, ty + 15, 12, 1, '#3f86c8');
    rect(c, cx - 3, ty + 23, 6, 2, '#1b2029');
    rect(c, cx - 7, ty + 25, 14, 1, '#1b2029');
  }
  rect(c, tx + 14, ty + 30, 7, 4, '#eef2f6');
  rect(c, tx + 15, ty + 31, 5, 1, 'rgba(0,0,0,0.2)');
  rect(c, tx + tw - 22, ty + 29, 6, 5, '#c0504d');
  rect(c, tx + tw - 22, ty + 29, 6, 1, '#d9756d');
  const px = tx + tw / 2 + 16;
  rect(c, px - 4, ty + 26, 8, 8, '#8a5a33');
  rect(c, px - 4, ty + 26, 8, 1, '#a87345');
  rect(c, px - 2, ty + 22, 2, 4, '#3f8f5a');
  rect(c, px + 1, ty + 21, 2, 5, '#54a86e');
  rect(c, px - 1, ty + 19, 1, 4, '#6bc07d');

  for (const cxx of [tx + 26, tx + tw / 2, tx + tw - 26]) {
    drawMeetingChair(c, cxx, ty + th + 3);
  }

  rect(c, 500, 4, 68, 26, '#1b2029');
  rect(c, 502, 6, 64, 18, '#0f1a2a');
  const bars = [8, 14, 20, 12, 24, 16, 20];
  for (let i = 0; i < bars.length; i++) {
    rect(c, 508 + i * 8, 22 - bars[i] / 3, 3, bars[i] / 3, i % 2 ? '#3AA99F' : '#3f86c8');
  }
  rect(c, 506, 8, 12, 2, '#e0b64d');
  rect(c, 506, 11, 20, 1, 'rgba(255,255,255,0.15)');
  rect(c, 534, 6, 2, 1, '#5a6578');
  rect(c, 560, 6, 2, 1, '#5a6578');
  rect(c, 504, 25, 60, 1, '#2f3744');
  rect(c, 528, 30, 12, 2, '#2b3240');

  rect(c, 614, 176, 36, 14, '#6b4a2a');
  rect(c, 614, 176, 36, 2, '#8a5f36');
  rect(c, 614, 188, 36, 2, '#4d341c');
  rect(c, 617, 180, 4, 6, '#2e3138');
  rect(c, 618, 181, 2, 3, '#6a4a30');
  rect(c, 624, 181, 3, 2, '#dfe8f2');
  rect(c, 630, 181, 3, 2, '#dfe8f2');
  rect(c, 636, 180, 4, 4, '#c0504d');
  rect(c, 636, 180, 4, 1, '#d9756d');

  drawPlant(c, 632, 40);
  drawPlant(c, 428, 196);
}

function drawServerRoom(c: C2D) {
  for (const rx of [568, 586, 604]) drawServerRack(c, rx, 278);
  rect(c, 628, 276, 20, 40, '#2b313d');
  rect(c, 628, 276, 20, 2, '#3c4452');
  rect(c, 629, 279, 18, 34, '#1e232c');
  for (let i = 0; i < 7; i++) rect(c, 631, 282 + i * 4, 14, 2, '#2b313d');
  rect(c, 632, 313, 5, 1, '#5ad46a');
  rect(c, 638, 313, 3, 1, '#e0b64d');
  rect(c, 566, 273, 82, 3, '#20252e');
  rect(c, 568, 274, 50, 1, '#c0504d');
  rect(c, 568, 275, 40, 1, '#3a6ea5');
  rect(c, 620, 274, 24, 1, '#4fae5a');
  for (let i = 0; i < 8; i++) rect(c, 528 + i * 8, 246, 4, 8, i % 2 ? '#2b313d' : '#d0a215');
  rect(c, 520, 246, 32, 8, 'rgba(0,0,0,0.10)');
  drawPlant(c, 428, 322);
  drawBin(c, 548, 330);
}

function drawLoungeRoom(c: C2D) {
  drawRug(c, 52, 258, 286, 78);
  drawCouch(c, 40, 302, 56);
  drawCouch(c, 246, 302, 56);
  drawCoffeeTable(c, 132, 300, 30);
  drawLamp(c, 316, 262);
  drawBookshelf(c, 356, 268);
  drawPlant(c, 24, 258);
  drawPlant(c, 196, 262);
  rect(c, 150, 244, 32, 3, 'rgba(90,212,200,0.18)');
}

function drawBookshelf(c: C2D, x: number, y: number) {
  shadow(c, x + 18, y + 48, 18, 3, 0.24);
  rect(c, x, y, 40, 48, '#4a321c');
  rect(c, x + 2, y + 2, 36, 44, '#2f2117');
  rect(c, x, y, 40, 2, '#6b4a2a');
  for (let s = 0; s < 4; s++) {
    const sy = y + 4 + s * 11;
    rect(c, x + 2, sy + 8, 36, 2, '#5b3f24');
    rect(c, x + 2, sy + 8, 36, 1, '#7a5532');
    let bx = x + 4;
    let bi = 0;
    while (bx < x + 35) {
      const bw = 2 + ((bi + s) % 3);
      const bh = 5 + ((bi * 3 + s) % 3);
      const cols = ['#c0504d', '#4d7fe0', '#4fae5a', '#e0b64d', '#9a6fb0', '#3AA99F'];
      rect(c, bx, sy + 8 - bh, bw, bh, cols[(bi + s * 2) % cols.length]);
      rect(c, bx, sy + 8 - bh, 1, 1, 'rgba(255,255,255,0.3)');
      bx += bw + 1;
      bi++;
    }
  }
  rect(c, x + 2, y + 2, 36, 44, 'rgba(0,0,0,0.05)');
  rect(c, x, y, 2, 48, '#3d3022');
  rect(c, x + 38, y, 2, 48, '#3d3022');
}

function drawRug(c: C2D, x: number, y: number, w: number, h: number) {
  rect(c, x, y, w, h, '#3b6a70');
  rect(c, x, y, w, 1, '#4f848a');
  rect(c, x, y + h - 1, w, 1, '#284a50');
  rect(c, x, y, 1, h, '#4f848a');
  rect(c, x + w - 1, y, 1, h, '#284a50');
  const m = 3;
  rect(c, x + m, y + m, w - m * 2, 1, '#79a89f');
  rect(c, x + m, y + h - m - 1, w - m * 2, 1, '#79a89f');
  rect(c, x + m, y + m, 1, h - m * 2, '#79a89f');
  rect(c, x + w - m - 1, y + m, 1, h - m * 2, '#79a89f');
  for (let i = x + 4; i < x + w - 4; i += 4) {
    rect(c, i, y + m + 2, 1, 1, '#335c62');
    rect(c, i, y + h - m - 3, 1, 1, '#335c62');
  }
  const cx = x + w / 2;
  const cy = y + h / 2;
  for (let d = 0; d < 3; d++) {
    const r = 3 + d * 4;
    for (let i = -r; i <= r; i++) {
      const a = Math.abs(i);
      if ((r - a) % 2 === 0) continue;
      rect(c, cx + i, cy - (r - a), 1, 1, d === 1 ? '#8fbcb2' : '#62938c');
      rect(c, cx + i, cy + (r - a), 1, 1, d === 1 ? '#8fbcb2' : '#62938c');
      rect(c, cx - (r - a), cy + i, 1, 1, d === 1 ? '#8fbcb2' : '#62938c');
      rect(c, cx + (r - a), cy + i, 1, 1, d === 1 ? '#8fbcb2' : '#62938c');
    }
  }
  rect(c, cx, cy - 1, 1, 1, '#e8d9a8');
  rect(c, cx - 1, cy, 1, 1, '#e8d9a8');
  rect(c, cx + 1, cy, 1, 1, '#e8d9a8');
  rect(c, cx, cy + 1, 1, 1, '#e8d9a8');
  rect(c, cx, cy, 1, 1, '#c9b477');
}

function drawWalls(c: C2D) {
  const wallH = 2 * TILE;
  rect(c, 0, 0, W, wallH, '#39434f');
  for (let x = 0; x < W; x += 10) rect(c, x + 2, 3, 5, 14, '#3f4a57');
  for (let x = 12; x < W; x += 20) {
    rect(c, x, 7, 1, 1, '#4d5967');
    rect(c, x + 8, 12, 1, 1, '#4d5967');
  }
  rect(c, 0, 0, W, 3, '#2a323d');
  rect(c, 0, 3, W, 1, '#4b5664');
  rect(c, 0, 17, W, 2, '#5b6778');
  rect(c, 0, 18, W, 1, '#3d4755');
  rect(c, 0, 19, W, 9, '#4a3a29');
  rect(c, 0, 19, W, 1, '#5c4933');
  for (let x = 0; x < W; x += 8) {
    rect(c, x, 19, 1, 9, '#3d3022');
    rect(c, x + 1, 19, 1, 9, '#54422e');
  }
  rect(c, 0, 28, W, 4, '#262c36');
  rect(c, 0, 28, W, 1, '#3a4351');

  const sideH = ROWS * TILE;
  rect(c, 0, 0, TILE, sideH, '#39434f');
  for (let y = 0; y < sideH; y += 10) rect(c, 0, y + 2, 11, 5, '#3f4a57');
  rect(c, 8, 0, 1, sideH, '#5b6778');
  rect(c, 9, 0, 3, sideH, '#4a3a29');
  for (let y = 0; y < sideH; y += 8) rect(c, 9, y, 3, 1, '#3d3022');
  rect(c, 12, 0, 4, sideH, '#262c36');
  rect(c, 12, 0, 1, sideH, '#3a4351');

  rect(c, (COLS - 1) * TILE, 0, TILE, sideH, '#39434f');
  for (let y = 0; y < sideH; y += 10) rect(c, (COLS - 1) * TILE + 5, y + 2, 11, 5, '#3f4a57');
  rect(c, (COLS - 1) * TILE + 7, 0, 1, sideH, '#5b6778');
  rect(c, (COLS - 1) * TILE + 4, 0, 3, sideH, '#4a3a29');
  for (let y = 0; y < sideH; y += 8) rect(c, (COLS - 1) * TILE + 4, y, 3, 1, '#3d3022');
  rect(c, (COLS - 1) * TILE, 0, 4, sideH, '#262c36');
  rect(c, (COLS - 1) * TILE + 3, 0, 1, sideH, '#3a4351');

  const fx0 = TILE;
  const fx1 = (COLS - 1) * TILE;
  for (let i = 0; i < 8; i++) rect(c, fx0, 2 * TILE + i, fx1 - fx0, 1, `rgba(0,0,0,${0.17 - i * 0.02})`);
  for (let i = 0; i < 5; i++) {
    rect(c, fx0 + i, 2 * TILE, 1, ROWS * TILE - 2 * TILE, `rgba(0,0,0,${0.15 - i * 0.03})`);
    rect(c, fx1 - 1 - i, 2 * TILE, 1, ROWS * TILE - 2 * TILE, `rgba(0,0,0,${0.15 - i * 0.03})`);
  }
}

function drawWhiteboard(c: C2D, x: number, y: number) {
  rect(c, x, y, 62, 22, '#8a8f98');
  rect(c, x + 1, y + 1, 60, 20, '#f2f6f9');
  rect(c, x + 1, y + 1, 60, 2, '#ffffff');
  for (let i = 0; i < 5; i++) rect(c, x + 4, y + 4 + i * 3, 1, 1, 'rgba(0,0,0,0.05)');
  rect(c, x + 4, y + 4, 14, 2, '#e05a4d');
  rect(c, x + 4, y + 8, 22, 2, '#4d7fe0');
  rect(c, x + 4, y + 12, 16, 2, '#4fae5a');
  rect(c, x + 4, y + 16, 24, 1, '#8a8f98');
  rect(c, x + 6, y + 17, 9, 1, '#8a8f98');
  const bx = x + 30;
  const by = y + 6;
  rect(c, bx, by, 9, 5, '#2b6fa8');
  rect(c, bx + 1, by + 1, 7, 3, '#4d8fc4');
  rect(c, bx + 4, by + 5, 1, 3, '#2b6fa8');
  rect(c, bx + 2, by + 8, 5, 4, '#3f8f5a');
  rect(c, bx + 2, by + 8, 5, 1, '#4fae5a');
  rect(c, bx + 9, by + 10, 3, 1, '#8a8f98');
  rect(c, bx + 12, by + 8, 6, 4, '#e0b64d');
  rect(c, bx + 12, by + 8, 6, 1, '#efd48a');
  rect(c, x + 40, y + 4, 5, 5, '#e8c84d');
  rect(c, x + 40, y + 4, 5, 1, '#f5dd7a');
  rect(c, x + 47, y + 5, 5, 5, '#e89a9a');
  rect(c, x + 47, y + 5, 5, 1, '#f2b4b4');
  rect(c, x + 52, y + 16, 5, 4, '#8ac8b4');
  rect(c, x + 52, y + 16, 5, 1, '#a8dccb');
  rect(c, x, y + 22, 62, 2, '#5a5f68');
  rect(c, x + 4, y + 22, 10, 1, '#c0504d');
  rect(c, x + 15, y + 22, 10, 1, '#3a6ea5');
  rect(c, x + 26, y + 22, 8, 1, '#3f8f5a');
}

const CLOCK = { x: 44, y: 8 };
const WINDOW = { x: 84, y: 4, w: 48, h: 24 };

function drawClock(c: C2D, x: number, y: number) {
  rect(c, x, y, 12, 12, '#2b303a');
  rect(c, x + 1, y + 1, 10, 10, '#dfe6ee');
  rect(c, x + 5, y + 1, 2, 1, '#8a8f98');
}

function drawClockHands(c: C2D, d: Date) {
  const cx = CLOCK.x + 6;
  const cy = CLOCK.y + 6;
  const min = d.getMinutes() + d.getSeconds() / 60;
  const hr = (d.getHours() % 12) + min / 60;
  const aM = (min / 60) * Math.PI * 2 - Math.PI / 2;
  const aH = (hr / 12) * Math.PI * 2 - Math.PI / 2;
  const hand = (ang: number, len: number, col: string) => {
    for (let i = 1; i <= len; i++) {
      rect(c, Math.round(cx + Math.cos(ang) * i), Math.round(cy + Math.sin(ang) * i), 1, 1, col);
    }
  };
  hand(aH, 3, '#2b303a');
  hand(aM, 4, '#4a5262');
  rect(c, cx, cy, 1, 1, '#c0504d');
}

function drawWindow(c: C2D, x: number, y: number, w: number, h: number) {
  rect(c, x, y, w, h, '#2b3240');
  const iw = w - 4;
  const ih = h - 4;
  rect(c, x + 2, y + 2, iw, ih, '#9fd0e6');
  rect(c, x + 2, y + 2 + Math.floor(ih * 0.25), iw, Math.ceil(ih * 0.25), '#8ac3dd');
  rect(c, x + 2, y + 2 + Math.floor(ih * 0.5), iw, Math.ceil(ih * 0.25), '#76b6d4');
  rect(c, x + 2, y + 2 + Math.floor(ih * 0.75), iw, Math.ceil(ih * 0.25), '#67a9c9');
  const sy = y + h - 10;
  rect(c, x + 3, sy + 2, 5, 7, '#40615a');
  rect(c, x + 9, sy + 4, 4, 5, '#375650');
  rect(c, x + 14, sy, 4, 9, '#3b5a52');
  rect(c, x + 19, sy + 3, 5, 6, '#33504a');
  rect(c, x + 25, sy + 1, 4, 8, '#40615a');
  rect(c, x + 30, sy + 5, 5, 4, '#375650');
  rect(c, x + 36, sy + 2, 5, 7, '#3b5a52');
  rect(c, x + 8, sy + 2, 1, 1, '#e6d69a');
  rect(c, x + 16, sy + 1, 1, 1, '#e6d69a');
  rect(c, x + 27, sy + 2, 1, 1, '#e6d69a');
  rect(c, x + 38, sy + 4, 1, 1, '#e6d69a');
  rect(c, x + 6, y + 5, 11, 2, 'rgba(255,255,255,0.75)');
  rect(c, x + 24, y + 8, 13, 2, 'rgba(255,255,255,0.65)');
  for (let i = 0; i < 4; i++) rect(c, x + 3, y + 4 + i * 2, iw - 2, 1, 'rgba(40,52,66,0.18)');
  rect(c, x + iw / 2 + 1, y + 2, 2, ih, '#2b3240');
  rect(c, x + 2, y + ih / 2 + 1, iw, 2, '#2b3240');
  rect(c, x - 2, y + h, w + 4, 3, '#262c36');
  rect(c, x - 2, y + h, w + 4, 1, '#3a4150');
  rect(c, x + 6, y + h - 1, 9, 4, '#8a5a33');
  rect(c, x + 6, y + h - 1, 9, 1, '#a06b3d');
  rect(c, x + 7, y + h - 5, 3, 4, '#3f8f5a');
  rect(c, x + 11, y + h - 6, 3, 5, '#54a86e');
  rect(c, x + 8, y + h - 6, 2, 2, '#6bc07d');
}

function drawWindowLight(c: C2D) {
  for (let i = 0; i < 16; i++) {
    const inset = i * 1.3;
    rect(c, WINDOW.x + 2 + inset * 0.35, 2 * TILE + i, WINDOW.w - 4 - inset * 0.7, 1, `rgba(255,232,168,${0.055 * (1 - i / 16)})`);
  }
}

function drawLighting(c: C2D) {
  const pools: [number, number, number, number][] = [
    [110, 62, 86, 0.055],
    [200, 150, 70, 0.045],
    [322, 176, 64, 0.04],
    [80, 200, 60, 0.05],
    [545, 132, 92, 0.05],
    [590, 300, 66, 0.035],
    [180, 300, 86, 0.045],
  ];
  for (const [x, y, r, a] of pools) {
    const g = c.createRadialGradient(x * S, y * S, 4 * S, x * S, y * S, r * S);
    g.addColorStop(0, `rgba(255,228,158,${a})`);
    g.addColorStop(1, 'rgba(255,228,158,0)');
    c.fillStyle = g;
    c.fillRect((x - r) * S, (y - r) * S, r * 2 * S, r * 2 * S);
  }
}

function drawDoor(c: C2D) {
  rect(c, 1, 92, 11, 52, '#4a3a2a');
  rect(c, 1, 92, 11, 3, '#5d4a35');
  rect(c, 3, 97, 7, 20, '#3d3022');
  rect(c, 3, 121, 7, 19, '#3d3022');
  rect(c, 3, 97, 7, 1, '#57452f');
  rect(c, 3, 121, 7, 1, '#57452f');
  rect(c, 8, 116, 2, 2, '#d0b04a');
  rect(c, 0, 143, 16, 3, '#262c36');
}

function drawPoster(c: C2D, x: number, y: number, col: string, col2: string) {
  rect(c, x, y, 16, 20, '#2b303a');
  rect(c, x + 1, y + 1, 14, 18, col);
  rect(c, x + 3, y + 4, 10, 6, col2);
  rect(c, x + 3, y + 12, 10, 2, 'rgba(255,255,255,0.5)');
  rect(c, x + 3, y + 15, 7, 2, 'rgba(255,255,255,0.35)');
}

function drawArt(c: C2D, x: number, y: number, kind: number) {
  rect(c, x, y, 22, 15, '#c9b184');
  rect(c, x + 1, y + 1, 20, 13, '#8a6d45');
  rect(c, x + 2, y + 2, 18, 11, '#2b303a');
  const ix = x + 3;
  const iy = y + 3;
  if (kind === 0) {
    rect(c, ix, iy, 16, 9, '#f2b36a');
    rect(c, ix, iy, 16, 3, '#e88a5a');
    rect(c, ix, iy + 3, 16, 2, '#f6c98a');
    rect(c, ix + 9, iy + 2, 3, 3, '#ffd98f');
    rect(c, ix, iy + 6, 16, 3, '#7a5a6a');
    rect(c, ix, iy + 7, 6, 2, '#5b4458');
    rect(c, ix + 8, iy + 6, 4, 3, '#5b4458');
    rect(c, ix + 2, iy + 5, 1, 1, '#fff2c0');
  } else if (kind === 1) {
    rect(c, ix, iy, 16, 9, '#7fb8d6');
    rect(c, ix, iy, 16, 4, '#6aa8cb');
    rect(c, ix + 1, iy + 4, 5, 3, '#e8eef2');
    rect(c, ix + 4, iy + 2, 4, 5, '#e8eef2');
    rect(c, ix + 7, iy + 5, 5, 2, '#dfe7ec');
    rect(c, ix + 12, iy + 3, 3, 4, '#e8eef2');
    rect(c, ix, iy + 6, 16, 3, '#5f8a5c');
    rect(c, ix, iy + 8, 16, 1, '#4a6f48');
  } else {
    rect(c, ix, iy, 16, 9, '#2f4a5a');
    rect(c, ix + 2, iy + 1, 5, 5, '#e0b64d');
    rect(c, ix + 9, iy + 3, 4, 4, '#c05a4d');
    rect(c, ix + 5, iy + 5, 6, 3, '#3AA99F');
    rect(c, ix + 12, iy + 1, 2, 2, '#dfe8f2');
  }
}

function drawNeon(c: C2D, x: number, y: number) {
  rect(c, x - 3, y - 3, 34, 22, 'rgba(58,169,159,0.07)');
  rect(c, x - 1, y - 1, 30, 18, 'rgba(58,169,159,0.09)');
  rect(c, x, y, 28, 16, '#1b2029');
  rect(c, x + 1, y + 1, 26, 14, '#0e1218');
  rect(c, x + 1, y + 1, 26, 1, '#3f7f7a');
  rect(c, x + 1, y + 14, 26, 1, '#3f7f7a');
  rect(c, x + 1, y + 1, 1, 14, '#3f7f7a');
  rect(c, x + 26, y + 1, 1, 14, '#3f7f7a');
  rect(c, x + 3, y + 3, 22, 1, 'rgba(90,212,200,0.16)');
  pxLine(c, x + 7, y + 9, x + 15, y + 5, 'rgba(90,212,200,0.5)');
  pxLine(c, x + 15, y + 5, x + 21, y + 10, 'rgba(226,120,180,0.5)');
  pxLine(c, x + 15, y + 5, x + 13, y + 12, 'rgba(90,212,200,0.4)');
  pxLine(c, x + 7, y + 9, x + 13, y + 12, 'rgba(138,180,248,0.35)');
  rect(c, x + 6, y + 8, 3, 3, '#5ad4c8');
  rect(c, x + 7, y + 9, 1, 1, '#eafffb');
  rect(c, x + 14, y + 4, 3, 3, '#e278b4');
  rect(c, x + 15, y + 5, 1, 1, '#ffe0f2');
  rect(c, x + 20, y + 9, 3, 3, '#5ad4c8');
  rect(c, x + 21, y + 10, 1, 1, '#eafffb');
  rect(c, x + 12, y + 11, 3, 3, '#8ab4f8');
  rect(c, x + 13, y + 12, 1, 1, '#eaf2ff');
  rect(c, x, y + 16, 28, 1, 'rgba(58,169,159,0.12)');
}

function drawNeonGlow(c: C2D, t: number) {
  const a = 0.05 + 0.028 * (0.5 + 0.5 * Math.sin(t * 1.7));
  const g = c.createRadialGradient(360 * S, 14 * S, 3 * S, 360 * S, 14 * S, 34 * S);
  g.addColorStop(0, `rgba(90,212,200,${a.toFixed(3)})`);
  g.addColorStop(0.5, `rgba(226,120,180,${(a * 0.35).toFixed(3)})`);
  g.addColorStop(1, 'rgba(90,212,200,0)');
  c.fillStyle = g;
  c.fillRect((360 - 34) * S, (14 - 34) * S, 68 * S, 68 * S);
}

function drawShelf(c: C2D, x: number, y: number) {
  rect(c, x, y + 7, 32, 2, '#6b4a2a');
  rect(c, x, y + 7, 32, 1, '#8a5f36');
  rect(c, x, y + 15, 32, 2, '#6b4a2a');
  rect(c, x, y + 15, 32, 1, '#8a5f36');
  rect(c, x + 1, y + 9, 3, 6, '#4a321c');
  rect(c, x + 28, y + 9, 3, 6, '#4a321c');
  rect(c, x + 8, y + 9, 2, 6, '#3d3022');
  const cols = ['#c0504d', '#4d7fe0', '#4fae5a', '#e0b64d', '#9a6fb0'];
  for (let i = 0; i < 6; i++) {
    const bh = 4 + ((i * 7) % 3);
    rect(c, x + 2 + i * 3, y + 7 - bh, 2, bh, cols[i % cols.length]);
    rect(c, x + 2 + i * 3, y + 7 - bh, 1, 1, 'rgba(255,255,255,0.35)');
  }
  rect(c, x + 20, y + 3, 4, 4, '#8a5a33');
  rect(c, x + 20, y + 3, 4, 1, '#a06b3d');
  rect(c, x + 20, y + 1, 2, 3, '#3f8f5a');
  rect(c, x + 23, y, 2, 4, '#54a86e');
  rect(c, x + 25, y + 5, 4, 2, '#dfe8f2');
  rect(c, x + 26, y + 3, 2, 2, '#e0b64d');
  for (let i = 0; i < 5; i++) rect(c, x + 2 + i * 4, y + 12, 3, 3, cols[(i + 2) % cols.length]);
  rect(c, x + 22, y + 11, 8, 4, '#dfe8f2');
  rect(c, x + 22, y + 11, 8, 1, '#ffffff');
  rect(c, x + 24, y + 12, 4, 1, '#8a8f98');
}

function drawPrinter(c: C2D, x: number, y: number) {
  shadow(c, x + 8, y + 14, 8, 2, 0.2);
  rect(c, x, y + 4, 16, 10, '#2f3540');
  rect(c, x, y + 4, 16, 1, '#424a58');
  rect(c, x + 1, y, 14, 5, '#3a4250');
  rect(c, x + 2, y + 1, 12, 1, '#4d5668');
  rect(c, x + 2, y + 6, 12, 3, '#1e232c');
  rect(c, x + 3, y + 7, 9, 1, '#eef2f6');
  rect(c, x + 3, y + 8, 9, 1, '#dfe6ee');
  rect(c, x + 12, y + 9, 2, 1, '#5ad46a');
  rect(c, x + 2, y + 11, 10, 2, '#262c36');
  rect(c, x + 4, y + 12, 6, 1, '#4d5668');
}

function drawPlant(c: C2D, x: number, y: number) {
  shadow(c, x + 8, y + 16, 7, 3, 0.24);
  rect(c, x + 3, y + 10, 10, 6, '#8a5a33');
  rect(c, x + 3, y + 10, 10, 1, '#a87345');
  rect(c, x + 3, y + 15, 10, 1, '#6b4426');
  rect(c, x + 2, y + 9, 12, 2, '#9a6440');
  rect(c, x + 2, y + 9, 12, 1, '#b07a4c');
  rect(c, x + 4, y + 10, 8, 1, '#3d2a18');
  rect(c, x + 1, y + 3, 4, 7, '#2f6f46');
  rect(c, x + 11, y + 3, 4, 7, '#2f6f46');
  rect(c, x + 2, y + 4, 1, 5, '#54a86e');
  rect(c, x + 12, y + 4, 1, 5, '#54a86e');
  rect(c, x + 4, y, 3, 9, '#3f8f5a');
  rect(c, x + 9, y + 1, 3, 9, '#357a4c');
  rect(c, x + 5, y + 1, 1, 7, '#6bc07d');
  rect(c, x + 6, y - 3, 4, 7, '#54a86e');
  rect(c, x + 7, y - 4, 2, 3, '#7ccf8c');
  rect(c, x, y + 5, 5, 2, '#3f8f5a');
  rect(c, x + 11, y + 5, 5, 2, '#3f8f5a');
  rect(c, x + 1, y + 5, 3, 1, '#6bc07d');
  rect(c, x + 12, y + 5, 3, 1, '#6bc07d');
}

function drawCooler(c: C2D, x: number, y: number) {
  shadow(c, x + 8, y + 16, 7, 3, 0.2);
  rect(c, x + 3, y + 7, 10, 10, '#dfe8f2');
  rect(c, x + 3, y + 7, 10, 1, '#ffffff');
  rect(c, x + 3, y + 15, 10, 2, '#b9c6d4');
  rect(c, x + 5, y - 3, 6, 10, '#bcd6ea');
  rect(c, x + 5, y - 3, 2, 10, '#eaf3fb');
  rect(c, x + 4, y + 11, 5, 2, '#2f6fa8');
}

function drawCoffee(c: C2D, x: number, y: number) {
  shadow(c, x + 8, y + 15, 8, 3, 0.2);
  rect(c, x + 1, y + 2, 14, 14, '#2e3138');
  rect(c, x + 1, y + 2, 14, 2, '#3c4048');
  rect(c, x + 3, y + 6, 10, 5, '#1b1d22');
  rect(c, x + 4, y + 7, 8, 3, '#6a4a30');
  rect(c, x + 2, y + 12, 12, 3, '#3c4048');
  rect(c, x + 6, y + 16, 4, 1, '#1b1d22');
}

function drawCouch(c: C2D, x: number, y: number, w: number) {
  shadow(c, x + w / 2, y + 15, w / 2 - 1, 3, 0.24);
  rect(c, x, y + 2, w, 12, '#46536a');
  rect(c, x, y + 2, w, 2, '#5a6a86');
  rect(c, x, y, w, 4, '#5a6a86');
  rect(c, x, y, w, 1, '#71819e');
  rect(c, x, y + 12, w, 2, '#38445a');
  const seg = w / 3;
  for (let i = 1; i < 3; i++) {
    const seam = Math.round(x + seg * i);
    rect(c, seam, y + 2, 1, 12, '#38445a');
    rect(c, seam + 1, y + 2, 1, 12, '#55647e');
  }
  rect(c, x + 1, y + 1, 9, 9, '#63738f');
  rect(c, x + 1, y + 1, 9, 1, '#7a8aa6');
  rect(c, x + 2, y + 8, 7, 1, 'rgba(255,255,255,0.10)');
  const px = x + w - 14;
  rect(c, px, y - 3, 8, 8, '#c05a4d');
  rect(c, px, y - 3, 8, 1, '#d97a6a');
  rect(c, px + 1, y - 1, 6, 1, 'rgba(255,255,255,0.18)');
  rect(c, px + 6, y - 3, 1, 8, '#a3483e');
  rect(c, x + 4, y + 13, 7, 6, '#2f8a8a');
  rect(c, x + 4, y + 13, 7, 1, '#3fa0a0');
  rect(c, x + 4, y + 18, 7, 1, '#246e6e');
  rect(c, x + 10, y + 13, 2, 6, '#246e6e');
  rect(c, x + w - 13, y + 13, 8, 6, '#8a6d2a');
  rect(c, x + w - 13, y + 13, 8, 1, '#a8863a');
  rect(c, x + w - 12, y + 14, 6, 1, '#6f5620');
  rect(c, x + w - 12, y + 16, 6, 1, '#6f5620');
  rect(c, x + 2, y + 14, 2, 2, '#2b2117');
  rect(c, x + w - 4, y + 14, 2, 2, '#2b2117');
  rect(c, x + 2, y + 5, w - 4, 1, 'rgba(255,255,255,0.04)');
  rect(c, x + 2, y + 9, w - 4, 1, 'rgba(0,0,0,0.10)');
}

function drawCoffeeTable(c: C2D, x: number, y: number, w: number) {
  shadow(c, x + w / 2, y + 10, w / 2 - 1, 3, 0.24);
  rect(c, x, y, w, 9, '#6b4a2a');
  rect(c, x, y, w, 2, '#8a5f36');
  rect(c, x, y, w, 1, '#a0733f');
  rect(c, x, y + 7, w, 2, '#4d341c');
  rect(c, x + 2, y + 2, 1, 5, 'rgba(0,0,0,0.12)');
  rect(c, x + w - 3, y + 2, 1, 5, 'rgba(0,0,0,0.12)');
  rect(c, x + w / 2 - 6, y - 2, 12, 5, '#1b2029');
  rect(c, x + w / 2 - 5, y - 1, 10, 3, '#2b4a6e');
  rect(c, x + w / 2 - 5, y - 1, 10, 1, '#3f86c8');
  rect(c, x + w / 2 - 2, y + 3, 4, 1, '#1b2029');
  rect(c, x + 3, y + 3, 5, 3, '#eef2f6');
  rect(c, x + 3, y + 3, 5, 1, '#ffffff');
  rect(c, x + 4, y + 4, 3, 1, 'rgba(0,0,0,0.2)');
  rect(c, x + 4, y + 6, 4, 1, '#c0504d');
  rect(c, x + 4, y + 7, 4, 1, '#8a3d38');
  rect(c, x + w - 8, y + 2, 5, 4, '#3f8f5a');
  rect(c, x + w - 7, y + 1, 3, 2, '#54a86e');
  rect(c, x + w - 8, y + 5, 5, 2, '#8a5a33');
  rect(c, x + 1, y + 9, 1, 3, '#4d341c');
  rect(c, x + w - 2, y + 9, 1, 3, '#4d341c');
}

function drawBin(c: C2D, x: number, y: number) {
  shadow(c, x + 5, y + 13, 5, 2, 0.2);
  rect(c, x, y + 2, 10, 11, '#5b6270');
  rect(c, x, y + 2, 10, 2, '#6d7584');
  rect(c, x, y + 12, 10, 1, '#464d59');
  rect(c, x + 1, y + 5, 8, 1, 'rgba(255,255,255,0.08)');
}

function drawLamp(c: C2D, x: number, y: number) {
  rect(c, x + 5, y + 6, 2, 16, '#3c4048');
  rect(c, x + 1, y + 22, 10, 2, '#2b2f36');
  rect(c, x + 2, y + 1, 8, 6, '#e0b64d');
  rect(c, x + 1, y, 10, 2, '#8a6d2a');
  const g = c.createLinearGradient(x * S, y * S, x * S, (y + 26) * S);
  g.addColorStop(0, 'rgba(255,225,140,0.18)');
  g.addColorStop(1, 'rgba(255,225,140,0)');
  c.fillStyle = g;
  c.fillRect((x - 6) * S, (y + 6) * S, 22 * S, 22 * S);
}

function drawServerRack(c: C2D, x: number, y: number) {
  shadow(c, x + 7, y + 50, 8, 3, 0.26);
  rect(c, x, y, 14, 50, '#232833');
  rect(c, x, y, 14, 2, '#333a48');
  rect(c, x, y, 14, 1, '#414a5c');
  rect(c, x + 1, y + 3, 12, 44, '#181c25');
  rect(c, x + 1, y + 3, 1, 44, '#2b313d');
  rect(c, x + 12, y + 3, 1, 44, '#10131a');
  for (let i = 0; i < 6; i++) {
    const uy = y + 4 + i * 7;
    rect(c, x + 2, uy, 10, 6, '#2b313d');
    rect(c, x + 2, uy, 10, 1, '#3a4250');
    rect(c, x + 2, uy + 5, 10, 1, '#20242e');
    rect(c, x + 3, uy + 2, 1, 1, '#4a5464');
    rect(c, x + 3, uy + 3, 7, 1, 'rgba(255,255,255,0.06)');
    for (let v = 0; v < 3; v++) rect(c, x + 5 + v, uy + 2, 1, 2, '#1b2029');
    rect(c, x + 10, uy + 2, 1, 3, '#10131a');
  }
  rect(c, x + 2, y + 47, 10, 2, '#20242e');
  rect(c, x + 3, y + 1, 8, 1, 'rgba(255,255,255,0.10)');
  rect(c, x - 1, y + 8, 1, 30, '#3a2a1c');
  rect(c, x - 1, y + 8, 1, 6, '#c0504d');
  rect(c, x - 1, y + 16, 1, 8, '#3a6ea5');
  rect(c, x - 1, y + 26, 1, 6, '#4fae5a');
}

const RACK = { x: 344, y: 40 };

const ZONE_VIEWS = [
  { id: 'work', labelKey: 'office.zoneWork', room: { x: 16, y: 0, w: 384, h: 228 } },
  { id: 'meet', labelKey: 'office.zoneMeet', room: { x: 424, y: 0, w: 232, h: 228 } },
  { id: 'lounge', labelKey: 'office.zoneLounge', room: { x: 16, y: 232, w: 384, h: 120 } },
  { id: 'server', labelKey: 'office.zoneServer', room: { x: 424, y: 232, w: 232, h: 120 } },
] as const;

const SERVER_RACKS = [
  { x: 568, y: 278 },
  { x: 586, y: 278 },
  { x: 604, y: 278 },
];

function drawRackLeds(c: C2D, t: number) {
  const cols = ['#5ad46a', '#e0b64d', '#5aa7d9'];
  const racks = [RACK, ...SERVER_RACKS];
  for (let r = 0; r < racks.length; r++) {
    const rk = racks[r];
    for (let i = 0; i < 6; i++) {
      const uy = rk.y + 4 + i * 7;
      for (let k = 0; k < 3; k++) {
        const on = Math.floor(t * 3 + i * 1.7 + k * 0.9 + r * 2.3) % 3 === 0;
        rect(c, rk.x + 3 + k * 2, uy + 2, 1, 2, on ? cols[(i + k + r) % 3] : '#1a1f28');
      }
    }
  }
}

function drawAmbient(c: C2D, t: number) {
  for (let i = 0; i < 12; i++) {
    const x = WINDOW.x + 7 + ((i * 37) % (WINDOW.w - 14)) + Math.sin(t * 0.6 + i * 1.7) * 3;
    const y = 2 * TILE + 3 + ((i * 131 + t * (3 + (i % 3))) % (7 * TILE));
    const a = 0.07 + 0.09 * Math.max(0, Math.sin(t * 1.1 + i * 2.1));
    rect(c, x, y, 1, 1, `rgba(255,240,195,${a.toFixed(3)})`);
  }
  const sx = 364;
  const sy = 5 * TILE + 3;
  for (let i = 0; i < 3; i++) {
    const p = (t * 0.5 + i * 0.33) % 1;
    const y = sy - p * 11;
    const x = sx + Math.sin(t * 1.3 + i * 2.1) * 1.5;
    const a = 0.22 * (1 - p);
    rect(c, x, y, 1, 1, `rgba(232,240,248,${a.toFixed(3)})`);
    rect(c, x + 1, y + 1.5, 1, 1, `rgba(232,240,248,${(a * 0.5).toFixed(3)})`);
  }
}

function drawSeatChair(c: C2D, cx: number, cy: number, seed: number) {
  const a = seed % 2 === 0 ? '#343a45' : '#3a414d';
  const b = seed % 2 === 0 ? '#48505f' : '#50596a';
  shadow(c, cx, cy, 9, 2.5, 0.26);
  rect(c, cx - 7, cy - 20, 14, 9, a);
  rect(c, cx - 7, cy - 20, 14, 1, b);
  rect(c, cx - 6, cy - 19, 12, 7, '#2c323d');
  rect(c, cx - 6, cy - 19, 12, 1, '#3b4250');
  rect(c, cx - 9, cy - 12, 2, 3, b);
  rect(c, cx + 7, cy - 12, 2, 3, b);
  rect(c, cx - 7, cy - 9, 14, 3, a);
  rect(c, cx - 7, cy - 9, 14, 1, b);
  rect(c, cx - 1, cy - 6, 2, 4, '#2b303a');
  rect(c, cx - 1, cy - 6, 1, 4, '#3a4150');
  rect(c, cx - 6, cy - 2, 12, 2, '#2b303a');
  rect(c, cx - 6, cy - 2, 12, 1, '#3a4150');
  rect(c, cx - 7, cy - 1, 2, 1, '#1f232b');
  rect(c, cx + 5, cy - 1, 2, 1, '#1f232b');
  rect(c, cx - 4, cy, 1, 1, '#15171d');
  rect(c, cx + 3, cy, 1, 1, '#15171d');
}

function drawDesk(c: C2D, x: number, y: number, sel: boolean, seed: number, accent: string, t: number) {
  shadow(c, x + 16, y + 15, 17, 3, 0.24);
  rect(c, x, y + 8, 32, 6, '#5b3f24');
  rect(c, x, y + 8, 32, 1, '#6b4a2a');
  rect(c, x + 1, y + 13, 2, 2, '#4a321c');
  rect(c, x + 29, y + 13, 2, 2, '#4a321c');
  rect(c, x + 4, y + 10, 24, 2, '#4f361f');
  rect(c, x + 13, y + 10, 6, 1, '#8a6238');
  rect(c, x, y, 32, 8, '#7d5630');
  rect(c, x, y, 32, 2, '#95683a');
  rect(c, x, y + 2, 32, 1, '#875d34');
  rect(c, x, y + 7, 32, 1, '#5b3f24');
  rect(c, x, y, 1, 8, '#95683a');
  for (let i = 0; i < 4; i++) rect(c, x + 3 + i * 7, y + 3, 5, 1, 'rgba(0,0,0,0.09)');

  const gl = c.createRadialGradient((x + 16) * S, (y - 1) * S, 2 * S, (x + 16) * S, (y - 1) * S, 18 * S);
  gl.addColorStop(0, 'rgba(120,190,255,0.16)');
  gl.addColorStop(1, 'rgba(120,190,255,0)');
  c.fillStyle = gl;
  c.fillRect((x - 4) * S, (y - 18) * S, 40 * S, 26 * S);

  rect(c, x + 9, y - 3, 15, 9, '#1b2029');
  rect(c, x + 9, y - 3, 15, 1, '#2f3746');
  rect(c, x + 10, y - 2, 13, 7, sel ? '#0f2b45' : '#0e1c2e');
  rect(c, x + 10, y - 2, 13, 1, '#1d3450');
  const lineCols = ['#4fae5a', '#5aa7d9', '#e0b64d', '#c0504d', '#8ab4f8'];
  for (let i = 0; i < 4; i++) {
    const w = 2 + ((seed + i * 3) % 5);
    rect(c, x + 11, y - 1 + i, w, 1, lineCols[(seed + i) % lineCols.length]);
  }
  rect(c, x + 16, y - 1, 1, 4, 'rgba(255,255,255,0.10)');
  rect(c, x + 11, y + 3, 3 + (seed % 4), 1, '#3a6ea8');
  if (Math.floor(t * 1.9 + seed) % 2 === 0) rect(c, x + 11, y + 2, 1, 1, '#9ec6ff');
  rect(c, x + 12, y + 6, 4, 1, '#232833');
  rect(c, x + 20, y - 2, 2, 2, '#e0b64d');
  rect(c, x + 22, y - 1, 1, 1, '#efd48a');
  rect(c, x + 10, y - 4, 13, 1, 'rgba(120,190,255,0.10)');

  rect(c, x + 8, y + 4, 14, 3, accent);
  rect(c, x + 8, y + 4, 14, 1, 'rgba(255,255,255,0.22)');
  for (let i = 0; i < 6; i++) rect(c, x + 9 + i * 2, y + 5, 1, 1, 'rgba(0,0,0,0.35)');
  for (let i = 0; i < 6; i++) rect(c, x + 9 + i * 2, y + 6, 1, 1, 'rgba(0,0,0,0.22)');
  rect(c, x + 23, y + 5, 3, 3, '#d8dde6');
  rect(c, x + 23, y + 5, 3, 1, '#f2f5f9');
  rect(c, x + 24, y + 6, 1, 1, '#9aa3b0');

  rect(c, x + 2, y - 2, 6, 4, '#eef2f6');
  rect(c, x + 2, y - 2, 6, 1, '#ffffff');
  rect(c, x + 3, y - 1, 4, 1, 'rgba(0,0,0,0.22)');
  rect(c, x + 3, y + 1, 3, 1, 'rgba(0,0,0,0.14)');

  const mug = seed % 2 === 0 ? 27 : 26;
  rect(c, x + mug, y - 3, 4, 4, '#c0504d');
  rect(c, x + mug, y - 3, 4, 1, '#d9756d');
  rect(c, x + mug + 4, y - 2, 1, 2, '#c0504d');
  rect(c, x + mug + 1, y - 2, 2, 1, '#4a2a24');

  rect(c, x + 1, y - 5, 4, 3, '#8a5a33');
  rect(c, x + 1, y - 5, 4, 1, '#a06b3d');
  rect(c, x + 1, y - 7, 2, 3, '#3f8f5a');
  rect(c, x + 4, y - 8, 2, 4, '#54a86e');
  rect(c, x + 2, y - 9, 1, 3, '#6bc07d');

  rect(c, x + 2, y + 9, 3, 2, accent);
  rect(c, x + 25, y + 9, 6, 4, '#4a321c');
  rect(c, x + 25, y + 9, 6, 1, '#5b3f24');
  rect(c, x + 25, y + 11, 6, 1, '#3a2816');
  rect(c, x + 27, y + 11, 2, 1, '#8a6238');
  rect(c, x + 16, y - 3, 1, 1, '#2b3542');
  if (sel) {
    rect(c, x, y, 32, 1, '#3AA99F');
    rect(c, x, y, 1, 8, '#3AA99F');
    rect(c, x + 31, y, 1, 8, '#3AA99F');
  }
}

interface Seat { tx: number; ty: number; deskRow: number; deskTy: number; }

function computeSeats(count: number): Seat[] {
  const perRow = Math.min(5, Math.max(1, Math.ceil(count / 2)));
  const gap = (WORK.w / TILE - 5) / perRow;
  const seats: Seat[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % perRow;
    const row = Math.floor(i / perRow) % 2;
    const tx = Math.round(2 + gap * col + gap / 2);
    seats.push({ tx, ty: row === 0 ? 3 : 7, deskRow: row, deskTy: row === 0 ? 4 : 8 });
  }
  return seats;
}

interface Pt { x: number; y: number; }
interface Sim {
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: number;
  dir: Dir;
  flip: boolean;
  path: Pt[];
  wait: number;
  dest: 'seat' | 'poi';
  tagW: number;
  bubbleText: string;
  bubbleUntil: number;
  bubbleNext: number;
  blinkUntil: number;
  blinkNext: number;
}

const BUBBLES = [
  'PR #42 review',
  'deploying...',
  'build green ✓',
  'standup 10:00',
  'fixing bug',
  'coffee break',
  'tests passing',
  'merging',
  'refactoring',
  'on call',
  'ship it!',
  'brainstorming',
  'docs update',
  '1:1 meeting',
  'need review',
];

const ROLE_BUBBLES: Record<RoleKind, string[]> = {
  dev: ['PR #42 review', 'fixing bug', 'build green ✓', 'merging', 'refactoring', 'ship it!'],
  design: ['pixel perfect', 'tweaking spacing', 'new mockups', 'color pass', 'handoff ready'],
  qa: ['tests passing', 'repro found', 'flaky test?', 'QA sweep', 'regression check'],
  ops: ['deploying...', 'cluster healthy', 'pipeline green', 'on call', 'rollback?'],
  data: ['accuracy +2%', 'cleaning data', 'eval run', 'model updated', 'token budget'],
  lead: ['standup 10:00', '1:1 meeting', 'sync soon', 'roadmap review', 'need review'],
};

export function PixelOffice({ agents, selected, onSelect }: Props) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layoutRef = useRef<{ id: string; x: number; y: number }[]>([]);
  const rafRef = useRef(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const stateRef = useRef<Map<string, Sim>>(new Map());
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const [tick, setTick] = useState(0);
  const [gliding, setGliding] = useState(false);
  const [zone, setZone] = useState('work');
  const glideTimer = useRef<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = W * S;
    canvas.height = H * S;
    ctx.imageSmoothingEnabled = false;

    const seats = computeSeats(agents.length);
    const laneY = 6 * TILE;
    const pois: Pt[] = [
      { x: 376, y: 6 * TILE + 2 },
      { x: 360, y: 6 * TILE + 2 },
      { x: 8 * TILE + 10, y: 11 * TILE },
      { x: 150, y: 6 * TILE },
      { x: 3 * TILE, y: 6 * TILE },
      { x: 19 * TILE, y: 6 * TILE },
    ];

    const bg = document.createElement('canvas');
    bg.width = W * S;
    bg.height = H * S;
    const bc = bg.getContext('2d')!;
    bc.imageSmoothingEnabled = false;
    drawFloor(bc);
    drawRoomFloors(bc);
    drawRug(bc, 2 * TILE, 10 * TILE, 12 * TILE, 3 * TILE);
    drawLighting(bc);
    drawWalls(bc);
    drawWindowLight(bc);
    drawWindow(bc, WINDOW.x, WINDOW.y, WINDOW.w, WINDOW.h);
    drawWhiteboard(bc, 148, 6);
    drawClock(bc, CLOCK.x, CLOCK.y);
    drawShelf(bc, 222, 7);
    drawArt(bc, 262, 5, 0);
    drawArt(bc, 290, 5, 1);
    drawPoster(bc, 322, 8, '#3AA99F', '#7fd6cd');
    drawNeon(bc, 346, 6);
    drawArt(bc, 588, 8, 2);
    drawArt(bc, 618, 8, 0);
    drawDoor(bc);
    drawPartitions(bc);
    drawMeetingRoom(bc);
    drawServerRoom(bc);
    drawLoungeRoom(bc);
    drawServerRack(bc, RACK.x, RACK.y);
    drawPlant(bc, TILE + 4, 2 * TILE + 2);
    drawPlant(bc, 372, 2 * TILE + 2);
    drawPlant(bc, TILE + 4, (ROWS - 2) * TILE);
    drawPlant(bc, 368, 13 * TILE);
    drawLamp(bc, 2 * TILE + 2, 9 * TILE);
    drawCouch(bc, 2 * TILE, 12 * TILE, 44);
    drawCoffeeTable(bc, 8 * TILE, 12 * TILE + 4, 22);
    drawCooler(bc, 376, 5 * TILE);
    drawCoffee(bc, 358, 5 * TILE);
    drawPrinter(bc, 376, 11 * TILE);
    drawBin(bc, 4 * TILE, 9 * TILE);
    drawBin(bc, 18 * TILE, 9 * TILE);
    rect(bc, 3 * TILE + 6, 9 * TILE + 9, 5, 4, '#eef2f6');
    rect(bc, 3 * TILE + 7, 9 * TILE + 10, 3, 1, 'rgba(0,0,0,0.2)');
    rect(bc, 3 * TILE + 11, 9 * TILE + 7, 4, 5, '#e8eef2');
    rect(bc, 17 * TILE + 10, 9 * TILE + 8, 5, 4, '#eef2f6');
    rect(bc, 17 * TILE + 11, 9 * TILE + 9, 3, 1, 'rgba(0,0,0,0.2)');
    rect(bc, 19 * TILE + 2, 10 * TILE + 4, 4, 5, '#e8eef2');

    for (const seat of seats) {
      const cx = (seat.tx + 1) * TILE;
      const cy = (seat.ty + 1) * TILE - 2;
      rect(bc, cx - 6, cy - 14, 12, 9, '#333b4a');
      rect(bc, cx - 6, cy - 14, 12, 1, '#4a5870');
      rect(bc, cx - 5, cy - 12, 10, 1, '#3d4a5c');
      rect(bc, cx - 7, cy - 4, 14, 6, '#2b3240');
      rect(bc, cx - 7, cy - 4, 14, 1, '#46536a');
      rect(bc, cx - 6, cy - 3, 12, 4, '#3a4354');
      rect(bc, cx - 8, cy - 5, 2, 5, '#242a36');
      rect(bc, cx + 6, cy - 5, 2, 5, '#242a36');
      rect(bc, cx - 2, cy + 2, 4, 2, '#262c36');
      rect(bc, cx - 6, cy + 4, 12, 1, '#262c36');
      rect(bc, cx - 4, cy + 4, 2, 1, '#3a4351');
    }

    const grade = bc.createLinearGradient(0, 2 * TILE * S, 0, H * S);
    grade.addColorStop(0, 'rgba(255,222,170,0.05)');
    grade.addColorStop(0.45, 'rgba(0,0,0,0)');
    grade.addColorStop(1, 'rgba(8,12,20,0.18)');
    bc.fillStyle = grade;
    bc.fillRect(0, 0, W * S, H * S);

    const vignette = document.createElement('canvas');
    vignette.width = W * S;
    vignette.height = H * S;
    const vc = vignette.getContext('2d')!;
    const vg = vc.createRadialGradient((W * S) / 2, (H * S) / 2, 60 * S, (W * S) / 2, (H * S) / 2, Math.max(W, H) * S * 0.62);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.3)');
    vc.fillStyle = vg;
    vc.fillRect(0, 0, W * S, H * S);

    const measure = document.createElement('canvas').getContext('2d')!;
    measure.font = `bold ${3.2 * S}px "Segoe UI", monospace`;
    const bubMeasure = document.createElement('canvas').getContext('2d')!;
    bubMeasure.font = `bold ${2.9 * S}px "Segoe UI", monospace`;

    agents.forEach((a, i) => {
      if (!stateRef.current.has(a.id)) {
        const seat = seats[i];
        stateRef.current.set(a.id, {
          x: (seat.tx + 1) * TILE,
          y: (seat.ty + 1) * TILE - 2,
          vx: 0,
          vy: 0,
          phase: 0,
          dir: 'front',
          flip: false,
          path: [],
          wait: 2 + (hash(a.id) % 8),
          dest: 'seat',
          tagW: measure.measureText(a.name.slice(0, 14)).width,
          bubbleText: '',
          bubbleUntil: 0,
          bubbleNext: 2 + (hash(a.id) % 9),
          blinkUntil: 0,
          blinkNext: 1 + (hash(a.id) % 5),
        });
      }
    });
    for (const k of Array.from(stateRef.current.keys())) {
      if (!agents.some(a => a.id === k)) stateRef.current.delete(k);
    }

    const MAXV = 46;
    const ACCEL = 11;
    const SPEED_ANIM = 0.34;
    let last = performance.now();
    const start = last;

    const sat = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

    const draw = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      const time = (t - start) / 1000;

      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        const st = stateRef.current.get(a.id);
        const seat = seats[i];
        if (!st || !seat) continue;
        const sx = (seat.tx + 1) * TILE;
        const sy = (seat.ty + 1) * TILE - 2;

        if (st.path.length === 0 && st.wait <= 0) {
          if (st.dest === 'seat') {
            const poi = pois[Math.floor(Math.random() * pois.length)];
            st.path = [
              { x: st.x, y: laneY },
              { x: poi.x, y: laneY },
              { x: poi.x, y: poi.y },
            ];
            st.dest = 'poi';
          } else {
            st.path = [
              { x: st.x, y: laneY },
              { x: sx, y: laneY },
              { x: sx, y: sy },
            ];
            st.dest = 'seat';
          }
        }

        let dvx = 0;
        let dvy = 0;
        let movingTarget = false;

        if (st.path.length > 0) {
          const wp = st.path[0];
          const dx = wp.x - st.x;
          const dy = wp.y - st.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 3) {
            st.x = wp.x;
            st.y = wp.y;
            st.path.shift();
            if (st.path.length === 0) st.wait = st.dest === 'seat' ? 7 + Math.random() * 7 : 2 + Math.random() * 3;
          } else {
            const sp = Math.min(MAXV, dist * 5);
            dvx = (dx / dist) * sp;
            dvy = (dy / dist) * sp;
            movingTarget = true;
          }
        }

        for (let j = 0; j < agents.length; j++) {
          if (j === i) continue;
          const o = stateRef.current.get(agents[j].id)!;
          const ox = st.x - o.x;
          const oy = st.y - o.y;
          const d = Math.hypot(ox, oy);
          if (d > 0.01 && d < 20) {
            const push = (1 - d / 20) * 34;
            dvx += (ox / d) * push;
            dvy += (oy / d) * push;
          }
        }

        const k = Math.min(1, dt * (movingTarget ? ACCEL : 9));
        st.vx += (dvx - st.vx) * k;
        st.vy += (dvy - st.vy) * k;

        const speed = Math.hypot(st.vx, st.vy);
        const moving = speed > 5;
        if (moving) {
          st.x += st.vx * dt;
          st.y += st.vy * dt;
          st.phase += dt * (3 + speed * SPEED_ANIM);
          const ax = Math.abs(st.vx);
          const ay = Math.abs(st.vy);
          if (ax > ay * 1.15) {
            st.dir = 'side';
            st.flip = st.vx < 0;
          } else {
            st.dir = st.vy < 0 ? 'back' : 'front';
          }
        } else {
          st.vx = 0;
          st.vy = 0;
          if (st.path.length === 0) st.dir = 'front';
        }

        st.x = sat(st.x, TILE + 6, (COLS - 1) * TILE - 6);
        st.y = sat(st.y, 2 * TILE + 10, ROWS * TILE - 4);

        if (time > st.bubbleNext) {
          const pool = Math.random() < 0.75 ? ROLE_BUBBLES[roleFor(a.role)] : BUBBLES;
          st.bubbleText = pool[Math.floor(Math.random() * pool.length)];
          st.bubbleUntil = time + 3.2;
          st.bubbleNext = time + 9 + Math.random() * 10;
        }
        if (time > st.blinkNext) {
          st.blinkUntil = time + 0.14;
          st.blinkNext = time + 2.5 + Math.random() * 4;
        }
      }

      ctx.clearRect(0, 0, W * S, H * S);
      ctx.drawImage(bg, 0, 0);

      layoutRef.current = [];
      const tags: { id: string; x: number; y: number; name: string; w: number; acc: string; role: string; bubble: string }[] = [];

      const items: { y: number; draw: () => void }[] = [];
      agents.forEach((a, idx) => {
        const st = stateRef.current.get(a.id);
        if (!st) return;
        const speed = Math.hypot(st.vx, st.vy);
        const moving = speed > 5;
        const sitting = !moving && st.dest === 'seat' && st.wait > 0;
        const frame = frameFor(st.phase, moving);
        let spr: HTMLCanvasElement;
        try {
          spr = bakeSprite(a.id, st.dir, frame);
        } catch (err) {
          console.warn('[office] sprite bake skipped', a.id, err);
          return;
        }
        const bob = moving
          ? Math.sin(st.phase * 2) > 0 ? 0 : 1
          : sitting
            ? Math.sin(time * 7 + idx) > 0 ? 0 : 1
            : 0;
        const ox = Math.round(st.x * S - (SW * S) / 2);
        const oy = Math.round(st.y * S - SH * S + (sitting ? 8 : 0) * S) - bob * S;

        items.push({
          y: st.y,
          draw: () => {
            if (sitting) drawSeatChair(ctx, st.x, st.y, hash(a.id));
            shadow(ctx, st.x, st.y + 1, 8, 3, 0.26 + (moving ? 0.04 : 0));

            if (st.flip && st.dir === 'side') {
              ctx.save();
              ctx.translate(ox + SW * S, oy);
              ctx.scale(-1, 1);
              ctx.drawImage(spr, 0, 0, SW * S, SH * S);
              ctx.restore();
            } else {
              ctx.drawImage(spr, ox, oy, SW * S, SH * S);
            }
            if (time < st.blinkUntil && st.dir === 'front') {
              const pal = paletteFor(a.id);
              ctx.fillStyle = pal.s;
              ctx.fillRect(ox + 6 * S, oy + 9 * S, 2 * S, S);
              ctx.fillRect(ox + 10 * S, oy + 9 * S, 2 * S, S);
              ctx.fillStyle = '#7a4a33';
              ctx.fillRect(ox + 6 * S, oy + 9 * S + S - 1, 2 * S, 1);
              ctx.fillRect(ox + 10 * S, oy + 9 * S + S - 1, 2 * S, 1);
            }

            if (selectedRef.current === a.id) {
              const pulse = 0.55 + 0.3 * (0.5 + 0.5 * Math.sin(time * 3.4));
              ctx.strokeStyle = `rgba(58,169,159,${pulse.toFixed(3)})`;
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.ellipse(st.x * S, (st.y + 1) * S, 10 * S, 3.5 * S, 0, 0, Math.PI * 2);
              ctx.stroke();
            }
          },
        });

        layoutRef.current.push({ id: a.id, x: st.x * S, y: st.y * S });
        tags.push({ id: a.id, x: st.x * S, y: oy, name: a.name, w: st.tagW, acc: SHIRTS[hash(a.id) % SHIRTS.length], role: a.role, bubble: time < st.bubbleUntil ? st.bubbleText : '' });
      });

      agents.forEach((a, i) => {
        const seat = seats[i];
        if (!seat) return;
        const dy = seat.deskTy * TILE;
        items.push({
          y: dy + 14,
          draw: () => {
            drawDesk(ctx, seat.tx * TILE, dy, selectedRef.current === a.id, hash(a.id), SHIRTS[hash(a.id) % SHIRTS.length], time);
          },
        });
      });

      items.sort((a, b) => a.y - b.y).forEach(it => it.draw());

      drawClockHands(ctx, new Date());
      drawRackLeds(ctx, time);
      drawAmbient(ctx, time);
      drawNeonGlow(ctx, time);

      ctx.drawImage(vignette, 0, 0);

      tags.forEach(tag => {
        const sel = selectedRef.current === tag.id;
        const pad = 2.6 * S;
        const bw = tag.w + pad * 2 + 7 * S;
        const bh = 6.4 * S;
        const bx = tag.x - bw / 2;
        const by = tag.y - bh - 2;
        ctx.fillStyle = sel ? 'rgba(58,169,159,0.97)' : 'rgba(14,17,22,0.86)';
        ctx.strokeStyle = sel ? '#5ad4c8' : 'rgba(255,255,255,0.14)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 1.9 * S);
        ctx.fill();
        ctx.stroke();
        const rk = roleFor(tag.role);
        const chip = 4.7 * S;
        const cx0 = bx + 1.15 * S;
        const cy0 = by + (bh - chip) / 2;
        ctx.fillStyle = ROLE_COLORS[rk];
        ctx.beginPath();
        ctx.roundRect(cx0, cy0, chip, chip, 1.1 * S);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.stroke();
        drawRoleGlyph(ctx, rk, cx0 + chip / 2, cy0 + chip / 2, chip * 0.33);
        ctx.fillStyle = sel ? '#ffffff' : '#e8edf4';
        ctx.font = `bold ${3.2 * S}px "Segoe UI", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(tag.name.slice(0, 14), tag.x + 2.6 * S, by + bh / 2 + 0.5);
      });

      tags.forEach(tag => {
        if (!tag.bubble) return;
        ctx.font = `bold ${2.9 * S}px "Segoe UI", monospace`;
        const tw = bubMeasure.measureText(tag.bubble).width;
        const bh = 9.4 * S;
        const bw = tw + 7 * S;
        const bx = Math.max(4, Math.min(W * S - bw - 4, tag.x - bw / 2));
        const bottom = tag.y - 2;
        const by = Math.max(4, bottom - bh - 8 * S);
        const tx = Math.max(bx + 3 * S, Math.min(bx + bw - 3 * S, tag.x));
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.beginPath();
        ctx.roundRect(bx + 2, by + 2, bw, bh, 2.4 * S);
        ctx.fill();
        ctx.fillStyle = '#f4efe4';
        ctx.strokeStyle = '#2b2f36';
        ctx.lineWidth = Math.max(1, 0.8 * S);
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 2.4 * S);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(tx - 2.6 * S, by + bh - 1);
        ctx.lineTo(tx + 2.6 * S, by + bh - 1);
        ctx.lineTo(tx, by + bh + 5 * S);
        ctx.closePath();
        ctx.fillStyle = '#f4efe4';
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#f4efe4';
        ctx.fillRect(tx - 2.4 * S, by + bh - 1.4, 4.8 * S, 2.2);
        ctx.fillStyle = '#2b2f36';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(tag.bubble, bx + bw / 2, by + bh / 2 + 0.5);
      });

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [agents]);

  const clampView = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

  const zoomAt = (factor: number, cx: number, cy: number) => {
    setView(v => {
      const nz = clampView(v.zoom * factor, 1, 5.5);
      return { zoom: nz, x: cx - (cx - v.x) * (nz / v.zoom), y: cy - (cy - v.y) * (nz / v.zoom) };
    });
  };

  const focusRoom = (room: { x: number; y: number; w: number; h: number }, id?: string) => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 80) return;
    const cw = W * S;
    const ch = H * S;
    const fit = Math.min(r.width / cw, r.height / ch);
    const offX = (r.width - cw * fit) / 2;
    const offY = (r.height - ch * fit) / 2;
    const zx = (0.88 * r.width) / (room.w * S * fit);
    const zy = (0.84 * r.height) / (room.h * S * fit);
    const z = clampView(Math.min(zx, zy), 1, 5.5);
    const cx = offX + (room.x + room.w / 2) * S * fit;
    const cy = offY + (room.y + room.h / 2) * S * fit;
    setView({ zoom: z, x: r.width / 2 - z * cx, y: r.height / 2 - z * cy });
    setGliding(true);
    if (glideTimer.current) window.clearTimeout(glideTimer.current);
    glideTimer.current = window.setTimeout(() => setGliding(false), 720);
    if (id) setZone(id);
    else setZone('');
  };

  useEffect(() => {
    let raf = 0;
    let tries = 0;
    const go = () => {
      const el = wrapRef.current;
      if (el && el.getBoundingClientRect().width > 40) {
        focusRoom(ZONE_VIEWS[0].room, 'work');
        return;
      }
      if (tries++ < 120) raf = requestAnimationFrame(go);
    };
    raf = requestAnimationFrame(go);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let last = el.getBoundingClientRect();
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (Math.abs(r.width - last.width) < 24 && Math.abs(r.height - last.height) < 24) return;
      last = r;
      const v = ZONE_VIEWS.find(z => z.id === zone);
      if (v) focusRoom(v.room, v.id);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [zone]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const pick = (clientX: number, clientY: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    const cw = W * S;
    const ch = H * S;
    const fit = Math.min(r.width / cw, r.height / ch);
    const offX = (r.width - cw * fit) / 2;
    const offY = (r.height - ch * fit) / 2;
    const px = (clientX - r.left - view.x) / view.zoom;
    const py = (clientY - r.top - view.y) / view.zoom;
    const ix = (px - offX) / fit;
    const iy = (py - offY) / fit;
    let best: { id: string; d: number } | null = null;
    for (const l of layoutRef.current) {
      const d = Math.hypot(l.x - ix, l.y - 19 * S - iy);
      if (d < 12 * S && (!best || d < best.d)) best = { id: l.id, d };
    }
    onSelect(best ? best.id : null);
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setGliding(false);
    setZone('');
    dragRef.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) > 4) {
      d.moved = true;
      setPanning(true);
    }
    if (d.moved) setView(v => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    setPanning(false);
    if (d && !d.moved) pick(e.clientX, e.clientY);
  };

  const selAgent = selected ? agents.find(a => a.id === selected) : null;
  const sim = selected ? stateRef.current.get(selected) : null;
  const status = !sim
    ? ''
    : sim.path.length > 0
      ? t('office.statusRoute')
      : sim.dest === 'seat'
        ? sim.wait > 0
          ? t('office.statusWorking')
          : t('office.statusSeated')
        : t('office.statusBreak');
  const accent = selAgent ? SHIRTS[hash(selAgent.id) % SHIRTS.length] : '#3AA99F';
  const initials = selAgent
    ? selAgent.name.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
    : '';

  return (
    <div ref={wrapRef} className="relative w-full h-full overflow-hidden bg-[#20242c]">
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => { dragRef.current = null; setPanning(false); }}
        className="w-full h-full block"
        style={{
          objectFit: 'contain',
          imageRendering: 'pixelated',
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
          transformOrigin: '0 0',
          transition: panning ? 'none' : gliding ? 'transform 640ms cubic-bezier(0.22,0.85,0.2,1)' : 'transform 140ms ease-out',
          cursor: panning ? 'grabbing' : 'grab',
          touchAction: 'none',
        }}
      />

      <div className="absolute top-2 left-2 flex items-center gap-1 rounded-md border border-[#34332F] bg-[#1C1B1A]/90 p-1 select-none">
        {ZONE_VIEWS.map(z => (
          <button
            key={z.id}
            type="button"
            onClick={() => focusRoom(z.room, z.id)}
            className={`px-2 h-6 rounded text-[10px] cursor-pointer ${zone === z.id ? 'bg-[#3AA99F] text-[#101413] font-semibold' : 'bg-[#34332F] text-[#CECDC3] hover:bg-[#3d3c37]'}`}
          >
            {t(z.labelKey)}
          </button>
        ))}
      </div>

      {selAgent && (
        <div
          className="absolute top-2 right-2 w-52 rounded-md border border-[#34332F] bg-[#1C1B1A]/95 shadow-lg p-2.5 text-[#CECDC3] select-none"
          data-tick={tick}
          onPointerDown={e => e.stopPropagation()}
          onPointerMove={e => e.stopPropagation()}
          onPointerUp={e => e.stopPropagation()}
          onWheel={e => e.stopPropagation()}
        >
          <div className="flex items-start gap-2">
            <div className="w-8 h-8 rounded flex items-center justify-center text-[11px] font-bold text-white shrink-0" style={{ background: accent }}>
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-semibold text-[#F2F0E5] truncate">{selAgent.name}</div>
              <div className="text-[10px] text-[#87857F] truncate">{selAgent.role}</div>
            </div>
            <button type="button" onClick={() => onSelect(null)} className="text-[#87857F] hover:text-[#F2F0E5] cursor-pointer leading-none text-[14px]">
              ×
            </button>
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: accent }} />
            <span className="text-[10px] text-[#CECDC3]">{status}</span>
          </div>
        </div>
      )}

      <div className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md border border-[#34332F] bg-[#1C1B1A]/90 p-1 select-none">
        <button type="button" onClick={() => zoomAt(1 / 1.25, (wrapRef.current?.clientWidth || 0) / 2, (wrapRef.current?.clientHeight || 0) / 2)} className="w-6 h-6 rounded text-[13px] leading-none bg-[#34332F] text-[#CECDC3] hover:bg-[#3d3c37] cursor-pointer">−</button>
        <button type="button" onClick={() => zoomAt(1.25, (wrapRef.current?.clientWidth || 0) / 2, (wrapRef.current?.clientHeight || 0) / 2)} className="w-6 h-6 rounded text-[13px] leading-none bg-[#34332F] text-[#CECDC3] hover:bg-[#3d3c37] cursor-pointer">+</button>
        <button type="button" onClick={() => { setView({ zoom: 1, x: 0, y: 0 }); setZone(''); setGliding(false); }} className="px-1.5 h-6 rounded text-[10px] bg-[#34332F] text-[#CECDC3] hover:bg-[#3d3c37] cursor-pointer">{t('office.zoneAll')}</button>
      </div>

      <div className="absolute bottom-2 left-2 text-[10px] text-[#87857F]/80 select-none pointer-events-none">
        {t('office.panHint')}
      </div>
    </div>
  );
}

