import React, { useCallback, useEffect, useRef, useState } from 'react';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Persisted extends Rect {
  floating: boolean;
}

const KEY = (id: string) => `tlm_float_v3_${id}`;

function load(id: string, def: Rect): Persisted {
  if (typeof localStorage === 'undefined') return { floating: false, ...def };
  try {
    const raw = localStorage.getItem(KEY(id));
    if (!raw) return { floating: false, ...def };
    const p = JSON.parse(raw) as Partial<Persisted>;
    return {
      floating: !!p.floating,
      x: typeof p.x === 'number' ? p.x : def.x,
      y: typeof p.y === 'number' ? p.y : def.y,
      w: typeof p.w === 'number' ? p.w : def.w,
      h: typeof p.h === 'number' ? p.h : def.h,
    };
  } catch {
    return { floating: false, ...def };
  }
}

function clampRect(r: Rect, min: { w: number; h: number }): Rect {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const w = Math.max(min.w, Math.min(r.w, vw));
  const h = Math.max(min.h, Math.min(r.h, vh));
  const x = Math.max(0, Math.min(r.x, Math.max(0, vw - w)));
  const y = Math.max(0, Math.min(r.y, Math.max(0, vh - h)));
  return { x, y, w, h };
}

/**
 * Shared window chrome for a floating panel. Panels render their content at
 * native size (no scaling → crisp text/canvas); the layout reflows to the
 * window and the frame keeps its own background.
 */
export const FLOATING_CHROME = 'flex flex-col rounded-lg border border-obsidian-raise shadow-2xl overflow-hidden';

export interface UseFloating {
  floating: boolean;
  toggle: () => void;
  setFloating: (v: boolean) => void;
  rect: Rect;
  /** Attach to the floating frame element (position/size target). */
  frameRef: React.RefObject<HTMLDivElement | null>;
  /** Attach to the panel header — used to measure its unbreakable width. */
  headerRef: React.RefObject<HTMLDivElement | null>;
  /** Raise the minimum width so the header never gets clipped/overlapped. */
  setMinWidth: (px: number) => void;
  /** Inline style for the panel container while floating (undefined when docked). */
  style: React.CSSProperties | undefined;
  /** No-op wrapper style: lets the frame's children be flex items in both modes. */
  contentStyle: React.CSSProperties;
  /** Attach to a panel header to drag the window around. */
  onDragStart: (e: React.PointerEvent) => void;
  /** Attach to a corner handle to resize the window. */
  onResizeStart: (e: React.PointerEvent) => void;
}

/**
 * Watches a header element and reports the width below which its (single-line,
 * non-shrinkable) content would overflow. Used as the floating window's minimum
 * width so controls neither overlap nor disappear.
 */
export function useAutoMinWidth(
  ref: React.RefObject<HTMLElement | null>,
  setMinWidth: (px: number) => void,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const check = () => {
      if (el.scrollWidth > el.clientWidth) setMinWidth(el.scrollWidth + 4);
    };
    const ro = new ResizeObserver(check);
    ro.observe(el);
    check();
    return () => ro.disconnect();
  }, [ref, setMinWidth]);
}

/**
 * Turns a docked panel into an in-app floating window: draggable by its header,
 * freely resizable from the corner, position/size remembered in localStorage.
 * The content is never CSS-scaled — it stays at native resolution (sharp) and
 * reflows/clips to the window; a minimum size keeps it usable. The panel
 * container stays mounted (same tree position) so live content (terminal PTY,
 * chat history) is never destroyed when docking/undocking.
 */
export function useFloatingPanel(
  id: string,
  opts: { def: Rect; min?: { w: number; h: number }; alwaysFloating?: boolean },
): UseFloating {
  const minH = opts.min?.h ?? 160;
  const initRef = useRef<Persisted | null>(null);
  if (initRef.current === null) initRef.current = load(id, opts.def);
  const init = initRef.current;

  const [floating, setFloating] = useState(opts.alwaysFloating ? true : init.floating);
  const [rect, setRect] = useState<Rect>({ x: init.x, y: init.y, w: init.w, h: init.h });
  const [minW, setMinW] = useState<number>(opts.min?.w ?? 260);
  const minWRef = useRef(minW);
  const headerRef = useRef<HTMLDivElement | null>(null);

  // Raise the floor (never lower it): the window can only shrink down to the
  // width its header needs, so nothing gets clipped or overlapped.
  const setMinWidth = useCallback((px: number) => {
    const target = Math.ceil(px);
    if (target <= minWRef.current) return;
    minWRef.current = target;
    setMinW(target);
    setRect((r) => (r.w < target ? { ...r, w: target } : r));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(KEY(id), JSON.stringify({ floating, ...rect }));
    } catch { /* noop */ }
  }, [id, floating, rect]);

  useEffect(() => {
    if (!floating) return;
    const onWinResize = () => setRect((r) => clampRect(r, { w: minW, h: minH }));
    window.addEventListener('resize', onWinResize);
    onWinResize();
    return () => window.removeEventListener('resize', onWinResize);
  }, [floating, minW, minH]);

  // Imperative, jank-free gestures: during drag/resize we mutate the frame's
  // inline styles directly (coalesced via requestAnimationFrame) so the heavy
  // panel tree never re-renders per pointermove; React state commits on release.
  const frameRef = useRef<HTMLDivElement | null>(null);

  const onDragStart = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Let header buttons (dock/close/save) handle their own clicks.
    if ((e.target as HTMLElement).closest('button,input,a,select,textarea')) return;
    const cur = rect;
    const s = { sx: e.clientX, sy: e.clientY, ox: cur.x, oy: cur.y, w: cur.w, h: cur.h };
    let nx = cur.x;
    let ny = cur.y;
    let raf = 0;
    e.preventDefault();
    document.body.style.userSelect = 'none';
    const apply = () => {
      raf = 0;
      const el = frameRef.current;
      if (el) { el.style.left = `${nx}px`; el.style.top = `${ny}px`; }
    };
    const move = (ev: PointerEvent) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      nx = Math.max(0, Math.min(s.ox + ev.clientX - s.sx, Math.max(0, vw - s.w)));
      ny = Math.max(0, Math.min(s.oy + ev.clientY - s.sy, Math.max(0, vh - s.h)));
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const up = () => {
      if (raf) cancelAnimationFrame(raf);
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setRect((r) => ({ ...r, x: nx, y: ny }));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [rect]);

  const onResizeStart = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const cur = rect;
    const s = { sx: e.clientX, sy: e.clientY, ow: cur.w, oh: cur.h, x: cur.x, y: cur.y };
    let nw = cur.w;
    let nh = cur.h;
    let raf = 0;
    e.preventDefault();
    e.stopPropagation();
    document.body.style.userSelect = 'none';
    const apply = () => {
      raf = 0;
      const el = frameRef.current;
      if (el) { el.style.width = `${nw}px`; el.style.height = `${nh}px`; }
    };
    const move = (ev: PointerEvent) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      nw = Math.max(minWRef.current, Math.min(s.ow + ev.clientX - s.sx, vw - s.x));
      nh = Math.max(minH, Math.min(s.oh + ev.clientY - s.sy, vh - s.y));
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const up = () => {
      if (raf) cancelAnimationFrame(raf);
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setRect((r) => ({ ...r, w: nw, h: nh }));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [rect, minH]);

  const toggle = useCallback(() => setFloating((v) => !v), []);

  const style: React.CSSProperties | undefined = floating
    ? { position: 'fixed', left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: 70 }
    : undefined;

  return {
    floating,
    toggle,
    setFloating,
    rect,
    frameRef,
    headerRef,
    setMinWidth,
    style,
    contentStyle: { display: 'contents' },
    onDragStart,
    onResizeStart,
  };
}

/** Corner grip that resizes a floating panel. */
export function FloatResizeHandle({ onPointerDown }: { onPointerDown: (e: React.PointerEvent) => void }) {
  return (
    <div
      onPointerDown={onPointerDown}
      className="absolute bottom-0 right-0 z-30 h-4 w-4 cursor-nwse-resize"
      aria-hidden="true"
    >
      <div className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5 border-b-2 border-r-2 border-[#87857F]/60" />
    </div>
  );
}
