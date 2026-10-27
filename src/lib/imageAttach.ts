import { buildFacts, gridLuma, textureStats, type VisionFacts } from './vision';
import { analyzeOnDevice, lastVisionError } from './onDeviceVision';
import { t } from './i18n';

/** How much of an image to spend on: fewer tokens vs more detail. */
export type ImageMode = 'auto' | 'economy' | 'balanced' | 'high';

export interface ImageModeSpec {
  label: string;
  /** Fraction of the source's longest edge kept (detail ratio). */
  ratio: number;
  /** OpenAI-compatible `detail` hint. `low` is a flat ~85 tokens. */
  detail: 'low' | 'high';
  hint: string;
}

/** Concrete (non-auto) modes. `auto` is resolved per image from its measurements. */
export const IMAGE_MODES: Record<Exclude<ImageMode, 'auto'>, ImageModeSpec> = {
  economy:  { label: 'Economy',    ratio: 0.25, detail: 'low',  hint: '25% of source · fewest tokens' },
  balanced: { label: 'Balanced',   ratio: 0.5,  detail: 'high', hint: '50% of source · full detail' },
  high:     { label: 'Max detail', ratio: 1,    detail: 'high', hint: '100% of source · most tokens' },
};

export const AUTO_MODE_LABEL = 'Auto';
export const AUTO_MODE_HINT = 'Decides per image — only saves when it is safe';

export const IMAGE_MODE_ORDER: ImageMode[] = ['auto', 'economy', 'balanced', 'high'];

export function imageModeLabel(mode: ImageMode): string {
  return mode === 'auto' ? AUTO_MODE_LABEL : IMAGE_MODES[mode].label;
}

export function imageModeHint(mode: ImageMode): string {
  return mode === 'auto' ? AUTO_MODE_HINT : IMAGE_MODES[mode].hint;
}

export const DEFAULT_IMAGE_MODE: ImageMode = 'auto';

/** Bounds so a tiny source is never upscaled and a huge one stays reasonable. */
const MAX_SCALED_SIDE = 2048;
const MIN_SCALED_SIDE = 64;
/** Longest edge an image is rendered at for a given detail ratio. */
function targetSide(longestEdge: number, ratio: number): number {
  return Math.max(MIN_SCALED_SIDE, Math.min(MAX_SCALED_SIDE, Math.round(longestEdge * ratio)));
}

/** A single concrete option for an attached image: what it costs and what it keeps. */
export interface ModeOption {
  mode: Exclude<ImageMode, 'auto'>;
  label: string;
  /** Detail ratio: fraction of the source's longest edge kept. */
  ratio: number;
  tokens: number;
  /** Percentage of the image's fine detail (high-frequency energy) retained. */
  retention: number;
}

/** An image attached to the next message, with a local fallback summary. */
export interface AttachedImage {
  name: string;
  /** Downscaled data URL sent to the model as an image part. */
  url: string;
  /** On-device measurement summary, used when no model key is configured. */
  summary: string;
  detail: 'low' | 'high';
  width: number;
  height: number;
  /** Approximate vision-token cost of this image. */
  estTokens: number;
  /** Why this detail level was chosen (shown in the UI). */
  reason: string;
  /** Percentage of fine detail retained at the chosen settings. */
  retention: number;
  /** Which concrete option this attachment ended up using. */
  chosenMode: Exclude<ImageMode, 'auto'>;
  /** True when the image looks like text/UI/documents (fine detail matters). */
  textLike: boolean;
  /** On-device failure reason when the detector could not initialize. */
  visionDiag: string;
  /** Every concrete option for this image, so the user can compare and decide. */
  options: ModeOption[];
}

/**
 * Approximates the OpenAI vision-token accounting so the UI can show the cost
 * of an attachment. Other providers differ, but the ordering (and the `low`
 * flat cost) is representative enough to reason about savings.
 */
export function estimateVisionTokens(width: number, height: number, detail: 'low' | 'high'): number {
  if (detail === 'low') return 85;
  const capScale = Math.min(1, 2048 / Math.max(width, height));
  let w = width * capScale;
  let h = height * capScale;
  const shortScale = 768 / Math.min(w, h);
  w = Math.round(w * shortScale);
  h = Math.round(h * shortScale);
  const tiles = Math.max(1, Math.ceil(w / 512)) * Math.max(1, Math.ceil(h / 512));
  return 85 + 170 * tiles;
}

/** One-line, token-cheap summary of what was measured from an image. */
function factsSummary(f: VisionFacts): string {
  const colors = f.colors.slice(0, 5).map((c) => `${c.hex} ${c.pct}%`).join(', ');
  return [
    `${t('vis.s.light')} ${f.lightClass} (${f.bright}%)`,
    `${t('vis.s.edge')} ${f.edges.dominant}`,
    `${t('vis.s.texture')} ${f.tex.textureClass}`,
    colors ? `${t('vis.s.colors')} ${colors}` : '',
    f.subj
      ? `${t('vis.s.subject')} ${f.subj.shapeClass} (aspect ${f.subj.aspect}, fullness ${f.subj.extentPct}%, upright ${f.subj.upright})`
      : t('vis.s.noSubject'),
  ].filter(Boolean).join(' · ');
}

/** Decides, from on-device measurements only (free — no model call), which
 * concrete mode to use. Document/UI-like images keep full detail; a confident
 * photo drops to the cheap tier; anything ambiguous stays on full detail. */
function decideAutoMode(f: VisionFacts): Exclude<ImageMode, 'auto'> {
  return f.kind === 'document' || f.kind === 'ui' || f.textLikelihood >= 0.5
    ? 'balanced'
    : 'economy';
}

/** Decodes a File off the main thread when the browser supports it. */
async function decodeFile(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      // Guard against a hung decode: fall back to the Image path on timeout.
      return await Promise.race([
        createImageBitmap(file),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('decode timeout')), 4000)),
      ]);
    } catch {
      // Some formats (e.g. SVG) are unsupported by createImageBitmap.
    }
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = objectUrl;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function drawTo(
  source: CanvasImageSource,
  width: number,
  height: number,
  srcRect?: { sx: number; sy: number; sw: number; sh: number }
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx) {
    if (srcRect) {
      ctx.drawImage(source, srcRect.sx, srcRect.sy, srcRect.sw, srcRect.sh, 0, 0, width, height);
    } else {
      ctx.drawImage(source, 0, 0, width, height);
    }
  }
  return canvas;
}

/**
 * Prepares an image for the vision pipeline with one decode and one bulk
 * pixel read:
 * 1. decode the file (off-thread when available),
 * 2. draw it once into a base canvas (bounded to 2048),
 * 3. derive measurements, the probe grid and every mode copy from that base.
 */
export async function prepareImageFile(file: File, mode: ImageMode = DEFAULT_IMAGE_MODE): Promise<AttachedImage> {
  const t0 = performance.now();
  const mark = (stage: string) => {
    (window as unknown as { __prepTiming?: Record<string, number> }).__prepTiming = {
      ...(window as unknown as { __prepTiming?: Record<string, number> }).__prepTiming,
      [stage]: Math.round(performance.now() - t0),
    };
  };
  const source = await decodeFile(file);
  mark('decode');
  const srcW = 'width' in source ? source.width : 0;
  const srcH = 'height' in source ? source.height : 0;
  const longest = Math.max(srcW, srcH);

  // Base copy — everything else derives from this one draw.
  const baseScale = Math.min(1, MAX_SCALED_SIDE / longest);
  const baseW = Math.max(1, Math.round(srcW * baseScale));
  const baseH = Math.max(1, Math.round(srcH * baseScale));
  const base = drawTo(source as CanvasImageSource, baseW, baseH);
  mark('base');

  // Facts on a small copy (drives the summary and the auto decision).
  const measure = drawTo(base, 320, Math.max(1, Math.round((320 * baseH) / baseW)));
  const mCtx = measure.getContext('2d', { willReadFrequently: true })!;
  const facts = buildFacts(mCtx.getImageData(0, 0, measure.width, measure.height).data, measure.width, measure.height, null);
  const summary = `${factsSummary(facts)} · image: ${srcW}×${srcH}`;
  mark('facts');

  // Probe stack: reference + the three concrete modes stacked vertically, so a
  // single getImageData serves all detail-energy measurements.
  const PROBE_W = 1024;
  const probeH = Math.max(8, Math.round((PROBE_W * baseH) / baseW));
  const probeKeys: Exclude<ImageMode, 'auto'>[] = ['economy', 'balanced', 'high'];
  const stackH = probeH * (probeKeys.length + 1);
  const stack = document.createElement('canvas');
  stack.width = PROBE_W;
  stack.height = stackH;
  const sctx = stack.getContext('2d', { willReadFrequently: true })!;
  sctx.fillStyle = '#000';
  sctx.fillRect(0, 0, PROBE_W, stackH);
  sctx.drawImage(base, 0, 0, PROBE_W, probeH); // row 0: reference (source detail)
  probeKeys.forEach((m, i) => {
    const spec = IMAGE_MODES[m];
    const side = targetSide(longest, spec.ratio);
    const scale = side / longest;
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    sctx.drawImage(base, 0, 0, w, h, 0, (i + 1) * probeH, PROBE_W, probeH);
  });
  const probeData = sctx.getImageData(0, 0, PROBE_W, stackH).data;

  const energies: number[] = [];
  for (let i = 0; i <= probeKeys.length; i++) {
    const offset = i * probeH * PROBE_W * 4;
    const luma = gridLuma(probeData.subarray(offset, offset + probeH * PROBE_W * 4), PROBE_W, probeH, 84, 34);
    energies.push(textureStats(luma, 84, 34).microContrast);
  }
  const refEnergy = energies[0];
  mark('probes');

  // On-device (MediaPipe) analysis: also free and local. A real classifier
  // beats thresholds, so when available it overrides the heuristic.
  const od = await analyzeOnDevice(drawTo(base, 640, Math.max(1, Math.round((640 * baseH) / baseW))));
  mark('ondevice');

  let chosenMode: Exclude<ImageMode, 'auto'> = mode === 'auto'
    ? (facts ? decideAutoMode(facts) : 'balanced')
    : mode;
  let reason = mode === 'auto'
    ? (chosenMode === 'economy'
      ? 'auto · photographic — low detail keeps the scene'
      : 'auto · text/UI or fine detail — kept at full detail')
    : IMAGE_MODES[chosenMode].hint;

  if (mode === 'auto' && od) {
    if (od.isPhoto) {
      chosenMode = 'economy';
      reason = `on-device: ${od.boxes[0]?.label ?? 'objects'} detected — low detail keeps the scene`;
    } else {
      reason += ' · on-device found no objects, heuristic used';
    }
    } else if (mode === 'auto' && !od) {
      reason += ' · on-device unavailable, heuristic used';
    }
    const visionDiag = od ? '' : lastVisionError().slice(0, 120);

  const spec = IMAGE_MODES[chosenMode];
  const chosenSide = targetSide(longest, spec.ratio);
  const chosenScale = chosenSide / longest;
  const chosenW = Math.max(1, Math.round(srcW * chosenScale));
  const chosenH = Math.max(1, Math.round(srcH * chosenScale));
  const chosenIndex = probeKeys.indexOf(chosenMode);

  const options: ModeOption[] = probeKeys.map((m, i) => {
    const ms = IMAGE_MODES[m];
    const side = targetSide(longest, ms.ratio);
    const scale = side / longest;
    return {
      mode: m,
      label: ms.label,
      ratio: ms.ratio,
      tokens: estimateVisionTokens(Math.round(srcW * scale), Math.round(srcH * scale), ms.detail),
      retention: refEnergy <= 0.001
        ? 100
        : Math.max(0, Math.min(100, Math.round((energies[i + 1] / refEnergy) * 100))),
    };
  });
  const chosenOption = options[chosenIndex] ?? options[0];
  const chosenCanvas = drawTo(base, chosenW, chosenH);
  mark('done');

  return {
    name: file.name,
    url: chosenCanvas.toDataURL('image/jpeg', 0.82),
    summary,
    detail: spec.detail,
    width: chosenW,
    height: chosenH,
    estTokens: chosenOption.tokens,
    retention: chosenOption.retention,
      chosenMode,
      textLike: facts.kind === 'document' || facts.kind === 'ui' || facts.textLikelihood >= 0.5,
      visionDiag,
      reason,
      options,
  };
}
