import React, { useState, useRef, useEffect } from 'react';
import {
  FileText,
  Check,
  X,
  Maximize2,
  Minimize2,
  Cpu,
  BarChart2,
  CheckCircle2,
  HelpCircle
} from 'lucide-react';
import type { ActionPayload, Message } from './ThalamusCopilot';

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
  const origToks = Math.max(1, Math.round(orig.length / 4.1));
  const optToks = Math.max(1, Math.round(opt.length / 4.1));
  const diffToks = Math.max(0, origToks - optToks);
  const pct = origToks > 0 ? Math.round((diffToks / origToks) * 100) : 0;
  const removedLines = Math.max(0, orig.split('\n').length - opt.split('\n').length);
  const addedLines = Math.max(0, opt.split('\n').length - orig.split('\n').length);
  const changedLines = addedLines + removedLines;

  return (
    <div
      ref={modalRef}
      style={{
        transform: isMaximized ? 'none' : `translate3d(${posRef.current.x}px, ${posRef.current.y}px, 0px)`,
        width: isMaximized ? 'auto' : `${sizeRef.current.width}px`,
        height: isMaximized ? 'auto' : `${sizeRef.current.height}px`,
        willChange: 'transform, width, height'
      }}
      className={`fixed z-50 bg-[#100F0F] border border-[#282726] shadow-2xl flex flex-col font-mono text-[#F2F0E5] ${
        isMaximized
          ? 'inset-2 w-[calc(100%-16px)] h-[calc(100%-16px)] rounded-lg overflow-hidden'
          : 'top-0 left-0 rounded-lg overflow-hidden'
      }`}
    >
      {/* TOP HEADER BAR */}
      <div
        onMouseDown={handleStartDragModal}
        className="px-3.5 py-2 bg-[#1C1B1A] border-b border-[#282726] flex items-center justify-between cursor-move select-none flex-shrink-0"
      >
        <div className="flex items-center gap-2 text-[11px]">
          <FileText size={14} className="text-[#87857F]" />
          <span className="font-semibold text-[#CECDC3]">
            {payload.targetFile}
          </span>
        </div>

        <div className="flex items-center gap-3">
          {!isMaximized && (
            <div className="hidden sm:flex items-center gap-2 text-[10.5px]">
              <span className="text-[#A8A49E] bg-[#282726] border border-[#34332F] px-2 py-0.5 rounded font-mono">
                ≈{origToks} → ≈{optToks} (-%{pct})
              </span>
            </div>
          )}

          {/* HINT ICON AND VERTICAL LINE */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 border-r border-[#34332F] pr-2">
              <button
                type="button"
                onClick={() => setIsBannerVisible(!isBannerVisible)}
                className={`p-1 rounded hover:bg-[#282726] cursor-pointer transition-colors flex items-center justify-center ${
                  isBannerVisible ? 'text-[#4385BE]' : 'text-[#A8A49E] hover:text-white'
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
                className="text-[#A8A49E] hover:text-white p-1 rounded hover:bg-[#282726] cursor-pointer transition-colors"
                title={isMaximized ? "Switch to Windowed" : "Toggle Fullscreen"}
              >
                {isMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="text-[#A8A49E] hover:text-white p-1 rounded hover:bg-[#282726] cursor-pointer transition-colors"
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
        <div className="flex-1 flex flex-col min-h-0 bg-[#100F0F] relative">

          {payload.originalCodeSnippet && payload.codeSnippet ? (
            <div className="flex-1 grid grid-cols-2 gap-4 p-4 overflow-auto pretty-scrollbar bg-[#100F0F]">
              <div className="flex flex-col gap-2 h-full min-h-0">
                <div className="text-[10px] text-red-400 font-bold uppercase border-b border-red-500/20 pb-1">Original Code ({activeFile})</div>
                <pre className="flex-1 bg-[#231D1A] border border-red-950/40 p-3 rounded text-[11px] overflow-auto pretty-scrollbar text-red-300 font-mono whitespace-pre">{payload.originalCodeSnippet}</pre>
              </div>
              <div className="flex flex-col gap-2 h-full min-h-0">
                <div className="text-[10px] text-green-400 font-bold uppercase border-b border-green-500/20 pb-1">Suggested Code (Optimized)</div>
                <pre className="flex-1 bg-[#1A201C] border border-green-950/40 p-3 rounded text-[11px] overflow-auto pretty-scrollbar text-green-300 font-mono whitespace-pre">{payload.codeSnippet}</pre>
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-auto p-4 text-[11.5px] leading-[1.7] pretty-scrollbar font-mono whitespace-pre-wrap text-[#CECDC3]">
              {message.text}
            </div>
          )}

          {/* Bottom Bar (Footer) */}
          <div className="px-3.5 py-2 bg-[#1C1B1A] border-t border-[#282726] flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2 text-[10.5px]">
              <span className="text-[#A8A49E] bg-[#282726] border border-[#34332F] px-2.5 py-0.5 rounded font-mono">
                {changedLines} Lines Changed
              </span>
              {removedLines > 0 && (
                <span className="text-[#A8A49E] bg-[#282726] border border-[#34332F] px-2.5 py-0.5 rounded font-mono">
                  -{removedLines} Lines Removed
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {executed ? (
                <span className="text-[#3AA99F] text-[10.5px] font-medium flex items-center gap-1 px-2.5 py-0.5 bg-[#1e3a2b]/60 border border-[#2d5a45]/50 rounded font-sans">
                  <Check size={12} /> Applied to Code
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onApply(payload)}
                  className="px-2.5 py-0.5 bg-[#282726] hover:bg-[#34332F] border border-[#34332F] text-[#A8A49E] hover:text-white font-medium rounded text-[10.5px] flex items-center gap-1.5 cursor-pointer transition-colors font-sans shadow-sm"
                >
                  <CheckCircle2 size={13} className="text-[#4385BE]" /> Apply to Code
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* SECTION 2: FULLSCREEN MODE */
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-[#100F0F]">

          {/* Top comparison panels */}
          <div className="h-[55%] grid grid-cols-2 bg-[#100F0F] border-b border-[#282726] flex-shrink-0 relative overflow-hidden">
            <div className="flex flex-col h-full overflow-hidden border-r border-[#282726]">
              <div className="px-3 py-2 bg-[#1C1B1A] text-[#A8A49E] text-[11px] border-b border-[#282726] flex items-center justify-between flex-shrink-0">
                <span className="font-semibold text-[#D14D41] flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-[#D14D41]" />
                  Original Code
                </span>
                <div className="flex items-center gap-2 text-[10.5px]">
                  <span className="text-[#D14D41] bg-[#3b181a]/40 border border-[#824449]/30 px-2 py-0.5 rounded font-mono">{origToks} Tokens</span>
                  <span className="text-[#D14D41] bg-[#3b181a]/40 border border-[#824449]/30 px-2 py-0.5 rounded font-mono">{orig.length} B</span>
                </div>
              </div>
              <div className="flex-1 overflow-auto p-3 text-[12px] leading-[1.65] pretty-scrollbar bg-[#100F0F]">
                <pre className="text-[#F2F0E5] whitespace-pre font-mono">
                  {payload.originalCodeSnippet || payload.codeSnippet}
                </pre>
              </div>
            </div>

            <div className="flex flex-col h-full overflow-hidden">
              <div className="px-3 py-2 bg-[#1C1B1A] text-[#A8A49E] text-[11px] border-b border-[#282726] flex items-center justify-between flex-shrink-0">
                <span className="font-semibold text-[#3AA99F] flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-[#3AA99F]" />
                  Optimized Output (JSON)
                </span>
                <div className="flex items-center gap-2 text-[10.5px]">
                  <span className="text-[#A8A49E] bg-[#282726] border border-[#34332F] px-2 py-0.5 rounded font-mono">≈{origToks} → ≈{optToks} (-%{pct})</span>
                  <span className="text-[#A8A49E] bg-[#282726] border border-[#34332F] px-2 py-0.5 rounded font-mono">{opt.length} B</span>
                </div>
              </div>
              <div className="flex-1 overflow-auto p-3 text-[12px] leading-[1.65] pretty-scrollbar bg-[#100F0F]">
                <pre className="text-[#879A39] whitespace-pre font-mono">
                  {payload.codeSnippet}
                </pre>
              </div>
            </div>
          </div>

          {/* Bottom Dashboard Panels */}
          <div className="flex-1 grid grid-cols-[2fr_3fr] overflow-hidden bg-[#100F0F] p-3 gap-3 min-h-0">
            <div className="bg-[#1C1B1A] border border-[#282726] rounded-lg flex flex-col overflow-hidden">
              <div className="px-3.5 py-2 bg-[#282726]/60 border-b border-[#282726] text-[12px] font-semibold text-[#F2F0E5] flex items-center justify-between flex-shrink-0">
                <span className="flex items-center gap-1.5"><Cpu size={14} className="text-[#3AA99F]" /> WHAT DID WE CHANGE IN THE CODE?</span>
              </div>
              <div className="flex-1 overflow-y-auto p-2.5 flex flex-col gap-2 text-[12px] leading-relaxed pretty-scrollbar">
                <div className="bg-[#100F0F] p-2.5 rounded-md border border-[#204a37]/30 flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-semibold text-[#F2F0E5] text-[12px] flex items-center gap-1.5">
                      <span className="text-[#3AA99F]">✓</span> Suggested Change Applied
                    </span>
                    <span className="text-[11px] text-[#A8A49E]">
                      {removedLines} line(s) removed, {addedLines} line(s) added for {payload.targetFile}. Review the diff before applying.
                    </span>
                  </div>
                  <span className="text-[11px] text-[#3AA99F] bg-[#1e3a2b]/60 border border-[#2d5a45]/50 px-2 py-0.5 rounded font-mono font-bold flex-shrink-0">
                    -{pct}%
                  </span>
                </div>
              </div>
            </div>

            <div className="bg-[#1C1B1A] border border-[#282726] rounded-lg flex flex-col overflow-hidden">
              <div className="px-3.5 py-2 bg-[#282726]/60 border-b border-[#282726] text-[12px] font-semibold text-[#F2F0E5] flex items-center justify-between flex-shrink-0">
                <span className="flex items-center gap-1.5"><BarChart2 size={14} className="text-[#4385BE]" /> PERFORMANCE AND COST REPORT</span>
              </div>
              <div className="flex-1 p-2.5 grid grid-cols-3 gap-2.5 overflow-hidden items-stretch">
                <div className="bg-[#100F0F] border border-[#282726] rounded-md p-2 flex flex-col justify-between h-full">
                  <div>
                    <span className="text-[10.5px] font-bold text-[#F2F0E5] block">1. SAVINGS</span>
                    <span className="text-[9.5px] text-[#A8A49E] block mt-0.5">Reduction rates</span>
                  </div>
                  <div className="bg-[#1e3a2b]/40 border border-[#2d5a45]/50 rounded p-1 text-center">
                    <span className="text-[9.5px] text-[#3AA99F] font-bold block">-{pct}% saved</span>
                  </div>
                </div>

                <div className="bg-[#100F0F] border border-[#282726] rounded-md p-2 flex flex-col justify-between h-full">
                  <div>
                    <span className="text-[10.5px] font-bold text-[#F2F0E5] block">2. LINE CHANGES</span>
                    <span className="text-[9.5px] text-[#A8A49E] block mt-0.5">Added / removed</span>
                  </div>
                  <div className="bg-[#282726]/40 border border-[#4385BE]/50 rounded p-1 text-center">
                    <span className="text-[9.5px] text-[#4385BE] font-bold block">{changedLines} lines</span>
                  </div>
                </div>

                <div className="bg-[#100F0F] border border-[#282726] rounded-md p-2 flex flex-col justify-between h-full">
                  <div>
                    <span className="text-[10.5px] font-bold text-[#F2F0E5] block">3. PAYLOAD &amp; SIZE</span>
                    <span className="text-[9.5px] text-[#A8A49E] block mt-0.5">Text length</span>
                  </div>
                  <div className="bg-[#282726]/40 border border-[#4385BE]/50 rounded p-1 text-center">
                    <span className="text-[9.5px] text-[#CECDC3] font-bold block">{opt.length} B</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom Buttons (Fullscreen Mode Footer) */}
          <div className="px-3.5 py-2 bg-[#1C1B1A] border-t border-[#282726] flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2 text-[10.5px]">
              <span className="text-[#A8A49E] bg-[#282726] border border-[#34332F] px-2.5 py-0.5 rounded font-mono">
                Optimization Complete
              </span>
              <span className="text-[#A8A49E] bg-[#282726] border border-[#34332F] px-2.5 py-0.5 rounded font-mono">
                {(() => {
                  const origL = orig.split('\n').length;
                  const optL = opt.split('\n').length;
                  const diffL = origL - optL;
                  return diffL > 0 ? `-${diffL} Lines Removed` : diffL < 0 ? `+${Math.abs(diffL)} Lines Added` : 'Same Line Count';
                })()}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onApply(payload)}
                className="px-2.5 py-0.5 bg-[#282726] hover:bg-[#34332F] border border-[#34332F] text-[#A8A49E] hover:text-white font-medium rounded text-[10.5px] flex items-center gap-1.5 cursor-pointer transition-colors font-sans shadow-sm"
              >
                <CheckCircle2 size={13} className="text-[#4385BE]" /> Apply to Code
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
            <div className="w-1.5 h-1.5 border-r-2 border-b-2 border-[#575654]" />
          </div>
          <div onMouseDown={(e) => handleStartResizeModal(e, 'sw')} className="absolute -bottom-1 -left-1 w-3.5 h-3.5 cursor-sw-resize z-30 flex items-end justify-start p-0.5">
            <div className="w-1.5 h-1.5 border-l-2 border-b-2 border-[#575654]" />
          </div>
        </>
      )}
    </div>
  );
}
