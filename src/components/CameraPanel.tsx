// src/components/CameraPanel.tsx — live camera + two-layer vision pipeline.
//
// LAYER A (high FPS, every frame, purely local): frame → small canvas (128x72)
// → luma grid (96x40) → brightness + MotionDelta (two frames) → live "scope"
// (moving cells as a red heat map). ~60fps — no model, pixel-based.
//
// LAYER B (meaning, ~2fps): rich `buildFacts` (color, edge, texture, subject shape)
// + consistency → panel text. "Get AI interpretation" only goes to the LLM when triggered
// and sends the measurement TEXT, NOT the image (privacy + token savings).

import { useEffect, useRef, useState } from 'react';
import { X, Camera, Sparkles, ScanLine } from 'lucide-react';
import { useT } from '../lib/i18n';
import { buildFacts, gridLuma, motionDelta, selfCheck, interpretPrompt, updateSceneModel, emptySceneModel, type VisionFacts, type SceneModel } from '../lib/vision';

interface CameraPanelProps {
  onClose: () => void;
  onInterpret: (prompt: string) => void;
}

const SCOPE_W = 96;
const SCOPE_H = 40;

export function CameraPanel({ onClose, onInterpret }: CameraPanelProps) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const richCanvasRef = useRef<HTMLCanvasElement>(null);
  const scopeCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const prevLumaRef = useRef<Float32Array | null>(null);
  const modelRef = useRef<SceneModel>(emptySceneModel());
  const lastStatusRef = useRef('');
  const lastEventsLenRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [facts, setFacts] = useState<VisionFacts | null>(null);
  const [sceneStatus, setSceneStatus] = useState<string>('Waiting for camera…');
  const [sceneEvents, setSceneEvents] = useState<string[]>([]);
  const [live, setLive] = useState<{ motion: number; bright: number }>({ motion: 0, bright: 0 });
  // Measurement-exposed settings (live adjustable)
  const [sens, setSens] = useState(1);
  const [minArea, setMinArea] = useState(5);
  const sensRef = useRef(sens);
  sensRef.current = sens;
  const minAreaRef = useRef(minArea);
  minAreaRef.current = minArea;

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let lastRich = 0;
    let lastScope = 0;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 320 }, height: { ideal: 180 }, facingMode: 'environment' },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
      } catch (e) {
        setError(`Could not open camera: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();

    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      const video = videoRef.current;
      if (!video || video.videoWidth === 0) return;

      // ── LAYER A: high FPS scope (every frame) ───────────────────────────
      // ── LAYER A: high FPS analysis (~15Hz) ──────────────────────────────
      // The canvas is NOT read on every rAF (a getImageData read stalls the compositor).
      // The video element plays at 60fps; the ANALYSIS runs at 15Hz — imperceptible for the indicator.
      if (t - lastScope >= 66) {
        lastScope = t;
        const scopeCv = scopeCanvasRef.current;
        if (scopeCv) {
          const sctx = scopeCv.getContext('2d', { willReadFrequently: true });
          if (sctx) {
            sctx.drawImage(video, 0, 0, SCOPE_W, SCOPE_H);
            const img = sctx.getImageData(0, 0, SCOPE_W, SCOPE_H);
            const luma = gridLuma(img.data, SCOPE_W, SCOPE_H, SCOPE_W, SCOPE_H);
            let sum = 0;
            for (let i = 0; i < luma.length; i++) sum += luma[i];
            const bright = Math.round((sum / luma.length) * 100);
            const m = prevLumaRef.current ? motionDelta(prevLumaRef.current, luma, 0.1, SCOPE_W) : { pct: null, boxCells: null };
            prevLumaRef.current = luma;
            const pct = m.pct ?? 0;
            setLive({ motion: pct > 40 ? 100 : pct * 2.5, bright });
          }
        }
      }

      // ── LAYER B: rich measurements (~2fps) ──────────────────────────────
      if (t - lastRich < 500) return;
      lastRich = t;
      const rich = richCanvasRef.current;
      if (!rich) return;
      // Downscale the frame → getImageData is cheap (FPS preserved)
      rich.width = Math.min(video.videoWidth, 320);
      rich.height = Math.min(video.videoHeight, 180);
      const rctx = rich.getContext('2d', { willReadFrequently: true });
      if (!rctx) return;
      rctx.drawImage(video, 0, 0, rich.width, rich.height);
      const img = rctx.getImageData(0, 0, rich.width, rich.height);
      setFacts(buildFacts(img.data, rich.width, rich.height, prevLumaRef.current));
      // LIVE SCENE MEMORY: learns the background + frame-diff → moving subject
      const gl = gridLuma(img.data, rich.width, rich.height, 84, 34);
      modelRef.current = updateSceneModel(gl, modelRef.current, 84, 34, { sens: sensRef.current, minArea: minAreaRef.current });
      // React re-render only WHEN IT CHANGES (update that does not eat FPS)
      if (modelRef.current.status !== lastStatusRef.current) {
        lastStatusRef.current = modelRef.current.status;
        setSceneStatus(modelRef.current.status);
      }
      if (modelRef.current.events.length !== lastEventsLenRef.current) {
        lastEventsLenRef.current = modelRef.current.events.length;
        setSceneEvents(modelRef.current.events);
      }
      // Overlay: transparent — red background-diff, cyan frame-diff (moving
      // hand), green selected-subject box. The video is not redrawn (fast).
      const ov = overlayRef.current;
      if (ov) {
        ov.width = video.videoWidth;
        ov.height = video.videoHeight;
        const octx = ov.getContext('2d');
        if (octx) {
          octx.clearRect(0, 0, ov.width, ov.height);
          const cw = ov.width / 84, ch = ov.height / 34;
          const bgm = modelRef.current.fgMask;
          const dm = modelRef.current.diffMask;
          if (bgm) {
            octx.fillStyle = 'rgba(255,60,60,0.35)';
            for (let i = 0; i < 84 * 34; i++) if (bgm[i]) octx.fillRect((i % 84) * cw, Math.floor(i / 84) * ch, cw, ch);
          }
          if (dm) {
            octx.fillStyle = 'rgba(0,220,255,0.55)';
            for (let i = 0; i < 84 * 34; i++) if (dm[i]) octx.fillRect((i % 84) * cw, Math.floor(i / 84) * ch, cw, ch);
          }
          const s = modelRef.current.subject;
          if (s) {
            const [bx, by, bw, bh] = s.box.split(/[ ,x]+/).map(Number);
            if (!isNaN(bx) && !isNaN(by) && !isNaN(bw)) {
              octx.strokeStyle = '#3AA99F';
              octx.lineWidth = 2;
              octx.strokeRect(bx * cw, by * ch, bw * cw, bh * ch);
            }
          }
        }
      }
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
      <div className="w-[680px] max-w-full bg-[#100F0F] border border-white/10 rounded-lg overflow-hidden shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
          <span className="flex items-center gap-2 text-[12px] font-semibold text-[#F2F0E5]">
            <Camera size={13} className="text-[#3AA99F]" /> {t('cam.title')}
          </span>
          <button type="button" onClick={onClose} className="text-[#87857F] hover:text-white cursor-pointer" aria-label={t('cam.close')}>
            <X size={15} />
          </button>
        </div>

        <div className="p-3 flex flex-col gap-3">
        <div className="relative">
          <video ref={videoRef} muted playsInline className="w-full h-[220px] object-cover bg-black rounded-md" />
          <canvas ref={overlayRef} className="absolute inset-0 w-full h-[220px] object-cover pointer-events-none rounded-md" />
        </div>
        <canvas ref={richCanvasRef} className="hidden" />
        <canvas ref={scopeCanvasRef} className="hidden" />
        <div className="flex items-center gap-4 text-[11px] font-mono">
          <label className="flex items-center gap-1.5 text-[#87857F]">
            {t('cam.sensitivity')}
            <input type="range" min={0.5} max={3} step={0.1} value={sens} onChange={(e) => setSens(Number(e.target.value))} className="w-24 accent-[#3AA99F]" />
            <span className="text-[#F2F0E5]">{sens.toFixed(1)}</span>
          </label>
          <label className="flex items-center gap-1.5 text-[#87857F]">
            {t('cam.minBlob')}
            <input type="range" min={2} max={20} step={1} value={minArea} onChange={(e) => setMinArea(Number(e.target.value))} className="w-24 accent-[#3AA99F]" />
            <span className="text-[#F2F0E5]">{minArea}</span>
          </label>
        </div>

          {/* HIGH FPS live indicators */}
          <div className="flex items-center gap-3 font-mono text-[11px]">
            <div className="flex-1">
              <div className="flex justify-between text-[#87857F] mb-1"><span>{t('cam.liveMotion')}</span><span>%{Math.round(live.motion)}</span></div>
              <div className="h-2 bg-white/5 rounded overflow-hidden">
                <div className="h-full bg-rose-500/80 transition-[width] duration-75" style={{ width: `${Math.min(100, live.motion)}%` }} />
              </div>
            </div>
            <div className="flex-1">
              <div className="flex justify-between text-[#87857F] mb-1"><span>{t('cam.light')}</span><span>%{live.bright}</span></div>
              <div className="h-2 bg-white/5 rounded overflow-hidden">
                <div className={`h-full transition-[width] duration-75 ${live.bright > 70 ? 'bg-amber-400' : live.bright < 20 ? 'bg-blue-600' : 'bg-emerald-500/70'}`} style={{ width: `${Math.min(100, live.bright)}%` }} />
              </div>
            </div>
            <div className="flex-1" title={t('cam.scopeTitle')}>
              <span className="text-[#87857F]">{t('cam.scope')}</span>
            </div>
          </div>

          {/* RICH measurements (meaning layer) */}
          {error ? (
            <div className="text-[11px] text-rose-300 font-mono">{error}</div>
          ) : facts ? (
            <div className="flex flex-col gap-1 font-mono text-[11px] leading-relaxed text-[#CECDC3]">
              <div className="flex items-center gap-1.5 text-[#3AA99F]"><ScanLine size={11} /> {t('cam.liveScene')}</div>
              <div className="text-[#CECDC3]">{sceneStatus}</div>
              {sceneEvents.length > 0 && (
                <div className="text-[#87857F]">events: {sceneEvents.slice(-3).join(' · ')}</div>
              )}
              <div className="flex items-center gap-1.5 pt-0.5 text-[#3AA99F]"><ScanLine size={11} /> {t('cam.measured')}</div>
              <div>light: {facts.lightClass} (%{facts.bright}) · colors: {facts.colors.map((c) => `${c.hex}%${c.pct}`).join(' ')}</div>
              <div>edge: {facts.edges.dominant} (H{facts.edges.horizontal}/V{facts.edges.vertical}) · texture: {facts.tex.textureClass}</div>
              <div>
                {facts.subj
                  ? `subject ${facts.subj.box}: ${facts.subj.shapeClass} · aspect ${facts.subj.aspect} · upright:${facts.subj.upright} · motion %${facts.subj.motionPct}`
                  : t('cam.noSubject')}
              </div>
              <div className="text-[#A8A49E]">{t('cam.consistency')} {selfCheck(facts).join(' · ')}</div>
            </div>
          ) : (
            <div className="text-[11px] text-[#87857F] font-mono">{t('cam.waiting')}</div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={!facts}
              onClick={() => facts && onInterpret(interpretPrompt(facts))}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#205EA6] hover:bg-[#4385BE] text-white text-[11px] font-medium disabled:opacity-30 cursor-pointer"
            >
              <Sparkles size={12} /> {t('cam.getInterpretation')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
