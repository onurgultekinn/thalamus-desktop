import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import {
  FileCode, X, Download, PictureInPicture2, ExternalLink, ChevronLeft, ChevronRight, ChevronDown,
  Minus, Plus, MoveHorizontal, RotateCw, RotateCcw, Play, Pause, SkipBack, SkipForward, Camera,
  Volume2, VolumeX, Repeat, FlipHorizontal2, FlipVertical2, ZoomIn, ZoomOut, Maximize2, Pencil,
  Eye, Save, WrapText, ListOrdered, Copy, Grid3x3, Check,
} from 'lucide-react';
import { FileViewer, type FileViewerHandle } from '@file-viewer/react-full';
import { findFileViewerZoomProvider, resolveFileViewerScrollContainer } from '@file-viewer/core';
import { useT } from '../lib/i18n';
import { useFloatingPanel, useAutoMinWidth, FloatResizeHandle, FLOATING_CHROME } from './floating';

/** Standart zoom basamakları (tarayıcı/PDF görüntüleyici alışkanlığı). */
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** Kontrol şeridi düğme stili (ikon ve metin düğmeleri ortak). */
const BAR_BTN = 'flex h-6 items-center justify-center rounded-md text-obsidian-muted '
  + 'hover:text-obsidian-text hover:bg-[#dcb67a]/10 disabled:opacity-30 '
  + 'disabled:hover:bg-transparent disabled:cursor-default cursor-pointer transition-colors';

/** Tüm şeritlerin ortak kabuğu (başlığın hemen altında, 30px). */
const BAR_SHELL = 'flex items-center justify-between gap-2 h-[30px] px-2 bg-[#171614] '
  + 'border-b border-obsidian-border flex-shrink-0 select-none';

/** Şerit kaydırıcıları (konum/ses) için ortak sınıf. */
const RANGE_CLS = 'tlm-range cursor-pointer';

/** Medya oynatma hızı basamakları. */
const RATE_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** Gösterim basamakları (görsel + metin şeritleri). */
const IMAGE_ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
const FONT_SIZES = [9, 10, 11, 11.5, 12, 13, 14, 16, 18, 20, 24];

function fmtTime(sec: number) {
  const total = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return `${h > 0 ? `${h}:` : ''}${h > 0 ? String(m).padStart(2, '0') : m}:${String(s).padStart(2, '0')}`;
}

/** Şerit ikon düğmesi (başlık/aktif/pasif durumları). */
function BarButton({ title, onClick, disabled, active, className = 'w-6', children }: {
  title: string; onClick?: () => void; disabled?: boolean; active?: boolean; className?: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={`${BAR_BTN} ${className} ${active ? 'text-[#dcb67a] bg-[#dcb67a]/[0.12]' : ''}`}
    >
      {children}
    </button>
  );
}

/** Metin dosyasını diske yazar; önce `<ad>.bak` yedeğini bırakır.
 *  Tauri yoksa (tarayıcı önizlemesi) indirmeye düşer. */
async function writeTextWithBackup(path: string, content: string, original: string): Promise<'saved' | 'downloaded'> {
  const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (inTauri && path) {
    await invoke('thalamus_write_file', { path: `${path}.bak`, content: original });
    await invoke('thalamus_write_file', { path, content });
    return 'saved';
  }
  triggerDownload(path ? path.split(/[\\/]/).pop()! : 'edited.txt', undefined, undefined, content);
  return 'downloaded';
}

export interface PreviewItem {
  name: string;
  size?: string;
  /** Native dallanma için sınıf; geri kalanı @file-viewer'a gider. */
  kind: 'text' | 'binary' | 'large' | 'image' | 'pdf' | 'audio' | 'video';
  mime?: string;
  /** Metin içeriği (metin dallanması). */
  body?: string;
  /** Yerel önizleme URL'i (image/audio/video/pdf blob). */
  url?: string;
  /** @file-viewer için ham baytlar (office, arşiv, pdf, veri…). */
  buffer?: ArrayBuffer;
  /** Diskteki tam yol (varsa düzenle + kaydet açılır; yedek alınır). */
  path?: string;
}

function triggerDownload(name: string, url?: string, buffer?: ArrayBuffer, body?: string) {
  const href = url
    ?? (buffer ? URL.createObjectURL(new Blob([buffer])) : undefined)
    ?? (body !== undefined ? URL.createObjectURL(new Blob([body], { type: 'text/plain' })) : undefined);
  if (!href) return;
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // buffer'dan ürettiysek hemen serbest bırakma; tarayıcı indirmeyi başlattı.
}

/** Sağ tık menüsü satırı (kısayol ipucu sağda). */
function MenuItem({ label, hint, disabled, active, onClick }: { label: string; hint?: string; disabled?: boolean; active?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left transition-colors ${
        disabled
          ? 'cursor-default text-obsidian-muted/50'
          : active
            ? 'cursor-pointer text-[#dcb67a] bg-[#dcb67a]/[0.12]'
            : 'cursor-pointer hover:bg-[#282726] hover:text-[#dcb67a]'
      }`}
    >
      <span>{label}</span>
      {hint && <span className="font-mono text-[10.5px] text-obsidian-muted">{hint}</span>}
    </button>
  );
}

/** Medya (video/ses) oynatıcı durumu. */
export interface MediaState {
  playing: boolean; time: number; duration: number; rate: number; volume: number; muted: boolean; loop: boolean;
}

/** Video/ses şeridi: oynatma, atlama, hız, ses, döngü (+ video: kare/PiP/tam ekran). */
function MediaBar({ kind, state, onToggle, onSeekBy, onScrub, onRate, onVolume, onMute, onLoop, onFrame, onCapture, onPip, onFullscreen }: {
  kind: 'video' | 'audio';
  state: MediaState;
  onToggle: () => void;
  onSeekBy: (delta: number) => void;
  onScrub: (time: number) => void;
  onRate: () => void;
  onVolume: (v: number) => void;
  onMute: () => void;
  onLoop: () => void;
  onFrame?: (dir: 1 | -1) => void;
  onCapture?: () => void;
  onPip?: () => void;
  onFullscreen?: () => void;
}) {
  const t = useT();
  const isVideo = kind === 'video';
  return (
    <div className={BAR_SHELL}>
      <div className="flex items-center gap-0.5 min-w-0 flex-1">
        <BarButton title={state.playing ? t('preview.pause') : t('preview.play')} onClick={onToggle}>
          {state.playing ? <Pause size={14} /> : <Play size={14} />}
        </BarButton>
        <BarButton title={t(isVideo ? 'preview.back5' : 'preview.back10')} onClick={() => onSeekBy(isVideo ? -5 : -10)}>
          <SkipBack size={14} />
        </BarButton>
        <BarButton title={t(isVideo ? 'preview.forward5' : 'preview.forward10')} onClick={() => onSeekBy(isVideo ? 5 : 10)}>
          <SkipForward size={14} />
        </BarButton>
        <span className="px-1 font-mono text-[10.5px] tabular-nums text-obsidian-muted whitespace-nowrap">
          {fmtTime(state.time)}<span className="text-obsidian-muted/50"> / {fmtTime(state.duration)}</span>
        </span>
        <input
          type="range"
          min={0}
          max={state.duration || 0}
          step={0.05}
          value={Math.min(state.time, state.duration || 0)}
          onChange={(e) => onScrub(Number(e.target.value))}
          aria-label={t('preview.seek')}
          className={`${RANGE_CLS} flex-1 min-w-[50px] h-1`}
        />
      </div>
      <div className="flex items-center gap-0.5 flex-shrink-0">
        {isVideo && onFrame && (
          <>
            <BarButton title={t('preview.frameBack')} onClick={() => onFrame(-1)}><ChevronLeft size={14} /></BarButton>
            <BarButton title={t('preview.frameForward')} onClick={() => onFrame(1)}><ChevronRight size={14} /></BarButton>
          </>
        )}
        {isVideo && onCapture && (
          <BarButton title={t('preview.capture')} onClick={onCapture}><Camera size={14} /></BarButton>
        )}
        <BarButton title={t('preview.rate')} onClick={onRate} className="px-1.5 min-w-[38px] font-mono text-[11px]">
          {state.rate}×
        </BarButton>
        <div className="w-px h-4 mx-1 bg-obsidian-border" />
        <BarButton title={state.muted ? t('preview.unmute') : t('preview.mute')} active={state.muted} onClick={onMute}>
          {state.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </BarButton>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={state.muted ? 0 : state.volume}
          onChange={(e) => onVolume(Number(e.target.value))}
          aria-label={t('preview.volume')}
          className={`${RANGE_CLS} w-14 h-1`}
        />
        <BarButton title={t('preview.loop')} active={state.loop} onClick={onLoop}><Repeat size={13} /></BarButton>
        {isVideo && onPip && onFullscreen && (
          <>
            <div className="w-px h-4 mx-1 bg-obsidian-border" />
            <BarButton title={t('preview.pip')} onClick={onPip}><PictureInPicture2 size={14} /></BarButton>
            <BarButton title={t('preview.fullscreen')} onClick={onFullscreen}><Maximize2 size={14} /></BarButton>
          </>
        )}
      </div>
    </div>
  );
}

/** Görsel şeridi: zoom, döndürme, çevirme, arka plan. */
function ImageBar({ zoom, state, onZoom, onRotate, onFlip, onReset, onBg }: {
  zoom: number;
  state: { rotation: number; flipH: boolean; flipV: boolean; bg: 'dark' | 'checker' };
  onZoom: (dir: 1 | -1) => void;
  onRotate: (dir: 1 | -1) => void;
  onFlip: (axis: 'h' | 'v') => void;
  onReset: () => void;
  onBg: () => void;
}) {
  const t = useT();
  return (
    <div className={BAR_SHELL}>
      <div className="flex items-center gap-0.5">
        <BarButton title={t('preview.zoomOut')} onClick={() => onZoom(-1)} disabled={zoom <= IMAGE_ZOOM_STEPS[0] + 0.001}>
          <ZoomOut size={14} />
        </BarButton>
        <BarButton title={t('preview.resetView')} onClick={onReset} className="px-1.5 min-w-[44px] font-mono text-[11px]">
          {Math.round(zoom * 100)}%
        </BarButton>
        <BarButton title={t('preview.zoomIn')} onClick={() => onZoom(1)} disabled={zoom >= IMAGE_ZOOM_STEPS[IMAGE_ZOOM_STEPS.length - 1] - 0.001}>
          <ZoomIn size={14} />
        </BarButton>
      </div>
      <div className="flex items-center gap-0.5">
        <BarButton title={t('preview.rotateLeft')} onClick={() => onRotate(-1)}><RotateCcw size={14} /></BarButton>
        <BarButton title={t('preview.rotate')} onClick={() => onRotate(1)}><RotateCw size={14} /></BarButton>
        <div className="w-px h-4 mx-1 bg-obsidian-border" />
        <BarButton title={t('preview.flipH')} active={state.flipH} onClick={() => onFlip('h')}><FlipHorizontal2 size={14} /></BarButton>
        <BarButton title={t('preview.flipV')} active={state.flipV} onClick={() => onFlip('v')}><FlipVertical2 size={14} /></BarButton>
        <div className="w-px h-4 mx-1 bg-obsidian-border" />
        <BarButton title={t('preview.background')} active={state.bg === 'checker'} onClick={onBg}><Grid3x3 size={14} /></BarButton>
      </div>
    </div>
  );
}

/** Metin/kod şeridi: düzenle-kaydet, yazı boyutu, sarma, satır numaraları, kopyala. */
function TextBar({ editing, dirty, saved, size, wrap, lines, onEdit, onSave, onSize, onWrap, onLines, onCopyAll, copied, canEdit }: {
  editing: boolean;
  dirty: boolean;
  saved: boolean;
  size: number;
  wrap: boolean;
  lines: boolean;
  onEdit: () => void;
  onSave: () => void;
  onSize: (dir: 1 | -1) => void;
  onWrap: () => void;
  onLines: () => void;
  onCopyAll: () => void;
  copied: boolean;
  canEdit: boolean;
}) {
  const t = useT();
  return (
    <div className={BAR_SHELL}>
      <div className="flex items-center gap-0.5 min-w-0">
        <BarButton
          title={editing ? t('preview.previewMode') : t('preview.edit')}
          active={editing}
          onClick={onEdit}
          disabled={!canEdit}
          className="gap-1 px-1.5 w-auto text-[11px]"
        >
          {editing ? <Eye size={13} /> : <Pencil size={13} />}
          <span>{editing ? t('preview.previewMode') : t('preview.edit')}</span>
        </BarButton>
        {editing && (
          <BarButton
            title={`${t('preview.save')} (Ctrl+S)`}
            active={dirty}
            onClick={onSave}
            className={`gap-1 px-1.5 w-auto text-[11px] ${dirty ? 'text-[#dcb67a]' : ''}`}
          >
            <Save size={13} />
            <span>{t('preview.save')}</span>
          </BarButton>
        )}
        {editing && dirty && <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-[#dcb67a]" title={t('preview.unsaved')} />}
        {!editing && saved && (
          <span className="ml-1 flex items-center gap-1 text-[10.5px] text-[#6B9E6B]"><Check size={12} />{t('preview.saved')}</span>
        )}
      </div>
      <div className="flex items-center gap-0.5 flex-shrink-0">
        <BarButton title={t('preview.fontSmaller')} onClick={() => onSize(-1)} disabled={size <= FONT_SIZES[0]}>
          <Minus size={14} />
        </BarButton>
        <span className="px-0.5 font-mono text-[11px] text-obsidian-muted min-w-[26px] text-center">{size}</span>
        <BarButton title={t('preview.fontLarger')} onClick={() => onSize(1)} disabled={size >= FONT_SIZES[FONT_SIZES.length - 1]}>
          <Plus size={14} />
        </BarButton>
        <div className="w-px h-4 mx-1 bg-obsidian-border" />
        <BarButton title={t('preview.wrap')} active={wrap} onClick={onWrap}><WrapText size={14} /></BarButton>
        <BarButton title={t('preview.lineNumbers')} active={lines} onClick={onLines}><ListOrdered size={14} /></BarButton>
        <BarButton title={t('preview.copyAll')} onClick={onCopyAll} className="w-6">
          {copied ? <Check size={13} className="text-[#6B9E6B]" /> : <Copy size={13} />}
        </BarButton>
      </div>
    </div>
  );
}

/** PDF şeridi: sayfa gezinme, zoom menüsü, sığdır, döndür. */
function PdfBar({ page, pageCount, scale, rotation, zoomMenuOpen, zoomBtnRef, onGoTo, onStepZoom, onToggleZoomMenu, onFit, onRotate }: {
  page: number;
  pageCount: number;
  scale: number;
  rotation: number;
  zoomMenuOpen: boolean;
  zoomBtnRef: React.RefObject<HTMLButtonElement | null>;
  onGoTo: (page: number) => void;
  onStepZoom: (dir: 1 | -1) => void;
  onToggleZoomMenu: () => void;
  onFit: () => void;
  onRotate: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const value = Number.parseInt(draft ?? '', 10);
    setDraft(null);
    if (Number.isFinite(value) && value !== page) onGoTo(value);
  };
  return (
    <div className={BAR_SHELL}>
      <div className="flex items-center gap-0.5">
        <BarButton title={t('preview.prevPage')} onClick={() => onGoTo(page - 1)} disabled={page <= 1}>
          <ChevronLeft size={15} />
        </BarButton>
        <input
          value={draft ?? String(page)}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { commit(); e.currentTarget.blur(); }
            else if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur(); }
          }}
          inputMode="numeric"
          aria-label={t('preview.page')}
          title={t('preview.page')}
          className="w-8 h-6 rounded-md bg-transparent text-center font-mono text-[11.5px] text-obsidian-text border border-transparent hover:border-obsidian-border focus:border-[#dcb67a]/60 focus:bg-[#100F0F] outline-none transition-colors"
        />
        <span className="font-mono text-[11px] text-obsidian-muted min-w-[26px]">/ {pageCount || '–'}</span>
        <BarButton title={t('preview.nextPage')} onClick={() => onGoTo(page + 1)} disabled={!pageCount || page >= pageCount}>
          <ChevronRight size={15} />
        </BarButton>
      </div>

      <div className="flex items-center gap-0.5">
        <BarButton title={`${t('preview.zoomOut')} (Ctrl+−)`} onClick={() => onStepZoom(-1)} disabled={scale <= ZOOM_STEPS[0] + 0.001}>
          <Minus size={14} />
        </BarButton>
        <button
          ref={zoomBtnRef}
          type="button"
          onClick={onToggleZoomMenu}
          title={t('preview.zoomMenu')}
          className={`${BAR_BTN} gap-0.5 px-1.5 min-w-[46px] font-mono text-[11.5px] ${zoomMenuOpen ? 'text-[#dcb67a] bg-[#dcb67a]/[0.12]' : ''}`}
        >
          {Math.round(scale * 100)}% <ChevronDown size={11} />
        </button>
        <BarButton title={`${t('preview.zoomIn')} (Ctrl++)`} onClick={() => onStepZoom(1)} disabled={scale >= ZOOM_STEPS[ZOOM_STEPS.length - 1] - 0.001}>
          <Plus size={14} />
        </BarButton>
        <div className="w-px h-4 mx-1 bg-obsidian-border" />
        <BarButton title={`${t('preview.fitWidth')} (Ctrl+0)`} onClick={onFit}>
          <MoveHorizontal size={15} />
        </BarButton>
        <BarButton title={t('preview.rotate')} active={rotation % 360 !== 0} onClick={onRotate}>
          <RotateCw size={14} />
        </BarButton>
      </div>
    </div>
  );
}

/** PDF dışı görüntüleyiciler (Word/Excel/EPUB/veri/3B…) için zoom şeridi. */
function ViewerBar({ scale, onZoom, onReset, onFitWidth, onFitPage }: {
  scale: number;
  onZoom: (dir: 1 | -1) => void;
  onReset: () => void;
  onFitWidth: () => void;
  onFitPage: () => void;
}) {
  const t = useT();
  return (
    <div className={BAR_SHELL}>
      <div className="flex items-center gap-0.5">
        <BarButton title={t('preview.zoomOut')} onClick={() => onZoom(-1)} disabled={scale <= ZOOM_STEPS[0] + 0.001}>
          <ZoomOut size={14} />
        </BarButton>
        <BarButton title={t('preview.resetView')} onClick={onReset} className="px-1.5 min-w-[44px] font-mono text-[11px]">
          {Math.round(scale * 100)}%
        </BarButton>
        <BarButton title={t('preview.zoomIn')} onClick={() => onZoom(1)} disabled={scale >= ZOOM_STEPS[ZOOM_STEPS.length - 1] - 0.001}>
          <ZoomIn size={14} />
        </BarButton>
      </div>
      <div className="flex items-center gap-0.5">
        <BarButton title={t('preview.fitWidth')} onClick={onFitWidth}><MoveHorizontal size={15} /></BarButton>
        <BarButton title={t('preview.fitPage')} onClick={onFitPage}><Maximize2 size={14} /></BarButton>
      </div>
    </div>
  );
}

/** Ayrı bir pencere/pop-up'ta açar (blob URL ile). */
function openInWindow(item: PreviewItem) {
  const url = item.url ?? (item.buffer ? URL.createObjectURL(new Blob([item.buffer], item.mime ? { type: item.mime } : undefined)) : undefined);
  if (!url) return;
  // Tauri/WebView2'de window.open sistem tarayıcısına gider; tarayıcı önizlemesinde yeni sekme.
  window.open(url, '_blank', 'noopener,noreferrer,width=1000,height=760');
}

/**
 * Sağ tarafta açılan dosya önizleme çekmecesi.
 * Native dallar (görsel/ses/video/metin) hızlı; diğer tüm formatlar
 * (PDF, Office, arşiv, e-posta, veri, 3D, EPUB…) `@file-viewer` ile çizilir.
 * (PDF, ileride ayrı bir pdfjs görüntüleyiciye devredilecek — metin seçimi için.)
 */
export function FilePreviewDrawer({ item, onClose, inline = false, contentWidth }: { item: PreviewItem; onClose: () => void; inline?: boolean; contentWidth?: number }) {
  const t = useT();
  const fv = useFloatingPanel('preview', { def: { x: 820, y: 80, w: 560, h: 600 }, min: { w: 340, h: 260 } });
  useAutoMinWidth(fv.headerRef, fv.setMinWidth);
  const canUseViewer = useMemo(() => item.kind !== 'large' && (!!item.url || !!item.buffer), [item]);

  // @file-viewer `url` ile çalışır; buffer'dan blob URL üretip geçici olarak kullanırız.
  const viewerUrl = useMemo(() => {
    if (item.url) return item.url;
    if (item.buffer) return URL.createObjectURL(new Blob([item.buffer], item.mime ? { type: item.mime } : undefined));
    return undefined;
  }, [item]);
  useEffect(() => () => {
    // Yalnızca bizim ürettiğimiz blob'u serbest bırak.
    if (viewerUrl && !item.url) { try { URL.revokeObjectURL(viewerUrl); } catch { /* noop */ } }
  }, [viewerUrl, item.url]);

  const viewerRef = useRef<FileViewerHandle | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const hoveringRef = useRef(false);

  // Hangi dalın çizileceğini tek yerde belirle: viewer kendi içinde kaydırır,
  // native dallar ise dış kapsayıcıda. Böylece gereksiz (yeşil) dış
  // scrollbar oluşmaz.
  const viewMode = useMemo<'image' | 'video' | 'audio' | 'text' | 'viewer' | 'none'>(() => {
    if (item.kind === 'image' && item.url) return 'image';
    if (item.kind === 'video' && item.url) return 'video';
    if (item.kind === 'audio' && item.url) return 'audio';
    if (item.body !== undefined) return 'text';
    if (canUseViewer) return 'viewer';
    return 'none';
  }, [item, canUseViewer]);

  // Kütüphane zoom'u fit ölçeğinden (ör. %63) sabit +10% adımlarla ilerletip
  // "%73, %83" gibi küsuratlı değerler üretiyordu. Standart (tarayıcı)
  // basamaklarına oturtuyoruz. `setZoom` sayfa çapasını korur → görüntü
  // zıplamaz; yoksa view-state'e düşeriz.
  const stepZoom = useCallback((zoomIn: boolean) => {
    const cur = viewerRef.current?.getZoomState()?.scale ?? 1;
    const next = zoomIn
      ? ZOOM_STEPS.find((s) => s > cur + 0.005) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
      : [...ZOOM_STEPS].reverse().find((s) => s < cur - 0.005) ?? ZOOM_STEPS[0];
    const provider = findFileViewerZoomProvider(wrapperRef.current);
    if (provider?.setZoom) { void provider.setZoom(next); return; }
    void viewerRef.current?.applyViewState(
      { scale: next },
      { source: 'user', action: zoomIn ? 'zoom-in' : 'zoom-out' },
    );
  }, []);

  const getScroller = useCallback((): HTMLElement | null => {
    const root = wrapperRef.current;
    if (!root) return null;
    return (root.querySelector('.pdf-wrapper') as HTMLElement | null)
      ?? resolveFileViewerScrollContainer(root);
  }, []);

  // Etkileşim — kısayolsuz ve çakışmasız:
  // • Sol tık + sürükle → kaydırma (her yerde).
  // • Metin ÜZERİNDE kısa süre BASILI TUT sonra sürükle → metin seçimi
  //   (dokunmatik alışkanlığı). Basılı tutunca küçük "Metin seçimi" ipucu çıkar.
  // • Sağ tık + sürükle (dikey) → zoom (yukarı yakınlaştır, aşağı uzaklaştır).
  // • Hareketsiz sağ tık → kompakt menü.
  const HOLD_TO_SELECT_MS = 250;
  const panCleanupRef = useRef<(() => void) | null>(null);
  const suppressPanClickRef = useRef(false);
  const [hint, setHint] = useState<{ x: number; y: number } | null>(null);
  const hintTimerRef = useRef<number | null>(null);
  useEffect(() => () => panCleanupRef.current?.(), []);
  useEffect(() => () => { if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current); }, []);

  const showSelectHint = useCallback((x: number, y: number) => {
    if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
    setHint({ x: Math.min(x + 14, window.innerWidth - 120), y: Math.min(y + 14, window.innerHeight - 36) });
    hintTimerRef.current = window.setTimeout(() => setHint(null), 800);
  }, []);

  const [menu, setMenu] = useState<{ x: number; y: number; canCopy: boolean } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  // Kendi kontrol şeridimizin durumu: sayfa / toplam sayfa / zoom / döndürme.
  const [pdfView, setPdfView] = useState<{ page: number; pageCount: number; scale: number; rotation: number }>(
    { page: 1, pageCount: 0, scale: 1, rotation: 0 },
  );
  const [zoomMenuAt, setZoomMenuAt] = useState<{ x: number; y: number } | null>(null);
  const zoomMenuRef = useRef<HTMLDivElement | null>(null);
  const zoomBtnRef = useRef<HTMLButtonElement | null>(null);
  const closeZoomMenu = useCallback(() => setZoomMenuAt(null), []);

  // Video/ses oynatıcı (tek durum, aktif öğeye bağlanır).
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [media, setMedia] = useState<MediaState>(
    { playing: false, time: 0, duration: 0, rate: 1, volume: 1, muted: false, loop: false },
  );

  // Görsel görünümü (zoom/döndürme/çevirme/arka plan).
  const [image, setImage] = useState<{ zoom: number; rotation: number; flipH: boolean; flipV: boolean; bg: 'dark' | 'checker' }>(
    { zoom: 1, rotation: 0, flipH: false, flipV: false, bg: 'dark' },
  );

  // Metin/kod: düzenleme taslağı + yazı boyutu/sarma/satır numarası.
  const [edit, setEdit] = useState<{
    on: boolean; draft: string; base: string; size: number; wrap: boolean; lines: boolean; saved: boolean; copied: boolean;
  }>({ on: false, draft: '', base: '', size: 11.5, wrap: true, lines: false, saved: false, copied: false });

  // Kısa süreli bilgi balonu (kaydedildi / hata).
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const noteTimerRef = useRef<number | null>(null);
  const showNote = useCallback((text: string, error = false) => {
    if (noteTimerRef.current) window.clearTimeout(noteTimerRef.current);
    setNote({ text, error });
    noteTimerRef.current = window.setTimeout(() => setNote(null), error ? 6000 : 2600);
  }, []);
  useEffect(() => () => { if (noteTimerRef.current) window.clearTimeout(noteTimerRef.current); }, []);

  const zoomTo = useCallback((scale: number) => {
    const provider = findFileViewerZoomProvider(wrapperRef.current);
    if (provider?.setZoom) { void provider.setZoom(scale); return; }
    void viewerRef.current?.applyViewState(
      { scale },
      { source: 'user', action: 'zoom-change' },
    );
  }, []);

  const rotateViewer = useCallback(() => {
    const current = viewerRef.current?.getViewState()?.rotation ?? 0;
    void viewerRef.current?.applyViewState(
      { rotation: (current + 90) % 360 },
      { source: 'user', action: 'rotate-right' },
    );
  }, []);

  // Şeridin gösterdiği değerleri kütüphanenin gerçek durumundan oku.
  const [viewerZoom, setViewerZoom] = useState<{ has: boolean; scale: number }>({ has: false, scale: 1 });

  const syncPdfView = useCallback(() => {
    const handle = viewerRef.current;
    const vs = handle?.getViewState();
    const zs = handle?.getZoomState();
    const provider = findFileViewerZoomProvider(wrapperRef.current);
    const providerState = provider?.getState?.();
    const providerScale = typeof providerState?.scale === 'number' ? providerState.scale : null;
    if (vs || zs || providerScale !== null) {
      setPdfView((prev) => ({
        page: vs?.page ?? prev.page,
        pageCount: vs?.pageCount ?? prev.pageCount,
        scale: providerScale ?? vs?.scale ?? zs?.scale ?? prev.scale,
        rotation: vs?.rotation ?? prev.rotation,
      }));
    }
    if (provider || providerScale !== null) {
      setViewerZoom((prev) => {
        const has = true;
        const scale = providerScale ?? prev.scale;
        return prev.has === has && Math.abs(prev.scale - scale) < 0.001 ? prev : { has, scale };
      });
    }
  }, []);

  useEffect(() => {
    if (viewMode !== 'viewer') return;
    const handle = viewerRef.current;
    if (!handle) return;
    const unsub = handle.subscribe(() => syncPdfView());
    const raf = requestAnimationFrame(syncPdfView);
    const late = window.setTimeout(syncPdfView, 400);
    return () => { unsub?.(); cancelAnimationFrame(raf); window.clearTimeout(late); };
  }, [viewMode, item, syncPdfView]);

  // PDF dışı görüntüleyicilerde de zoom'u standart basamaklara oturt.
  const viewerZoomStep = useCallback((dir: 1 | -1) => {
    const provider = findFileViewerZoomProvider(wrapperRef.current);
    if (!provider) return;
    const cur = provider.getState?.().scale ?? 1;
    const next = dir === 1
      ? ZOOM_STEPS.find((s) => s > cur + 0.005) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
      : [...ZOOM_STEPS].reverse().find((s) => s < cur - 0.005) ?? ZOOM_STEPS[0];
    if (provider.setZoom) { void provider.setZoom(next); return; }
    void (dir === 1 ? provider.zoomIn() : provider.zoomOut());
  }, []);

  const viewerZoomReset = useCallback(() => {
    void findFileViewerZoomProvider(wrapperRef.current)?.resetZoom();
  }, []);

  const fitViewer = useCallback((mode: 'width' | 'contain') => {
    void viewerRef.current?.fitToView(mode);
  }, []);

  const goToPage = useCallback((page: number) => {
    const total = pdfView.pageCount || 0;
    const next = Math.min(Math.max(1, Math.round(page)), total || 1);
    if (next === pdfView.page) return;
    void viewerRef.current?.applyViewState(
      { page: next },
      { source: 'user', action: 'page-change' },
    );
  }, [pdfView.page, pdfView.pageCount]);

  const fitToWidth = useCallback(() => {
    void viewerRef.current?.fitToView('width');
  }, []);

  const toggleZoomMenu = useCallback(() => {
    if (zoomMenuAt) { setZoomMenuAt(null); return; }
    const rect = zoomBtnRef.current?.getBoundingClientRect();
    if (!rect) return;
    setZoomMenuAt({
      x: Math.max(8, Math.min(rect.left - 24, window.innerWidth - 200)),
      y: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 260)),
    });
  }, [zoomMenuAt]);

  // ── Medya (video/ses) ────────────────────────────────────────────────────
  const activeMedia = useCallback((): HTMLVideoElement | HTMLAudioElement | null => (
    viewMode === 'video' ? videoRef.current : viewMode === 'audio' ? audioRef.current : null
  ), [viewMode]);

  useEffect(() => {
    const el = activeMedia();
    if (!el) return;
    const sync = () => setMedia({
      playing: !el.paused, time: el.currentTime, duration: el.duration || 0,
      rate: el.playbackRate, volume: el.volume, muted: el.muted, loop: el.loop,
    });
    sync();
    const events: (keyof HTMLMediaElementEventMap)[] = [
      'play', 'pause', 'timeupdate', 'durationchange', 'ratechange', 'volumechange', 'loadedmetadata', 'ended', 'seeked',
    ];
    events.forEach((ev) => el.addEventListener(ev, sync));
    return () => events.forEach((ev) => el.removeEventListener(ev, sync));
  }, [activeMedia, item]);

  const togglePlay = useCallback(() => {
    const el = activeMedia();
    if (!el) return;
    if (el.paused) void el.play().catch(() => { /* kod çözme hatası */ });
    else el.pause();
  }, [activeMedia]);

  const seekBy = useCallback((delta: number) => {
    const el = activeMedia();
    if (!el) return;
    const end = el.duration || 0;
    const next = el.currentTime + delta;
    el.currentTime = end > 0 ? Math.max(0, Math.min(end, next)) : Math.max(0, next);
  }, [activeMedia]);

  const scrubTo = useCallback((time: number) => {
    const el = activeMedia();
    if (el) el.currentTime = time;
  }, [activeMedia]);

  const cycleRate = useCallback(() => {
    const el = activeMedia();
    if (!el) return;
    const idx = RATE_STEPS.findIndex((r) => Math.abs(r - el.playbackRate) < 0.01);
    el.playbackRate = RATE_STEPS[(idx + 1) % RATE_STEPS.length];
  }, [activeMedia]);

  const setVolume = useCallback((v: number) => {
    const el = activeMedia();
    if (!el) return;
    el.volume = v;
    el.muted = v === 0;
  }, [activeMedia]);

  const toggleMute = useCallback(() => { const el = activeMedia(); if (el) el.muted = !el.muted; }, [activeMedia]);
  const toggleLoop = useCallback(() => { const el = activeMedia(); if (el) el.loop = !el.loop; }, [activeMedia]);

  const stepFrame = useCallback((dir: 1 | -1) => {
    const el = videoRef.current;
    if (!el) return;
    el.pause();
    el.currentTime = Math.max(0, el.currentTime + dir / 30);
  }, []);

  const captureFrame = useCallback(() => {
    const el = videoRef.current;
    if (!el || !el.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = el.videoWidth;
    canvas.height = el.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
    const stamp = fmtTime(el.currentTime).replace(/:/g, '-');
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${item.name.replace(/\.[^.]+$/, '')}-${stamp}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, 'image/png');
  }, [item.name]);

  const togglePip = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    const doc = document as Document & { pictureInPictureElement?: Element; exitPictureInPicture?: () => Promise<void> };
    void (async () => {
      try {
        if (doc.pictureInPictureElement) await doc.exitPictureInPicture?.();
        else await (el as HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> }).requestPictureInPicture?.();
      } catch { /* PiP desteklenmiyor */ }
    })();
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  }, []);

  // ── Görsel ───────────────────────────────────────────────────────────────
  const stepImageZoom = useCallback((dir: 1 | -1) => {
    setImage((p) => {
      let idx = IMAGE_ZOOM_STEPS.findIndex((s) => Math.abs(s - p.zoom) < 0.01);
      if (idx < 0) {
        idx = IMAGE_ZOOM_STEPS.reduce((best, s, i) => (
          Math.abs(s - p.zoom) < Math.abs(IMAGE_ZOOM_STEPS[best] - p.zoom) ? i : best
        ), 0);
      }
      return { ...p, zoom: IMAGE_ZOOM_STEPS[Math.max(0, Math.min(IMAGE_ZOOM_STEPS.length - 1, idx + dir))] };
    });
  }, []);

  const rotateImage = useCallback((dir: 1 | -1) => {
    setImage((p) => ({ ...p, rotation: (p.rotation + dir * 90 + 360) % 360 }));
  }, []);

  const flipImage = useCallback((axis: 'h' | 'v') => {
    setImage((p) => ({ ...p, flipH: axis === 'h' ? !p.flipH : p.flipH, flipV: axis === 'v' ? !p.flipV : p.flipV }));
  }, []);

  const resetImage = useCallback(() => setImage((p) => ({ ...p, zoom: 1 })), []);
  const toggleImageBg = useCallback(() => setImage((p) => ({ ...p, bg: p.bg === 'dark' ? 'checker' : 'dark' })), []);

  // ── Metin/kod ────────────────────────────────────────────────────────────
  const textDirty = edit.on && edit.draft !== (edit.base || item.body || '');

  const toggleEdit = useCallback(() => {
    setEdit((p) => (p.on
      ? { ...p, on: false, draft: p.base || item.body || '' }
      : { ...p, on: true, draft: p.draft || p.base || item.body || '', saved: false }));
  }, [item.body]);

  const saveText = useCallback(async () => {
    const content = edit.draft;
    if (content === (edit.base || item.body || '')) { showNote(t('preview.saved')); return; }
    try {
      const result = await writeTextWithBackup(item.path ?? '', content, edit.base || item.body || '');
      setEdit((p) => ({ ...p, base: content, saved: true, on: false }));
      showNote(result === 'saved'
        ? `${t('preview.saved')} · ${t('preview.backupAt')} ${(item.path ?? '').split(/[\\/]/).pop()}.bak`
        : t('preview.downloaded'));
    } catch (err) {
      showNote(`${t('preview.saveFailed')}: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }, [edit.draft, edit.base, item.body, item.path, showNote, t]);

  const stepFont = useCallback((dir: 1 | -1) => {
    setEdit((p) => {
      const idx = FONT_SIZES.reduce((best, s, i) => (
        Math.abs(s - p.size) < Math.abs(FONT_SIZES[best] - p.size) ? i : best
      ), 0);
      return { ...p, size: FONT_SIZES[Math.max(0, Math.min(FONT_SIZES.length - 1, idx + dir))] };
    });
  }, []);

  const copyAllText = useCallback(() => {
    const text = edit.on ? edit.draft : (item.body ?? '');
    const done = navigator.clipboard?.writeText(text);
    if (done) void done.then(() => {
      setEdit((p) => ({ ...p, copied: true }));
      window.setTimeout(() => setEdit((p) => ({ ...p, copied: false })), 1400);
    }).catch(() => { /* pano izni yok */ });
  }, [edit.on, edit.draft, item.body]);

  // Medya kısayolları (imleç önizlemede ya da oynatıcı odaktayken):
  // Space/K oynat-duraklat, ←/→ ±5 sn, ↑/↓ ses, M sessiz.
  useEffect(() => {
    if (viewMode !== 'video' && viewMode !== 'audio') return;
    const onKey = (e: KeyboardEvent) => {
      const mediaEl = activeMedia();
      if (!mediaEl) return;
      const focusedHere = document.activeElement === mediaEl;
      if (!hoveringRef.current && !focusedHere) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === ' ' || e.key.toLowerCase() === 'k') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); seekBy(5); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); seekBy(-5); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setVolume(Math.min(1, (mediaEl.muted ? 0 : mediaEl.volume) + 0.1)); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setVolume(Math.max(0, (mediaEl.muted ? 0 : mediaEl.volume) - 0.1)); }
      else if (e.key.toLowerCase() === 'm') { e.preventDefault(); toggleMute(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewMode, activeMedia, togglePlay, seekBy, setVolume, toggleMute]);

  // Dosya değişince türe özel görünüm/düzenleme durumları sıfırlanır.
  useEffect(() => {
    setImage({ zoom: 1, rotation: 0, flipH: false, flipV: false, bg: 'dark' });
    setEdit({ on: false, draft: '', base: '', size: 11.5, wrap: true, lines: false, saved: false, copied: false });
    setMedia({ playing: false, time: 0, duration: 0, rate: 1, volume: 1, muted: false, loop: false });
    setNote(null);
  }, [item]);

  const requestClose = useCallback(() => {
    if (textDirty && !window.confirm(t('preview.discardQ'))) return;
    onClose();
  }, [textDirty, onClose, t]);

  const copySelection = useCallback(() => {
    const text = window.getSelection()?.toString() ?? '';
    if (!text.trim()) return;
    const done = navigator.clipboard?.writeText(text);
    if (done) void done.catch(() => { /* pano izni yoksa sessizce geç */ });
    window.getSelection()?.removeAllRanges();
  }, []);

  const openMenu = useCallback((x: number, y: number) => {
    const canCopy = !!window.getSelection()?.toString().trim();
    const width = 208;
    const height = 300;
    setMenu({
      x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
      canCopy,
    });
  }, []);

  // Menü dışına tıklama / Esc / kaydırma menüyü kapatır.
  useEffect(() => {
    if (!menu && !zoomMenuAt) return;
    const closeAll = () => { closeMenu(); closeZoomMenu(); };
    const onDown = (e: MouseEvent) => {
      const node = e.target as Node;
      if (menu && menuRef.current?.contains(node)) return;
      if (zoomMenuAt && (zoomMenuRef.current?.contains(node) || zoomBtnRef.current?.contains(node))) return;
      closeAll();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeAll(); };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', closeAll, { passive: true });
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', closeAll);
    };
  }, [menu, zoomMenuAt, closeMenu, closeZoomMenu]);

  const handleViewerPointerDown = (e: React.PointerEvent) => {
    if (item.kind !== 'pdf') return;
    const target = e.target as HTMLElement | null;
    const rightButton = e.button === 2;
    const leftButton = e.button === 0 && !e.altKey;
    if (!rightButton && !leftButton) return;
    closeMenu();
    if (target?.closest?.('.pdf-toolbar, button, a[href], input, textarea, select, [contenteditable="true"]')) return;

    // Sağ tık + dikey sürükle = zoom (sürükleme yoksa menü).
    if (rightButton) {
      const provider = findFileViewerZoomProvider(wrapperRef.current);
      if (!provider?.setZoom) return;
      e.preventDefault();
      panCleanupRef.current?.();
      const zoomRoot = wrapperRef.current;
      const start = { id: e.pointerId, x: e.clientX, y: e.clientY, scale: provider.getState().scale, at: performance.now() };
      const blockMenu = (ev: Event) => ev.preventDefault();
      window.addEventListener('contextmenu', blockMenu, true);
      let frame = 0;
      let queued: number | null = null;
      let dragged = false;
      const flush = () => {
        frame = 0;
        if (queued === null) return;
        const next = queued;
        queued = null;
        void provider.setZoom?.(next);
      };
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== start.id) return;
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        if (!dragged) {
          // Yanlışlıkla zoom olmasın: ilk ~120 ms ve küçük hareketler yok sayılır,
          // ayrıca hareket DİKEY baskın olmalı (tıklama titremesi zoom sayılmaz).
          if (performance.now() - start.at < 120) return;
          if (Math.abs(dy) < 8 || Math.abs(dy) <= Math.abs(dx)) return;
          dragged = true;
          suppressPanClickRef.current = true;
          zoomRoot?.classList.add('fv-zooming');
        }
        const state = provider.getState();
        const min = state.minScale ?? 0.25;
        const max = state.maxScale ?? 3;
        queued = Math.min(max, Math.max(min, start.scale * Math.exp(-dy * 0.006)));
        if (!frame) frame = requestAnimationFrame(flush);
        ev.preventDefault();
      };
      const cleanup = () => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', cleanup, true);
        window.removeEventListener('pointercancel', cleanup, true);
        if (frame) cancelAnimationFrame(frame);
        zoomRoot?.classList.remove('fv-zooming');
        panCleanupRef.current = null;
        // Yerel menü pointerup'tan SONRA gelebilir → kısa süre yut.
        setTimeout(() => window.removeEventListener('contextmenu', blockMenu, true), 350);
        if (!dragged) openMenu(start.x, start.y);
        if (suppressPanClickRef.current) setTimeout(() => { suppressPanClickRef.current = false; }, 0);
      };
      panCleanupRef.current = cleanup;
      window.addEventListener('pointermove', move, { capture: true, passive: false });
      window.addEventListener('pointerup', cleanup, true);
      window.addEventListener('pointercancel', cleanup, true);
      return;
    }

    const scroller = getScroller();
    if (!scroller) return;
    // Seçim yalnızca gerçekten metin varsa anlamlı (taranmış PDF'te katman yok).
    const holdToSelect = leftButton
      && !e.ctrlKey && !e.metaKey
      && !!target?.closest?.('.textLayer span');
    const root = wrapperRef.current;
    const undoDrag = scroller.style.userSelect;
    const start = { id: e.pointerId, x: e.clientX, y: e.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
    let panning = false;
    let holdTimer: number | null = null;

    const beginPan = () => {
      panning = true;
      root?.classList.add('fv-panning');
      scroller.style.userSelect = 'none';
    };
    if (!holdToSelect) {
      e.preventDefault();
      beginPan();
    } else {
      // Basılı tutulursa seçim moduna geçilir (tarayıcı seçimi devralır).
      holdTimer = window.setTimeout(() => {
        holdTimer = null;
        if (!panning) showSelectHint(start.x, start.y);
      }, HOLD_TO_SELECT_MS);
    }

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== start.id) return;
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!panning) {
        if (Math.hypot(dx, dy) < 4) return;
        if (holdTimer === null) {
          // Süre doldu → seçim; kalan işi tarayıcıya bırak.
          cleanup();
          return;
        }
        window.clearTimeout(holdTimer);
        holdTimer = null;
        beginPan();
      }
      if (Math.hypot(dx, dy) >= 3) suppressPanClickRef.current = true;
      scroller.scrollLeft = start.left - dx;
      scroller.scrollTop = start.top - dy;
      // Kaydırırken metin seçimi kalıntısı olmasın.
      window.getSelection()?.removeAllRanges();
      ev.preventDefault();
    };
    const cleanup = () => {
      if (holdTimer !== null) { window.clearTimeout(holdTimer); holdTimer = null; }
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', cleanup, true);
      window.removeEventListener('pointercancel', cleanup, true);
      if (panning) {
        root?.classList.remove('fv-panning');
        scroller.style.userSelect = undoDrag;
      }
      panCleanupRef.current = null;
      if (suppressPanClickRef.current) setTimeout(() => { suppressPanClickRef.current = false; }, 0);
    };
    panCleanupRef.current = cleanup;
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', cleanup, true);
    window.addEventListener('pointercancel', cleanup, true);
  };

  // Sürükleme sonrası oluşan tıklamayı yut (kaydırma bitişinde seçim/aktif
  // öğe değişmesin).
  const handleViewerClickCapture = (e: React.MouseEvent) => {
    if (!suppressPanClickRef.current) return;
    suppressPanClickRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  // Kısayollar (yalnızca imleç/fokus önizlemedeyken, uygulama kısayollarını
  // ezmemek için): Ctrl/⌘ + '+' / '−' zoom, Ctrl/⌘ + 0 genişliğe sığdır.
  useEffect(() => {
    if (item.kind !== 'pdf' || viewMode !== 'viewer') return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const el = wrapperRef.current;
      const focusedInside = !!el && !!document.activeElement && el.contains(document.activeElement);
      if (!hoveringRef.current && !focusedInside) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
      if (e.key === '=' || e.key === '+') { e.preventDefault(); stepZoom(true); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); stepZoom(false); }
      else if (e.key === '0') { e.preventDefault(); void viewerRef.current?.fitToView({ mode: 'width', padding: 12 }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item.kind, viewMode, stepZoom]);

  // Sabit referans: her App render'ında yeni options nesnesi üretilirse
  // @file-viewer `update()` çağırıp PDF'i yeniden yükleyip zoom'u fit
  // ölçeğine (%63) geri döndürüyordu.
  const viewerOptions = useMemo(() => ({
    theme: 'dark' as const,
    // Ctrl/⌘ + tekerlek (ve pinch) ile yakınlaştırma; düz tekerlek kaydırır.
    zoomGestures: { wheel: true, pinch: true },
    // Shadow DOM'u kapat → araç çubuğunu kendi paletimize boyayabilelim.
    styleIsolation: 'none' as const,
    locale: 'tr-TR' as const,
    ui: { density: 'compact' as const, surfaceBackground: '#100F0F' },
    // Üst düzey (web) araç çubuğu KAPALI: çift zoom'u önler; biçime
    // özgü araç çubuğu (ör. PDF sayfa+zoom) tek kontrol yüzeyi olur.
    toolbar: false,
    // PDF: genişliğe sığdır. `until-interaction`: kullanıcı zoom yapana
    // kadar panel boyutunda otomatik sığar; sonrasında zoom korunur.
    ...(item.kind === 'pdf'
      ? { fit: { mode: 'width' as const, resize: 'until-interaction' as const, padding: 12 } }
      : {}),
    // PDF: yan gezinme paneli ve el aracı kapalı.
    // Kaydırma: sol tık sürükle (metinde kısa basılı tut = seçim).
    // Zoom: Ctrl/⌘ + tekerlek, araç çubuğu +/−, sağ tık + dikey sürükle.
    pdf: { navigation: false },
  }), [item.kind]);

  // `inline`: chat düzeni içinde bir SÜTUN olarak render edilir (chat'i örtmez,
  // onu daraltır). Yüzen modda her zaman portal + fixed kullanılır.
  const node = (
    <div
      ref={fv.frameRef}
      style={fv.floating ? fv.style : undefined}
      onPointerEnter={() => { hoveringRef.current = true; }}
      onPointerLeave={() => { hoveringRef.current = false; }}
      className={`bg-obsidian-panel flex flex-col ${
        fv.floating
          ? `relative ${FLOATING_CHROME}`
          : inline
            ? 'relative h-full w-full border-l border-obsidian-border'
            : 'fixed top-0 right-0 h-screen w-[560px] max-w-[94vw] border-l border-obsidian-border shadow-2xl z-[60]'
      }`}
    >
      {/* İçerik native boyutta (keskin) kalır; pencereye göre akar/kaydırılır. */}
      <div style={fv.contentStyle}>
      {note && (
        <div
          className={`pointer-events-none absolute bottom-4 left-1/2 z-50 -translate-x-1/2 max-w-[86%] truncate rounded-md border px-2 py-1 text-[10.5px] shadow-lg ${
            note.error
              ? 'border-rose-500/40 bg-[#2A1A1A]/95 text-rose-300'
              : 'border-obsidian-border bg-[#1C1B1A]/95 text-[#dcb67a]'
          }`}
        >
          {note.text}
        </div>
      )}
      <div
        ref={fv.headerRef}
        onPointerDown={fv.floating ? fv.onDragStart : undefined}
        className={`flex items-center justify-between gap-2 px-3 py-2 border-b border-obsidian-border bg-[#1C1B1A] overflow-hidden whitespace-nowrap flex-shrink-0 ${fv.floating ? 'cursor-move' : ''}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <FileCode size={14} className="text-obsidian-muted flex-shrink-0" />
          <span className="min-w-0 text-[12px] font-semibold text-obsidian-text truncate" title={item.name}>{item.name}</span>
          {item.size && <span className="text-[11px] text-obsidian-muted font-mono flex-shrink-0">{item.size}</span>}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 whitespace-nowrap">
          <button
            type="button"
            onClick={() => triggerDownload(item.name, item.url, item.buffer, edit.on ? edit.draft : item.body)}
            className="flex items-center gap-1 rounded-md border border-obsidian-border px-2 py-1 text-[11px] text-obsidian-muted hover:text-obsidian-text hover:border-[#dcb67a]/50 cursor-pointer transition-colors"
            title={t('preview.download')}
          >
            <Download size={12} /> {t('preview.download')}
          </button>
          <button
            type="button"
            onClick={() => openInWindow(item)}
            className="p-1 rounded cursor-pointer text-obsidian-muted hover:text-obsidian-text transition-colors"
            title={t('preview.openExternal')}
          >
            <ExternalLink size={15} />
          </button>
          <button
            type="button"
            onClick={fv.toggle}
            className={`p-1 rounded cursor-pointer transition-colors ${fv.floating ? 'text-[#4385BE] bg-[#4385BE]/15' : 'text-obsidian-muted hover:text-obsidian-text'}`}
            title={fv.floating ? t('float.dock') : t('float.undock')}
          >
            <PictureInPicture2 size={15} />
          </button>
          <button type="button" onClick={requestClose} className="text-obsidian-muted hover:text-obsidian-text cursor-pointer p-1" title={t('common.close')}>
            <X size={15} />
          </button>
        </div>
      </div>

      {/* PDF kontrol şeridi: sayfa · zoom · sığdır · döndür.
          Kütüphanenin kendi toolbar'ı CSS ile gizli. */}
      {viewMode === 'viewer' && item.kind === 'pdf' && (
        <PdfBar
          page={pdfView.page}
          pageCount={pdfView.pageCount}
          scale={pdfView.scale}
          rotation={pdfView.rotation}
          zoomMenuOpen={!!zoomMenuAt}
          zoomBtnRef={zoomBtnRef}
          onGoTo={goToPage}
          onStepZoom={(dir) => stepZoom(dir === 1)}
          onToggleZoomMenu={toggleZoomMenu}
          onFit={fitToWidth}
          onRotate={rotateViewer}
        />
      )}

      {viewMode === 'viewer' && item.kind !== 'pdf' && viewerZoom.has && (
        <ViewerBar
          scale={viewerZoom.scale}
          onZoom={viewerZoomStep}
          onReset={viewerZoomReset}
          onFitWidth={() => fitViewer('width')}
          onFitPage={() => fitViewer('contain')}
        />
      )}

      {(viewMode === 'video' || viewMode === 'audio') && (
        <MediaBar
          kind={viewMode}
          state={media}
          onToggle={togglePlay}
          onSeekBy={seekBy}
          onScrub={scrubTo}
          onRate={cycleRate}
          onVolume={setVolume}
          onMute={toggleMute}
          onLoop={toggleLoop}
          onFrame={stepFrame}
          onCapture={captureFrame}
          onPip={togglePip}
          onFullscreen={toggleFullscreen}
        />
      )}

      {viewMode === 'image' && (
        <ImageBar
          zoom={image.zoom}
          state={image}
          onZoom={stepImageZoom}
          onRotate={rotateImage}
          onFlip={flipImage}
          onReset={resetImage}
          onBg={toggleImageBg}
        />
      )}

      {viewMode === 'text' && (
        <TextBar
          editing={edit.on}
          dirty={textDirty}
          saved={edit.saved}
          size={edit.size}
          wrap={edit.wrap}
          lines={edit.lines}
          canEdit={item.body !== undefined}
          copied={edit.copied}
          onEdit={toggleEdit}
          onSave={() => void saveText()}
          onSize={stepFont}
          onWrap={() => setEdit((p) => ({ ...p, wrap: !p.wrap }))}
          onLines={() => setEdit((p) => ({ ...p, lines: !p.lines }))}
          onCopyAll={copyAllText}
        />
      )}

      <div className={`flex-1 min-h-0 ${viewMode === 'viewer' || viewMode === 'text' || viewMode === 'image' ? 'overflow-hidden' : 'overflow-auto pretty-scrollbar'}`}>
        {viewMode === 'image' ? (
          <div
            className="h-full w-full overflow-auto pretty-scrollbar p-3"
            style={{
              background: image.bg === 'checker'
                ? 'repeating-conic-gradient(#2A2927 0% 25%, #1C1B1A 0% 50%) 50% / 18px 18px'
                : '#100F0F',
            }}
            onWheel={(e) => {
              if (!(e.ctrlKey || e.metaKey)) return;
              e.preventDefault();
              stepImageZoom(e.deltaY < 0 ? 1 : -1);
            }}
          >
            <div className="flex min-h-full w-full items-center justify-center">
              <img
                src={item.url}
                alt={item.name}
                draggable={false}
                className="max-w-none rounded-md border border-obsidian-border"
                onError={() => showNote(t('preview.imageFailed'), true)}
                style={{
                  zoom: image.zoom,
                  transform: `rotate(${image.rotation}deg) scaleX(${image.flipH ? -1 : 1}) scaleY(${image.flipV ? -1 : 1})`,
                }}
              />
            </div>
          </div>
        ) : viewMode === 'video' ? (
          <div className="p-3">
            <video
              ref={videoRef}
              src={item.url}
              playsInline
              preload="metadata"
              onClick={togglePlay}
              onDoubleClick={toggleFullscreen}
              onError={() => showNote(t('preview.mediaFailed'), true)}
              className="w-full rounded-md border border-obsidian-border bg-black cursor-pointer"
            />
          </div>
        ) : viewMode === 'audio' ? (
          <div className="p-3">
            <audio
              ref={audioRef}
              src={item.url}
              preload="metadata"
              onError={() => showNote(t('preview.mediaFailed'), true)}
              className="w-full"
            />
          </div>
        ) : viewMode === 'text' ? (
          <div
            className="h-full"
            onWheel={(e) => {
              if (!(e.ctrlKey || e.metaKey)) return;
              e.preventDefault();
              stepFont(e.deltaY < 0 ? 1 : -1);
            }}
          >
          {edit.on ? (
            <textarea
              value={edit.draft}
              spellCheck={false}
              onChange={(e) => setEdit((p) => ({ ...p, draft: e.target.value, saved: false }))}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void saveText(); }
              }}
              className="h-full w-full resize-none bg-[#100F0F] p-3 font-mono text-obsidian-text outline-none"
              style={{
                fontSize: edit.size,
                lineHeight: 1.6,
                whiteSpace: edit.wrap ? 'pre-wrap' : 'pre',
                overflowWrap: edit.wrap ? 'anywhere' : 'normal',
              }}
            />
          ) : (
            <div className="h-full overflow-auto pretty-scrollbar">
              <div className="flex min-h-full">
                {edit.lines && (
                  <pre
                    aria-hidden
                    className="select-none py-3 pl-3 pr-2 text-right font-mono text-obsidian-muted/40"
                    style={{ fontSize: edit.size, lineHeight: 1.6 }}
                  >
                    {(item.body ?? '').split('\n').map((_, i) => i + 1).join('\n')}
                  </pre>
                )}
                <pre
                  className="flex-1 p-3 font-mono text-obsidian-text"
                  style={{
                    fontSize: edit.size,
                    lineHeight: 1.6,
                    whiteSpace: edit.wrap ? 'pre-wrap' : 'pre',
                    overflowWrap: edit.wrap ? 'anywhere' : 'normal',
                  }}
                >
                  {item.body}
                </pre>
              </div>
            </div>
          )}
          </div>
        ) : viewMode === 'viewer' ? (
            <div
              ref={wrapperRef}
              className="fv-themed"
              style={{ width: fv.floating ? '100%' : (contentWidth ?? '100%'), height: '100%' }}
              onClickCapture={handleViewerClickCapture}
              onPointerDown={handleViewerPointerDown}
              onPointerEnter={() => { hoveringRef.current = true; }}
              onPointerLeave={() => { hoveringRef.current = false; }}
            >
            {/* @file-viewer araç çubuğunu uygulama paletine çek (mavi/kalabalık
                varsayılan görünümü sadeleştirir). styleIsolation:'none' gerekir. */}
            <style>{`
              .fv-themed .file-viewer-web-shell, .fv-themed .file-viewer-web-content { background: #100F0F !important; }
              .fv-themed .file-viewer-web-toolbar {
                background: #1C1B1A !important; border-bottom: 1px solid #34332F !important;
                padding: 4px 6px !important; gap: 4px !important; min-height: 0 !important;
                position: sticky; top: 0; z-index: 5;
              }
              .fv-themed .file-viewer-web-toolbar-group { background: transparent !important; border: 0 !important; gap: 2px !important; }
              .fv-themed .file-viewer-web-icon-button {
                border-radius: 6px !important; color: #87857F !important; background: transparent !important;
              }
              .fv-themed .file-viewer-web-icon-button:hover { background: #282726 !important; color: #F2F0E5 !important; }
              .fv-themed .file-viewer-web-icon-button[aria-pressed="true"],
              .fv-themed .file-viewer-web-icon-button[data-active="true"] { background: rgba(220,182,122,0.14) !important; color: #dcb67a !important; }
              .fv-themed .file-viewer-web-zoom-meter { color: #A8A49E !important; font-family: ui-monospace, monospace !important; }
              /* Kütüphanenin PDF araç çubuğu tamamen gizli: kontrolleri
                 kendimiz çiziyoruz (drawer başlığının altındaki şerit). */
              .fv-themed .pdf-toolbar { display: none !important; }
              .fv-themed .pdf-content, .fv-themed .pdf-viewport, .fv-themed .pdf-wrapper, .fv-themed .pdfViewer { background: #100F0F !important; }
              /* PDF kendi içinde kaydırır; kaydırma çubuklarını tutulabilir
                 ve tema uyumlu yap (dış yeşil çubuk artık gizli). */
              .fv-themed .pdf-wrapper { scrollbar-width: thin; scrollbar-color: #3F3D39 transparent; cursor: grab; }
              .fv-themed .pdf-wrapper::-webkit-scrollbar { width: 10px; height: 10px; }
              .fv-themed .pdf-wrapper::-webkit-scrollbar-track { background: transparent; }
              .fv-themed .pdf-wrapper::-webkit-scrollbar-thumb {
                background: #3F3D39; border-radius: 6px; border: 2px solid #100F0F;
              }
              .fv-themed .pdf-wrapper::-webkit-scrollbar-thumb:hover { background: #56534D; }
              .fv-themed .pdf-wrapper::-webkit-scrollbar-corner { background: #100F0F; }
              /* Sürükleyerek kaydırırken tut-çek imleci (metin katmanı dahil). */
              .fv-themed.fv-panning .pdf-wrapper,
              .fv-themed.fv-panning .pdf-wrapper * { cursor: grabbing !important; }
              /* Sağ tık + dikey sürükle = zoom. */
              .fv-themed.fv-zooming .pdf-wrapper,
              .fv-themed.fv-zooming .pdf-wrapper * { cursor: ns-resize !important; }
            `}</style>
            <FileViewer
              ref={viewerRef}
              url={viewerUrl}
              filename={item.name}
              options={viewerOptions}
              style={{ width: '100%', height: '100%' }}
            />
            </div>
        ) : (
          <p className="p-4 text-[12px] text-obsidian-muted leading-relaxed">
            {item.kind === 'large' ? t('composer.previewTooLarge') : t('composer.previewBinary')}
          </p>
        )}
      </div>
      </div>

      {fv.floating && <FloatResizeHandle onPointerDown={fv.onResizeStart} />}
    </div>
  );

  // Kompakt sağ tık menüsü (PDF): hızlı zoom/sığdırma, döndürme, kopyalama.
  const menuNode = menu ? createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-[90] w-52 rounded-lg border border-obsidian-border bg-[#1C1B1A] p-1 shadow-2xl text-[12px] text-obsidian-text"
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuItem label={t('preview.fitWidth')} hint="Ctrl+0" onClick={() => { closeMenu(); void viewerRef.current?.fitToView({ mode: 'width', padding: 12 }); }} />
      <MenuItem label={t('preview.fitPage')} onClick={() => { closeMenu(); void viewerRef.current?.fitToView({ mode: 'contain', padding: 12 }); }} />
      <MenuItem label={t('preview.zoomActual')} onClick={() => { closeMenu(); zoomTo(1); }} />
      <div className="my-1 h-px bg-obsidian-border" />
      <MenuItem label={t('preview.zoomIn')} hint="Ctrl +" onClick={() => { closeMenu(); stepZoom(true); }} />
      <MenuItem label={t('preview.zoomOut')} hint="Ctrl −" onClick={() => { closeMenu(); stepZoom(false); }} />
      <div className="my-1 h-px bg-obsidian-border" />
      <MenuItem label={t('preview.rotate')} onClick={() => { closeMenu(); rotateViewer(); }} />
      <MenuItem label={t('preview.copyText')} disabled={!menu.canCopy} onClick={() => { closeMenu(); copySelection(); }} />
      <div className="my-1 h-px bg-obsidian-border" />
      <MenuItem label={t('preview.download')} onClick={() => { closeMenu(); triggerDownload(item.name, item.url, item.buffer, edit.on ? edit.draft : item.body); }} />
      <MenuItem label={t('preview.openExternal')} onClick={() => { closeMenu(); openInWindow(item); }} />
    </div>,
    document.body,
  ) : null;

  // Yüzde düğmesinin açılır zoom menüsü (şeridin altına hizalanır).
  const zoomMenuNode = zoomMenuAt ? createPortal(
    <div
      ref={zoomMenuRef}
      role="menu"
      className="fixed z-[90] w-48 rounded-lg border border-obsidian-border bg-[#1C1B1A] p-1 shadow-2xl text-[12px] text-obsidian-text"
      style={{ left: zoomMenuAt.x, top: zoomMenuAt.y }}
    >
      <MenuItem label={t('preview.fitWidth')} hint="Ctrl+0" onClick={() => { closeZoomMenu(); fitToWidth(); }} />
      <MenuItem label={t('preview.fitPage')} onClick={() => { closeZoomMenu(); void viewerRef.current?.fitToView({ mode: 'contain', padding: 12 }); }} />
      <MenuItem label={t('preview.zoomActual')} onClick={() => { closeZoomMenu(); zoomTo(1); }} />
      <div className="my-1 h-px bg-obsidian-border" />
      {[0.5, 0.75, 1.25, 1.5, 2].map((s) => (
        <MenuItem
          key={s}
          label={`${Math.round(s * 100)}%`}
          active={Math.abs(pdfView.scale - s) < 0.01}
          onClick={() => { closeZoomMenu(); zoomTo(s); }}
        />
      ))}
    </div>,
    document.body,
  ) : null;

  // "Basılı tut = metin seçimi" ipucu (imlecin yanında, kısa süreliğine).
  const hintNode = hint ? createPortal(
    <div
      className="pointer-events-none fixed z-[95] rounded-md border border-obsidian-border bg-[#1C1B1A]/95 px-2 py-1 text-[10.5px] text-[#dcb67a] shadow-lg"
      style={{ left: hint.x, top: hint.y }}
    >
      {t('preview.selectHint')}
    </div>,
    document.body,
  ) : null;

  // Inline + docked: bulunduğu sütunda kalır (portal yok). Aksi halde viewport'a
  // sabitlenmek için portal kullanılır.
  if (inline && !fv.floating) return <>{node}{menuNode}{zoomMenuNode}{hintNode}</>;
  return <>{createPortal(node, document.body)}{menuNode}{zoomMenuNode}{hintNode}</>;
}
