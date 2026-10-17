import React, { useState, useRef, useEffect } from 'react';
import {
  FileText,
  Check,
  X,
  Maximize2,
  Minimize2,
  CheckCircle2,
  HelpCircle
} from 'lucide-react';
import type { ActionPayload, Message } from './ThalamusCopilot';
import { computeLineDiff, diffStats } from '../lib/diff';

type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface CopilotDiffModalProps {
  /** Action message to inspect (the component is not rendered at all without `actionPayload`). */
  message: Message;
  /** Whether this action was already applied (the "Applied" badge). */
  executed: boolean;
  /** Active file name shown in the diff headers. */
  activeFile: string;
  /** Called when "Apply to Code" is clicked; applying + closing happens in the parent component. */
  onApply: (payload: ActionPayload) => void;
  onClose: () => void;
}

/**
 * Code inspection modal: a draggable, edge-resizable, fullscreen-capable
 * diff/summary window. Dragging is written to the DOM via rAF;
 * React only re-renders the max/banner state.
 */
export function CopilotDiffModal({
  message,
  executed,
  activeFile,
  onApply,
  onClose,
}: CopilotDiffModalProps) {
  const [isMaximized, setIsMaximized] = useState<boolean>(false);
  const [isBannerVisible, setIsBannerVisible] = useState<boolean>(true);

  const modalRef = useRef<HTMLDivElement>(null);
  const posRef = useRef<{ x: number; y: number }>({ x: 100, y: 60 });
  const sizeRef = useRef<{ width: number; height: number }>({ width: 780, height: 560 });

  const isDraggingRef = useRef<boolean>(false);
  const activeHandleRef = useRef<ResizeHandle | null>(null);

  const dragStartRef = useRef<{ x: number; y: number; initialX: number; initialY: number }>({
    x: 0, y: 0, initialX: 100, initialY: 60
  });

  const resizeStartRef = useRef<{
    x: number; y: number; initialW: number; initialH: number; initialX: number; initialY: number
  }>({
    x: 0, y: 0, initialW: 780, initialH: 560, initialX: 100, initialY: 60
  });

  const rafIdRef = useRef<number | null>(null);
  const pendingUpdateRef = useRef<{ x?: number; y?: number; w?: number; h?: number } | null>(null);

  useEffect(() => {
    const updateModalDOM = () => {
      if (pendingUpdateRef.current && modalRef.current && !isMaximized) {
        const { x, y, w, h } = pendingUpdateRef.current;
        if (x !== undefined && y !== undefined) {
          modalRef.current.style.transform = `translate3d(${x}px, ${y}px, 0px)`;
        }
        if (w !== undefined) modalRef.current.style.width = `${w}px`;
        if (h !== undefined) modalRef.current.style.height = `${h}px`;
      }
      rafIdRef.current = null;
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (isMaximized) return;

      if (isDraggingRef.current) {
        const dx = e.clientX - dragStartRef.current.x;
        const dy = e.clientY - dragStartRef.current.y;

        const newX = Math.max(10, Math.min(window.innerWidth - 250, dragStartRef.current.initialX + dx));
        const newY = Math.max(10, Math.min(window.innerHeight - 150, dragStartRef.current.initialY + dy));

        posRef.current = { x: newX, y: newY };
        pendingUpdateRef.current = { x: newX, y: newY, w: sizeRef.current.width, h: sizeRef.current.height };
      }

      if (activeHandleRef.current) {
        const handle = activeHandleRef.current;
        const dx = e.clientX - resizeStartRef.current.x;
        const dy = e.clientY - resizeStartRef.current.y;

        let newW = resizeStartRef.current.initialW;
        let newH = resizeStartRef.current.initialH;
        let newX = resizeStartRef.current.initialX;
        let newY = resizeStartRef.current.initialY;

        const MIN_W = 600;
        const MAX_W = Math.min(window.innerWidth * 0.9, 1200);
        const MIN_H = 440;
        const MAX_H = Math.min(window.innerHeight * 0.85, 800);

        if (handle.includes('e')) newW = Math.max(MIN_W, Math.min(MAX_W, resizeStartRef.current.initialW + dx));
        if (handle.includes('s')) newH = Math.max(MIN_H, Math.min(MAX_H, resizeStartRef.current.initialH + dy));
        if (handle.includes('w')) {
          const calcW = resizeStartRef.current.initialW - dx;
          if (calcW >= MIN_W && calcW <= MAX_W) {
            newW = calcW;
            newX = resizeStartRef.current.initialX + dx;
          }
        }
        if (handle.includes('n')) {
          const calcH = resizeStartRef.current.initialH - dy;
          if (calcH >= MIN_H && calcH <= MAX_H) {
            newH = calcH;
            newY = resizeStartRef.current.initialY + dy;
          }
        }

        sizeRef.current = { width: newW, height: newH };
        posRef.current = { x: newX, y: newY };

        pendingUpdateRef.current = { x: newX, y: newY, w: newW, h: newH };
      }

      if ((isDraggingRef.current || activeHandleRef.current) && rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(updateModalDOM);
      }
    };

    const handleMouseUp = () => {
      if (isDraggingRef.current || activeHandleRef.current) {
        isDraggingRef.current = false;
        activeHandleRef.current = null;
        document.body.style.userSelect = 'auto';
        document.body.style.cursor = 'default';
        if (rafIdRef.current !== null) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
      }
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [isMaximized]);

  const payload = message.actionPayload;
  if (!payload) return null;

  const handleStartDragModal = (e: React.MouseEvent) => {
    if (isMaximized) return;
    isDraggingRef.current = true;
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      initialX: posRef.current.x,
      initialY: posRef.current.y
    };
    document.body.style.userSelect = 'none';
  };

  const handleStartResizeModal = (e: React.MouseEvent, handle: ResizeHandle) => {
    e.stopPropagation();
    if (isMaximized) return;
    activeHandleRef.current = handle;
    resizeStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      initialW: sizeRef.current.width,
      initialH: sizeRef.current.height,
      initialX: posRef.current.x,
      initialY: posRef.current.y
    };
    document.body.style.userSelect = 'none';
  };

  const orig = payload.originalCodeSnippet || "";
  const opt = payload.codeSnippet || "";
  // Gerçek satır difi: uydurma token tahminleri yok; yalnızca LCS sonucu.
  const lines = computeLineDiff(orig, opt);
  const stats = diffStats(lines);

  return (
    <div
      ref={modalRef}
      style={{
        transform: isMaximized ? 'none' : `translate3d(${posRef.current.x}px, ${posRef.current.y}px, 0px)`,
        width: isMaximized ? 'auto' : `${sizeRef.current.width}px`,
        height: isMaximized ? 'auto' : `${sizeRef.current.height}px`,
        willChange: 'transform, width, height'
      }}
      className={`fixed z-50 bg-ink border border-surface shadow-2xl flex flex-col font-mono text-fg ${
        isMaximized
          ? 'inset-2 w-[calc(100%-16px)] h-[calc(100%-16px)] rounded-lg overflow-hidden'
          : 'top-0 left-0 rounded-lg overflow-hidden'
      }`}
    >
      {/* TOP HEADER BAR */}
      <div
        onMouseDown={handleStartDragModal}
        className="px-3.5 py-2 bg-panel border-b border-surface flex items-center justify-between cursor-move select-none flex-shrink-0"
      >
        <div className="flex items-center gap-2 text-[11px]">
          <FileText size={14} className="text-fg-faint" />
          <span className="font-semibold text-fg-soft">
            {payload.targetFile}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-2 text-[11px]">
            <span className="text-danger bg-surface border border-line px-2 py-0.5 rounded font-mono">
              -{stats.removed}
            </span>
            <span className="text-aqua bg-surface border border-line px-2 py-0.5 rounded font-mono">
              +{stats.added}
            </span>
          </div>

          {/* HINT ICON AND VERTICAL LINE */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 border-r border-line pr-2">
              <button
                type="button"
                onClick={() => setIsBannerVisible(!isBannerVisible)}
                className={`p-1 rounded hover:bg-surface cursor-pointer transition-colors flex items-center justify-center ${
                  isBannerVisible ? 'text-accent' : 'text-fg-muted hover:text-white'
                }`}
                title="Toggle Help Banner"
              >
                <HelpCircle size={15} />
              </button>
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setIsMaximized(!isMaximized)}
                className="text-fg-muted hover:text-white p-1 rounded hover:bg-surface cursor-pointer transition-colors"
                title={isMaximized ? "Switch to Windowed" : "Toggle Fullscreen"}
              >
                {isMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="text-fg-muted hover:text-white p-1 rounded hover:bg-surface cursor-pointer transition-colors"
                title="Close"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* SECTION 1: WINDOW MODE */}
      {!isMaximized ? (
        <div className="flex-1 flex flex-col min-h-0 bg-ink relative">

          {payload.originalCodeSnippet && payload.codeSnippet ? (
            <div className="flex-1 flex flex-col min-h-0 bg-ink">
              <div className="px-4 pt-3 pb-1 text-[11px] text-fg-muted font-bold uppercase border-b border-surface">
                Suggested change — {activeFile} · <span className="text-aqua">+{stats.added}</span> <span className="text-danger">-{stats.removed}</span>
              </div>
              <div className="flex-1 overflow-auto pretty-scrollbar p-0 font-mono text-[11px] leading-[1.55]">
                {lines.map((l, idx) => (
                  <div
                    key={idx}
                    className={`flex ${
                      l.type === 'removed' ? 'bg-[#3b181a]/50 border-l-2 border-danger'
                      : l.type === 'added' ? 'bg-[#1e2f22]/60 border-l-2 border-aqua'
                      : 'border-l-2 border-transparent'
                    }`}
                  >
                    <span className="w-10 flex-shrink-0 text-right pr-2 text-fg-dim select-none">
                      {l.type === 'removed' ? '-' : l.type === 'added' ? '+' : ' '}
                    </span>
                    <span className="whitespace-pre-wrap break-all pr-3">
                      {l.text || ' '}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-auto p-4 text-[11.5px] leading-[1.7] pretty-scrollbar font-mono whitespace-pre-wrap text-fg-soft">
              {message.text}
            </div>
          )}

          {/* Bottom Bar (Footer) */}
          <div className="px-3.5 py-2 bg-panel border-t border-surface flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-fg-muted bg-surface border border-line px-2.5 py-0.5 rounded font-mono">
                {stats.changed} Lines Changed
              </span>
              {opt.length > 0 && (
                <span className="text-fg-muted bg-surface border border-line px-2.5 py-0.5 rounded font-mono">
                  {opt.length} B
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {executed ? (
                <span className="text-aqua text-[11px] font-medium flex items-center gap-1 px-2.5 py-0.5 bg-[#1e3a2b]/60 border border-[#2d5a45]/50 rounded font-sans">
                  <Check size={12} /> Applied to Code
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onApply(payload)}
                  className="px-2.5 py-0.5 bg-surface hover:bg-line border border-line text-fg-muted hover:text-white font-medium rounded text-[11px] flex items-center gap-1.5 cursor-pointer transition-colors font-sans shadow-sm"
                >
                  <CheckCircle2 size={13} className="text-accent" /> Apply to Code
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* SECTION 2: FULLSCREEN MODE */
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-ink">

          {/* Deciding unified diff (fullscreen) */}
          <div className="flex-1 flex flex-col min-h-0 bg-ink">
            <div className="px-3 py-2 bg-panel text-fg-muted text-[11px] border-b border-surface flex items-center justify-between flex-shrink-0">
              <span className="font-semibold text-fg-soft flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-aqua" />
                Suggested change — {payload.targetFile}
              </span>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-danger bg-[#3b181a]/40 border border-[#824449]/30 px-2 py-0.5 rounded font-mono">-{stats.removed}</span>
                <span className="text-aqua bg-[#1e3a2b]/40 border border-[#2d5a45]/30 px-2 py-0.5 rounded font-mono">+{stats.added}</span>
                <span className="text-fg-muted bg-surface border border-line px-2 py-0.5 rounded font-mono">{orig.length} B → {opt.length} B</span>
              </div>
            </div>
            <div className="flex-1 overflow-auto pretty-scrollbar font-mono text-[11.5px] leading-[1.55]">
              {lines.map((l, idx) => (
                <div
                  key={idx}
                  className={`flex ${
                    l.type === 'removed' ? 'bg-[#3b181a]/50 border-l-2 border-danger'
                      : l.type === 'added' ? 'bg-[#1e2f22]/60 border-l-2 border-aqua'
                      : 'border-l-2 border-transparent'
                  }`}
                >
                  <span className="w-10 flex-shrink-0 text-right pr-2 text-fg-dim select-none">
                    {l.type === 'removed' ? '-' : l.type === 'added' ? '+' : ' '}
                  </span>
                  <span className="whitespace-pre-wrap break-all pr-3">{l.text || ' '}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Bottom Buttons (Fullscreen Mode Footer) */}
          <div className="px-3.5 py-2 bg-panel border-t border-surface flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-fg-muted bg-surface border border-line px-2.5 py-0.5 rounded font-mono">
                {stats.changed} Lines Changed
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onApply(payload)}
                className="px-2.5 py-0.5 bg-surface hover:bg-line border border-line text-fg-muted hover:text-white font-medium rounded text-[11px] flex items-center gap-1.5 cursor-pointer transition-colors font-sans shadow-sm"
              >
                <CheckCircle2 size={13} className="text-accent" /> Apply to Code
              </button>
            </div>
          </div>

        </div>
      )}

      {/* Resizer handles */}
      {!isMaximized && (
        <>
          <div onMouseDown={(e) => handleStartResizeModal(e, 'n')} className="absolute -top-1 left-2 right-2 h-2 cursor-n-resize z-20" />
          <div onMouseDown={(e) => handleStartResizeModal(e, 's')} className="absolute -bottom-1 left-2 right-2 h-2 cursor-s-resize z-20" />
          <div onMouseDown={(e) => handleStartResizeModal(e, 'e')} className="absolute top-2 -right-1 bottom-2 w-2 cursor-e-resize z-20" />
          <div onMouseDown={(e) => handleStartResizeModal(e, 'w')} className="absolute top-2 -left-1 bottom-2 w-2 cursor-w-resize z-20" />
          <div onMouseDown={(e) => handleStartResizeModal(e, 'ne')} className="absolute -top-1 -right-1 w-3.5 h-3.5 cursor-ne-resize z-30" />
          <div onMouseDown={(e) => handleStartResizeModal(e, 'nw')} className="absolute -top-1 -left-1 w-3.5 h-3.5 cursor-nw-resize z-30" />
          <div onMouseDown={(e) => handleStartResizeModal(e, 'se')} className="absolute -bottom-1 -right-1 w-3.5 h-3.5 cursor-se-resize z-30 flex items-end justify-end p-0.5">
            <div className="w-1.5 h-1.5 border-r-2 border-b-2 border-fg-dim" />
          </div>
          <div onMouseDown={(e) => handleStartResizeModal(e, 'sw')} className="absolute -bottom-1 -left-1 w-3.5 h-3.5 cursor-sw-resize z-30 flex items-end justify-start p-0.5">
            <div className="w-1.5 h-1.5 border-l-2 border-b-2 border-fg-dim" />
          </div>
        </>
      )}
    </div>
  );
}
