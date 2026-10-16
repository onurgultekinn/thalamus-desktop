/**
 * Synthetic self-test for the static vision analyzer.
 *
 * Draws reference images (document, UI, photo, flat), runs
 * `analyzeStaticImage` on them and compares the decided kind against the
 * expected one. This is the measurement harness for tuning the analyzer's
 * thresholds without a real labeled corpus — run it in any console:
 *
 *   const m = await import('/src/lib/visionSelfTest.ts');
 *   console.table(m.visionSelfTest());
 */

import { analyzeStaticImage } from './vision';

export interface VisionSelfTestRow {
  name: string;
  expected: string;
  got: string;
  confidence: number;
  ok: boolean;
}

type Kind = 'photo' | 'document' | 'ui' | 'unknown';

function draw(name: string, W = 480, H = 320): { canvas: HTMLCanvasElement; expected: Kind } {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  let expected: Kind = 'unknown';

  if (name === 'document') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#111111';
    for (let y = 24; y < H - 24; y += 22) {
      let x = 32;
      while (x < W - 32) {
        const w = 8 + Math.random() * 90;
        ctx.fillRect(x, y, w, 9);
        x += w + 10 + Math.random() * 16;
      }
    }
    expected = 'document';
  } else if (name === 'ui') {
    ctx.fillStyle = '#4a5568';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#2d3748';
    for (let i = 0; i < 3; i++) ctx.fillRect(24, 24 + i * 88, W - 48, 64);
    ctx.fillStyle = '#3AA99F';
    for (let i = 0; i < 3; i++) ctx.fillRect(40, 40 + i * 88, 120, 32);
    expected = 'ui';
  } else if (name === 'gradient') {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#2b6cb0');
    g.addColorStop(0.5, '#7fb069');
    g.addColorStop(1, '#c05621');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 50; i++) {
      ctx.fillStyle = `rgba(${Math.random() * 255 | 0},${Math.random() * 255 | 0},${Math.random() * 255 | 0},0.12)`;
      ctx.beginPath();
      ctx.arc(Math.random() * W, Math.random() * H, 30 + Math.random() * 90, 0, 7);
      ctx.fill();
    }
    expected = 'photo';
  } else if (name === 'photo') {
    ctx.fillStyle = '#2d3a2f';
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 150; i++) {
      ctx.fillStyle = `rgba(${50 + Math.random() * 140 | 0},${60 + Math.random() * 130 | 0},${40 + Math.random() * 100 | 0},0.55)`;
      ctx.beginPath();
      ctx.arc(Math.random() * W, Math.random() * H, 8 + Math.random() * 40, 0, 7);
      ctx.fill();
    }
    expected = 'photo';
  } else {
    ctx.fillStyle = '#404040';
    ctx.fillRect(0, 0, W, H);
    expected = 'unknown';
  }

  return { canvas, expected };
}

/** Runs all synthetic cases. Rows with ok:false are the tuning backlog. */
export function visionSelfTest(): VisionSelfTestRow[] {
  const rows: VisionSelfTestRow[] = [];
  for (const name of ['document', 'ui', 'gradient', 'photo', 'flat']) {
    const { canvas, expected } = draw(name);
    const ctx = canvas.getContext('2d')!;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const st = analyzeStaticImage(data, canvas.width, canvas.height);
    rows.push({
      name,
      expected,
      got: st.kind,
      confidence: Math.round(st.kindConfidence * 100),
      ok: st.kind === expected,
    });
  }
  return rows;
}
