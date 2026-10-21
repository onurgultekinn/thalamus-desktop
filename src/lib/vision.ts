// src/lib/vision.ts — model-less static image analysis.
//
// ImageData in, measured statistics out (light, colors, edges, texture,
// multi-scale detail, text/photo likelihood). Used by the image-attachment
// flow to pick a detail tier and by the self-test harness.
//
// The live-camera extras (scene memory, motion tracking, interpretation
// prompt) were moved to the separate camera project:
// thalamus_camera_ai/legacy/vision.ts.

import { t, type TranslationKey } from './i18n';

// --- Multi-scale static analysis -------------------------------------------
// Shared core for image attachments and static frames. Pure functions on raw
// RGBA pixels — runs entirely on-device.

export interface BandEnergies {
  /** Mean neighbour-difference energy on the finest grid (text strokes, edges). */
  fine: number;
  medium: number;
  coarse: number;
  /** fine/coarse ratio — clearly above 1 means fine structure dominates. */
  ratio: number;
}

export interface LineStructure {
  /** Grid rows containing at least one horizontal edge run. */
  rowsWithRuns: number;
  /** Total horizontal edge runs across all rows. */
  runCount: number;
  /** Longest horizontal run of edge cells, as a fraction of grid width. */
  longestRunRatio: number;
  /** Fraction of grid cells that are strong-gradient edge cells. */
  coverage: number;
}

export interface SaliencyBox {
  /** Relative coordinates (0-1) of the most salient region. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Mean normalized saliency inside the box (0-1). */
  strength: number;
}

export interface StaticVision {
  bright: number;
  lightClass: string;
  colors: { hex: string; pct: number }[];
  edges: EdgeOrientation;
  tex: TextureStat;
  bands: BandEnergies;
  lines: LineStructure;
  saliency: SaliencyBox | null;
  textLikelihood: number;
  photoLikelihood: number;
  kind: 'photo' | 'document' | 'ui' | 'unknown';
  kindConfidence: number;
}

/** Area-averaged luma grid (no aliasing — used for scale-aware measurements). */
export function gridLumaAvg(data: Uint8ClampedArray, w: number, h: number, cols: number, rows: number): Float32Array {
  const out = new Float32Array(cols * rows);
  const cw = w / cols;
  const ch = h / rows;
  for (let ry = 0; ry < rows; ry++) {
    const y0 = Math.floor(ry * ch);
    const y1 = Math.min(h, Math.ceil((ry + 1) * ch));
    for (let rx = 0; rx < cols; rx++) {
      const x0 = Math.floor(rx * cw);
      const x1 = Math.min(w, Math.ceil((rx + 1) * cw));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * w + x) * 4;
          sum += lum(data[o], data[o + 1], data[o + 2]);
          count++;
        }
      }
      out[ry * cols + rx] = count ? sum / count : 0;
    }
  }
  return out;
}

/** Halves a luma grid (2×2 area average) — one pyramid level down. */
function downsample2x(luma: Float32Array, cols: number, rows: number): { grid: Float32Array; cols: number; rows: number } {
  const c = Math.max(1, cols >> 1);
  const r = Math.max(1, rows >> 1);
  const out = new Float32Array(c * r);
  for (let y = 0; y < r; y++) {
    for (let x = 0; x < c; x++) {
      const x0 = x * 2;
      const x1 = Math.min(cols - 1, x * 2 + 1);
      const y0 = y * 2;
      const y1 = Math.min(rows - 1, y * 2 + 1);
      const sum = luma[y0 * cols + x0] + luma[y0 * cols + x1] + luma[y1 * cols + x0] + luma[y1 * cols + x1];
      out[y * c + x] = sum / 4;
    }
  }
  return { grid: out, cols: c, rows: r };
}

/**
 * Multi-scale detail energies: mean neighbour-difference (RMS micro-contrast)
 * at three pyramid levels. Natural scenes keep similar energy across scales;
 * text/UI/documents concentrate energy in the fine band over a flat coarse
 * band — the profile is what discriminates them.
 */
export function bandEnergies(data: Uint8ClampedArray, w: number, h: number): BandEnergies {
  const cols1 = Math.max(32, Math.min(128, Math.round(w / 2.5)));
  const rows1 = Math.max(8, Math.round((cols1 * h) / w));
  const g1 = gridLumaAvg(data, w, h, cols1, rows1);
  const l2 = downsample2x(g1, cols1, rows1);
  const l3 = downsample2x(l2.grid, l2.cols, l2.rows);
  const fine = textureStats(g1, cols1, rows1).microContrast;
  const medium = textureStats(l2.grid, l2.cols, l2.rows).microContrast;
  const coarse = textureStats(l3.grid, l3.cols, l3.rows).microContrast;
  const ratio = coarse > 0.004 ? Math.min(4, fine / coarse) : 0;
  return { fine, medium, coarse, ratio };
}

/**
 * Horizontal run-length structure of strong-gradient cells on the fine grid.
 * Text lines and UI elements produce many short axis-aligned runs spread over
 * many rows; photos produce scattered or single long runs.
 */
export function textRowStructure(luma: Float32Array, cols: number, rows: number, thr = 0.12): LineStructure {
  let rowsWithRuns = 0;
  let runCount = 0;
  let maxRun = 0;
  let edgeCells = 0;
  for (let y = 0; y < rows; y++) {
    let run = 0;
    let rowRuns = 0;
    for (let x = 0; x < cols; x++) {
      const c = luma[y * cols + x];
      const dx = x + 1 < cols ? luma[y * cols + x + 1] - c : 0;
      const dy = y + 1 < rows ? luma[(y + 1) * cols + x] - c : 0;
      const strong = Math.sqrt(dx * dx + dy * dy) >= thr;
      if (strong) {
        run++;
        edgeCells++;
      } else {
        if (run >= 2) { runCount++; rowRuns++; if (run > maxRun) maxRun = run; }
        run = 0;
      }
    }
    if (run >= 2) { runCount++; rowRuns++; if (run > maxRun) maxRun = run; }
    if (rowRuns > 0) rowsWithRuns++;
  }
  return {
    rowsWithRuns,
    runCount,
    longestRunRatio: maxRun / cols,
    coverage: edgeCells / (cols * rows),
  };
}

/**
 * Static saliency: per-cell contrast to its neighbourhood + deviation from the
 * frame's mean luma, on a mid-resolution grid. Returns the bounding box of the
 * most salient cells (relative 0-1) — a coarse ROI without motion.
 */
export function staticSaliency(luma: Float32Array, cols: number, rows: number): SaliencyBox | null {
  let mean = 0;
  for (let i = 0; i < luma.length; i++) mean += luma[i];
  mean /= Math.max(1, luma.length);

  const sal = new Float32Array(cols * rows);
  let max = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const c = luma[y * cols + x];
      const r = x + 1 < cols ? luma[y * cols + x + 1] : c;
      const d = y + 1 < rows ? luma[(y + 1) * cols + x] : c;
      const l = x > 0 ? luma[y * cols + x - 1] : c;
      const u = y > 0 ? luma[(y - 1) * cols + x] : c;
      const local = (Math.abs(r - c) + Math.abs(d - c) + Math.abs(l - c) + Math.abs(u - c)) / 4;
      const v = Math.min(1, (local / 0.25) * 0.7 + (Math.abs(c - mean) / 0.5) * 0.3);
      sal[y * cols + x] = v;
      if (v > max) max = v;
    }
  }
  if (max <= 0.001) return null;

  // Bounding box of cells at ≥65% of peak saliency (min 18% of each axis).
  let minX = cols, minY = rows, maxX = -1, maxY = -1;
  const cut = max * 0.65;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (sal[y * cols + x] >= cut) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;

  const colsW = Math.max(1, cols);
  const rowsH = Math.max(1, rows);
  let bx = minX / colsW;
  let by = minY / rowsH;
  let bw = (maxX + 1 - minX) / colsW;
  let bh = (maxY + 1 - minY) / rowsH;
  if (bw < 0.18) { const grow = (0.18 - bw) / 2; bx = Math.max(0, bx - grow); bw = Math.min(1, bw + grow * 2); }
  if (bh < 0.18) { const grow = (0.18 - bh) / 2; by = Math.max(0, by - grow); bh = Math.min(1, bh + grow * 2); }

  let sum = 0;
  let n = 0;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) { sum += sal[y * cols + x]; n++; }
  return { x: bx, y: by, w: bw, h: bh, strength: sum / n };
}

/**
 * Full static analysis of one image/frame: measurements, multi-scale band
 * profile, line structure, saliency and the text/photo classification.
 */
export function analyzeStaticImage(data: Uint8ClampedArray, w: number, h: number): StaticVision {
  let sumL = 0;
  const n = Math.max(1, w * h);
  for (let i = 0; i < n; i++) sumL += lum(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  const bright = Math.round((sumL / n) * 100);
  const lightClass = bright < 10 ? t('vis.light.veryDark') : bright < 26 ? t('vis.light.dim') : bright < 55 ? t('vis.light.normal') : bright < 80 ? t('vis.light.bright') : t('vis.light.veryBright');

  const colors = colorHistogram(data, w, h);
  const cols = 84, rows = 34;
  const luma = gridLuma(data, w, h, cols, rows);
  const edges = edgeOrientation(luma, cols, rows);
  const tex = textureStats(luma, cols, rows);
  const bands = bandEnergies(data, w, h);
  const fineCols = Math.max(16, Math.min(160, Math.round(w / 2.5)));
  const fineRows = Math.max(6, Math.round((fineCols * h) / w));
  const fineGrid = gridLumaAvg(data, w, h, fineCols, fineRows);
  const lines = textRowStructure(fineGrid, fineCols, fineRows);
  const saliency = staticSaliency(luma, cols, rows);

  const topShare = colors[0]?.pct ?? 0;
  const flatCoarse = bands.coarse < 0.05;
  const fineRich = bands.fine >= 0.15;
  const brightBg = bright >= 55 && topShare >= 45;
  const noDominantBg = topShare < 45;
  const coarsePresent = bands.coarse >= 0.03;
  const structured = lines.rowsWithRuns / Math.max(1, rows) >= 0.45 && lines.longestRunRatio <= 0.65;

  let text = 0;
  if (fineRich) text += 0.3;
  if (bands.ratio >= 1.4) text += 0.2;
  if (brightBg) text += 0.2;
  if (flatCoarse && fineRich) text += 0.15;
  if (structured) text += 0.15;
  const textLikelihood = Math.min(1, text);

  let photo = 0;
  if (noDominantBg) photo += 0.35;
  if (coarsePresent) photo += 0.25;
  if (bands.medium >= 0.06) photo += 0.2;
  if (bands.ratio <= 1.3) photo += 0.2;
  const photoLikelihood = Math.min(1, photo);

  let kind: StaticVision['kind'] = 'unknown';
  let kindConfidence = Math.max(textLikelihood, photoLikelihood);
  if (textLikelihood >= 0.45 && textLikelihood >= photoLikelihood) {
    kind = structured && !brightBg ? 'ui' : 'document';
    kindConfidence = textLikelihood;
  } else if (photoLikelihood >= 0.45 && photoLikelihood > textLikelihood) {
    kind = 'photo';
    kindConfidence = photoLikelihood;
  }

  return { bright, lightClass, colors, edges, tex, bands, lines, saliency, textLikelihood, photoLikelihood, kind, kindConfidence };
}

export interface EdgeOrientation {
  horizontal: number;
  vertical: number;
  diagonal: number;
  dominant: string;
}

export interface TextureStat {
  microContrast: number;
  textureClass: string;
}

export interface SubjectInfo {
  box: string;
  aspect: number;
  extentPct: number;
  upright: boolean;
  shapeClass: string;
  motionPct: number;
}

export interface VisionFacts {
  bright: number;
  lightClass: string;
  colors: { hex: string; pct: number }[];
  edges: EdgeOrientation;
  tex: TextureStat;
  subj: SubjectInfo | null;
  motion: number | null;
  gridWidth: number;
  gridHeight: number;
  /** Multi-scale detail energies (fine → coarse). */
  bands: BandEnergies;
  /** Horizontal run structure of the fine grid — text/UI produce aligned runs. */
  lines: LineStructure;
  /** Static saliency region (relative 0-1); null when no clear region. */
  staticRoi: SaliencyBox | null;
  /** Heuristic likelihood (0-1) that the image is text/UI/document-like. */
  textLikelihood: number;
  /** Heuristic likelihood (0-1) that the image is a natural photo. */
  photoLikelihood: number;
  /** Coarse category with confidence. */
  kind: 'photo' | 'document' | 'ui' | 'unknown';
  kindConfidence: number;
}

const lum = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** Input pixels (ImageData.data, RGBA) → cols×rows luma grid. */
export function gridLuma(data: Uint8ClampedArray, w: number, h: number, cols: number, rows: number): Float32Array {
  const out = new Float32Array(cols * rows);
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const px = Math.min(w - 1, Math.floor(((rx + 0.5) / cols) * w));
      const py = Math.min(h - 1, Math.floor(((ry + 0.5) / rows) * h));
      const o = (py * w + px) * 4;
      const a = data[o + 3];
      out[ry * cols + rx] = a < 8 ? 0 : lum(data[o], data[o + 1], data[o + 2]);
    }
  }
  return out;
}

function centerCropLuma(raw: Float32Array, cols: number, rows: number): Float32Array {
  const target = cols * rows;
  const step = Math.max(1, Math.floor(raw.length / target));
  const out = new Float32Array(target);
  for (let i = 0; i < target; i++) out[i] = raw[Math.min(raw.length - 1, i * step)];
  return out;
}

/** Color quantization histogram: 4-bit/RGB (every 2nd pixel is sampled — cheap) → the 4 most visible colors. */
export function colorHistogram(data: Uint8ClampedArray, w: number, h: number): { hex: string; pct: number }[] {
  const bins = new Map<number, number>();
  const n = w * h;
  const sampled = Math.ceil(n / 2);
  for (let i = 0; i < n; i += 2) {
    const o = i * 4;
    const key = ((data[o] >> 4) << 8) | ((data[o + 1] >> 4) << 4) | (data[o + 2] >> 4);
    bins.set(key, (bins.get(key) || 0) + 1);
  }
  return [...bins.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([key, cnt]) => {
      const r = ((key >> 8) & 15) * 17;
      const g = ((key >> 4) & 15) * 17;
      const b = (key & 15) * 17;
      const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
      return { hex, pct: Math.round((cnt / sampled) * 100) };
    });
}

/** Edge orientation — the direction of texture/object lines. */
export function edgeOrientation(luma: Float32Array, cols: number, rows: number): EdgeOrientation {
  let hor = 0, ver = 0, dia = 0, total = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const c = luma[y * cols + x];
      const dx = x + 1 < cols ? luma[y * cols + x + 1] - c : 0;
      const dy = y + 1 < rows ? luma[(y + 1) * cols + x] - c : 0;
      if (Math.sqrt(dx * dx + dy * dy) < 0.12) continue;
      total++;
      if (Math.abs(dx) > 2 * Math.abs(dy)) ver++;
      else if (Math.abs(dy) > 2 * Math.abs(dx)) hor++;
      else dia++;
    }
  }
  const pct = (k: number) => (total ? Math.round((k / total) * 100) : 0);
  const entries = { horizontal: pct(hor), vertical: pct(ver), diagonal: pct(dia) };
  const dominant = total === 0 ? t('vis.edge.uncertain') : t((`vis.edge.${Object.entries(entries).sort((a, b) => b[1] - a[1])[0][0]}`) as TranslationKey);
  return { horizontal: entries.horizontal, vertical: entries.vertical, diagonal: entries.diagonal, dominant };
}

/** Texture roughness (feather/fur/leaf...) — RMS of neighboring luma differences. */
export function textureStats(luma: Float32Array, cols: number, rows: number): TextureStat {
  let sum = 0, cnt = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const L = luma[y * cols + x];
      const dx = x + 1 < cols ? luma[y * cols + x + 1] - L : 0;
      const dy = y + 1 < rows ? luma[(y + 1) * cols + x] - L : 0;
      sum += dx * dx + dy * dy;
      cnt++;
    }
  }
  const rms = Math.sqrt(sum / Math.max(1, cnt));
  return {
    microContrast: Math.round(rms * 1000) / 1000,
    textureClass: rms < 0.04 ? t('vis.tex.flat') : rms < 0.12 ? t('vis.tex.medium') : t('vis.tex.pronounced'),
  };
}

/** Motion between two grids: changed percentage + location box. */
export function motionDelta(prev: Float32Array, cur: Float32Array, thr = 0.12, gridW = 84): { pct: number | null; boxCells: { x: number; y: number; w: number; h: number } | null } {
  if (!prev || !cur || prev.length !== cur.length) return { pct: null, boxCells: null };
  const n = prev.length;
  const changed: number[] = [];
  for (let i = 0; i < n; i++) if (Math.abs(prev[i] - cur[i]) > thr) changed.push(i);
  if (!changed.length) return { pct: 0, boxCells: null };
  const xs = changed.map((i) => i % gridW);
  const ys = changed.map((i) => Math.floor(i / gridW));
  return {
    pct: Math.round((changed.length / n) * 1000) / 10,
    boxCells: {
      x: Math.min(...xs), y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs) + 1,
      h: Math.max(...ys) - Math.min(...ys) + 1,
    },
  };
}

/** The shape of the dark silhouette inside the region-of-interest box. */
export function subjectShape(luma: Float32Array, cols: number, rows: number, box: { x: number; y: number; w: number; h: number }): Omit<SubjectInfo, 'box' | 'motionPct'> | null {
  const x0 = Math.max(0, box.x), y0 = Math.max(0, box.y);
  const x1 = Math.min(cols, box.x + box.w), y1 = Math.min(rows, box.y + box.h);
  if (x1 <= x0 || y1 <= y0) return null;
  const area = (x1 - x0) * (y1 - y0);
  let mu = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mu += luma[y * cols + x];
  mu /= area;
  let mask = 0, mxx = -1, mnx = 1e9, mxy = -1, mny = 1e9;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (luma[y * cols + x] < mu - 0.06) {
        mask++;
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (y < mny) mny = y; if (y > mxy) mxy = y;
      }
    }
  }
  if (!mask) return null;
  const shW = Math.max(1, mxx - mnx + 1);
  const shH = Math.max(1, mxy - mny + 1);
  return {
    aspect: Math.round((shW / shH) * 100) / 100,
    extentPct: Math.round((mask / area) * 1000) / 10,
    upright: shH > shW,
    shapeClass: shH > shW * 1.6 ? t('vis.shape.tall') : shW > shH * 1.6 ? t('vis.shape.wide') : t('vis.shape.compact'),
  };
}

/** Single frame(s) → measured facts (pass prevLuma for motion). */
export function buildFacts(data: Uint8ClampedArray, w: number, h: number, prevLuma: Float32Array | null): VisionFacts {
  const cols = 84, rows = 34;
  const luma = gridLuma(data, w, h, cols, rows);

  const motion = prevLuma ? motionDelta(centerCropLuma(prevLuma, cols, rows), luma, 0.12, cols) : { pct: null, boxCells: null };

  let subj: SubjectInfo | null = null;
  if (motion.boxCells) {
    const shape = subjectShape(luma, cols, rows, motion.boxCells);
    if (shape) {
      subj = {
        ...shape,
        box: `${motion.boxCells.x},${motion.boxCells.y} ${motion.boxCells.w}x${motion.boxCells.h}`,
        motionPct: motion.pct ?? 0,
      };
    }
  }

  const st = analyzeStaticImage(data, w, h);

  return {
    bright: st.bright,
    lightClass: st.lightClass,
    colors: st.colors,
    edges: st.edges,
    tex: st.tex,
    bands: st.bands,
    lines: st.lines,
    staticRoi: st.saliency,
    textLikelihood: st.textLikelihood,
    photoLikelihood: st.photoLikelihood,
    kind: st.kind,
    kindConfidence: st.kindConfidence,
    subj,
    motion: motion.pct,
    gridWidth: cols,
    gridHeight: rows,
  };
}
