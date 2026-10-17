import React, { useEffect, useRef, useState } from 'react';
import { Copy, Check, AlertTriangle } from 'lucide-react';
import { SyntaxHighlighter, vscDarkPlus } from '../lib/codeHighlight';
import { MODELS } from '../constants';

export interface DiffCodeData {
  originalCode: string;
  optimizedCode: string;
  originalTokens?: number;
  compressedTokens?: number;
  savingsPercentage?: number;
  /** Engine compression time (ms) — real measurement */
  engineTimeMs?: number;
  /** D2: motor kayipsizligi gercekten dogruladi mi (veto override: false) */
  losslessVerified?: boolean;
}

interface DiffViewProps {
  onCloseDiff: () => void;
  diffData?: DiffCodeData;
  /** Analysis title shown in the top path bar (e.g. active chat name) */
  title?: string;
  /** D1/D8: maliyet TAHMIN referansi — text chat calls no model API */
  modelName?: string;
  /** ≈ USD per token for that model (rough input price) */
  pricePerToken?: number;
}

const MONO: React.CSSProperties['fontFamily'] = "'Ubuntu Sans Mono', Consolas, monospace";

const TSV_LEGEND =
  '@T schema format: (k=v) constant column · name(n=v;…) dictionary · name[prefix] shared prefix · ^ repeats previous row · ~ null';

function isJson(code: string): boolean {
  const t = code.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return false;
  try {
    const v = JSON.parse(t);
    return Array.isArray(v) || (typeof v === 'object' && v !== null);
  } catch {
    return false;
  }
}

function detectLanguage(code: string): string {
  if (isJson(code)) return 'json';
  const t = code.trimStart();
  if (/^(def |class |import |from )/m.test(t)) return 'python';
  if (/^(use |fn |pub |struct )/m.test(t)) return 'rust';
  if (/^(function |const |let |var |export )/m.test(t)) return 'typescript';
  return 'text';
}

/** @T schema lines (decoder + schema + column header) are marked as "added" */
function isSchemaLine(lines: string[], i: number): boolean {
  return (lines[i] ?? '').startsWith('@T') || (lines[i - 1] ?? '').startsWith('@T(');
}

interface CodePaneProps {
  label: string;
  dotClass: string;
  code: string;
  lang: string;
  metric: string;
  tsvHint?: boolean;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
}

function CodePane({ label, dotClass, code, lang, metric, tsvHint, scrollRef, onScroll }: CodePaneProps) {
  const [copied, setCopied] = useState(false);
  const lines = code.split('\n');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — fail silently */
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-surface bg-panel px-4 py-2">
        <span className="flex flex-shrink-0 items-center gap-1.5 text-[11px] font-semibold text-fg-muted">
          <span className={`h-2 w-2 rounded-full ${dotClass}`} />
          {label}
          {tsvHint && (
            <span
              title={TSV_LEGEND}
              className="ml-1 cursor-help rounded border border-white/[0.08] bg-white/[0.05] px-1.5 py-px font-mono text-[11px] font-normal text-fg-dim"
            >
              TSV
            </span>
          )}
        </span>

        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-[11px] text-fg-muted">{metric}</span>
          <button
            type="button"
            onClick={handleCopy}
            title="Copy"
            className="flex-shrink-0 cursor-pointer rounded p-1 text-fg-dim transition-colors hover:bg-white/[0.05] hover:text-fg-muted"
          >
            {copied ? <Check size={12} className="text-aqua" /> : <Copy size={12} />}
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="diff-code-pane min-h-0 flex-1 overflow-auto bg-ink pretty-scrollbar"
      >
        {code ? (
          <SyntaxHighlighter
            style={vscDarkPlus}
            language={lang}
            PreTag="div"
            showLineNumbers
            wrapLines
            codeTagProps={{ style: { fontFamily: MONO } }}
            lineProps={(lineNumber: number) =>
              isSchemaLine(lines, lineNumber - 1) ? { className: 'diff-line-added' } : {}
            }
            lineNumberStyle={{
              minWidth: '2.4em',
              paddingRight: '1.1em',
              color: 'rgb(var(--tlm-fg-dim))',
              textAlign: 'right',
              userSelect: 'none',
            }}
            customStyle={{
              margin: 0,
              padding: '14px 16px 14px 6px',
              background: 'transparent',
              fontFamily: MONO,
              fontSize: '12.5px',
              lineHeight: '1.65',
            }}
          >
            {code}
          </SyntaxHighlighter>
        ) : (
          <div className="flex h-full min-h-[140px] items-center justify-center px-4 py-8 font-mono text-[11px] text-fg-dim">
            No data
          </div>
        )}
      </div>
    </div>
  );
}

/** D8: ≈ — birim fiyat kabaca bir referanstir, fatura degil. */
function fmtUsd(v: number): string {
  return `≈$${v >= 1 ? v.toFixed(2) : v.toFixed(4)}`;
}

export const DiffView: React.FC<DiffViewProps> = ({ onCloseDiff, diffData, title, modelName, pricePerToken }) => {
  // Empty state when there is no data (no fake sample code is ever shown)
  const origCode = diffData?.originalCode || '';
  const optCode = diffData?.optimizedCode || '';
  const hasData = origCode.trim().length > 0 || optCode.trim().length > 0;

  const origBytes = new Blob([origCode]).size;
  const optBytes = new Blob([optCode]).size;

  const origTokens = diffData?.originalTokens || Math.max(1, Math.ceil(origCode.length / 4));
  const optTokens = diffData?.compressedTokens || Math.max(1, Math.ceil(optCode.length / 4));

  const savingsPct =
    diffData?.savingsPercentage !== undefined
      ? diffData.savingsPercentage
      : Number((((origTokens - optTokens) / origTokens) * 100).toFixed(1));

  const engineTimeMs = diffData?.engineTimeMs;
  const hasChange = optCode.trim().length > 0 && origCode.trim() !== optCode.trim();
  const savedTokens = Math.max(0, origTokens - optTokens);
  // "Saved" only reads as green when compression actually happened AND shrank the prompt
  const isSaved = hasData && hasChange && savingsPct > 0;

  // Escape always closes the diff (chat stays open)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseDiff();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCloseDiff]);

  // REAL "industry standard" baseline: how much plain JSON minify shrinks the same input
  const minifiedJson = (() => {
    try {
      return JSON.stringify(JSON.parse(origCode));
    } catch {
      return null;
    }
  })();
  const minifiedBytes = minifiedJson !== null ? new Blob([minifiedJson]).size : null;
  const baselinePct =
    minifiedBytes !== null && origBytes > 0
      ? Number((((origBytes - minifiedBytes) / origBytes) * 100).toFixed(1))
      : null;

  // Cost impact: real token counts × the user's selected model price (live pricing when available)
  const activeModelName = modelName || MODELS[0].name;
  const activePrice = pricePerToken ?? MODELS[0].pricePerToken;
  const costBefore = origTokens * activePrice;
  const costAfter = optTokens * activePrice;
  const monthlySavedUsd = savedTokens * activePrice * 1000;

  // Synchronized scrolling (like real diff tools)
  const leftScrollRef = useRef<HTMLDivElement>(null);
  const rightScrollRef = useRef<HTMLDivElement>(null);
  const syncingRef = useRef(false);
  const handleScrollSync = (side: 'left' | 'right'): React.UIEventHandler<HTMLDivElement> => () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    const src = side === 'left' ? leftScrollRef.current : rightScrollRef.current;
    const dst = side === 'left' ? rightScrollRef.current : leftScrollRef.current;
    if (src && dst) {
      // Panes can have different content heights; proportional mapping is required
      const srcRange = src.scrollHeight - src.clientHeight;
      const dstRange = dst.scrollHeight - dst.clientHeight;
      dst.scrollTop = srcRange > 0 && dstRange > 0 ? (src.scrollTop / srcRange) * dstRange : 0;
      dst.scrollLeft = src.scrollLeft;
    }
    requestAnimationFrame(() => {
      syncingRef.current = false;
    });
  };

  const fmtBytes = (b: number) => (b > 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`);
  const fmtInt = (n: number) => n.toLocaleString('en-US');
  const origMetric = `${fmtInt(origTokens)} tok · ${fmtBytes(origBytes)}`;
  const optMetric = `${fmtInt(optTokens)} tok · ${fmtBytes(optBytes)}`;

  const origLang = detectLanguage(origCode);
  const optLang = origCode && origCode !== optCode && origLang === 'json' ? 'text' : origLang;

  return (
    <div className="diff-view-layout flex h-full w-full select-none flex-col overflow-hidden bg-ink font-sans text-fg">
      {/* TOP BAR */}
      <div className="flex h-[42px] flex-shrink-0 items-center justify-between border-b border-surface bg-panel px-4 font-mono text-[12px]">
        <div className="flex items-center gap-2 whitespace-nowrap text-fg-muted lowercase tracking-tight">
          <span className="max-w-[120px] truncate text-fg-dim" title="chats">
            chats
          </span>
          {title && (
            <>
              <span className="select-none text-fg-dim">/</span>
              <span className="max-w-[200px] truncate font-medium text-fg">{title}</span>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={onCloseDiff}
          className="flex flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-fg-dim bg-surface px-3 py-1 font-mono text-[11px] text-fg-muted transition-colors hover:bg-fg-dim hover:text-fg"
        >
          ← Close
        </button>
      </div>

      {/* CODE PANES — highlighted, schema lines marked, scroll-synced. Falls back to an empty hero. */}
      {hasData ? (
        <div className="grid min-h-[240px] flex-1 grid-cols-2 divide-x divide-surface overflow-hidden bg-ink">
          <CodePane
            label="Original"
            dotClass="bg-danger"
            code={origCode}
            lang={origLang}
            metric={origMetric}
            scrollRef={leftScrollRef}
            onScroll={handleScrollSync('left')}
          />
          <CodePane
            label="Optimized"
            dotClass="bg-aqua"
            code={optCode}
            lang={optLang}
            metric={optMetric}
            tsvHint
            scrollRef={rightScrollRef}
            onScroll={handleScrollSync('right')}
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-ink text-center">
          <span className="text-[13px] font-semibold text-fg-muted">No compression data yet</span>
          <span className="text-[11px] text-fg-dim">Pick a compressed message in the chat to see the before and after.</span>
        </div>
      )}

      {/* BOTTOM: four KPI tiles — the answer at a glance, all values computed, clean with zero data */}
      <div className="flex-shrink-0 bg-ink p-3">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-surface bg-surface lg:grid-cols-4">
          {/* 1 · TOKEN SAVINGS */}
          <div className="flex min-w-0 flex-col gap-1.5 bg-panel p-4">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-dim">Token savings</span>
            <span
              className={`truncate font-mono text-[28px] font-bold leading-none ${
                isSaved ? 'text-aqua' : savingsPct < 0 && hasData ? 'text-danger' : 'text-fg-dim'
              }`}
            >
              {!hasData ? '—' : savingsPct > 0 ? `-${savingsPct}%` : savingsPct < 0 ? `+${Math.abs(savingsPct)}%` : '0%'}
            </span>
            <span className="truncate font-mono text-[11px] text-fg-muted">
              {hasData ? `${fmtInt(origTokens)} → ${fmtInt(optTokens)} tok` : 'awaiting analysis'}
            </span>
            {hasData && baselinePct !== null && (
              <span className="truncate font-mono text-[11px] text-fg-dim">
                {savingsPct > baselinePct
                  ? `+${(savingsPct - baselinePct).toFixed(1)} p.p. above JSON minify`
                  : `JSON minify alone: -${baselinePct}%`}
              </span>
            )}
          </div>

          {/* 2 · COST / CALL on the user's selected model */}
          <div className="flex min-w-0 flex-col gap-1.5 bg-panel p-4">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-dim">Cost / call</span>
            <span className="truncate font-mono text-[28px] font-bold leading-none text-fg">
              {hasData ? fmtUsd(costAfter) : '—'}
            </span>
            <span className="truncate font-mono text-[11px] text-fg-muted">{activeModelName}</span>
            {hasData && isSaved && (
              <span className="truncate font-mono text-[11px] text-fg-dim">was {fmtUsd(costBefore)} uncompressed</span>
            )}
          </div>

          {/* 3 · PROJECTED SAVINGS AT VOLUME */}
          <div className="flex min-w-0 flex-col gap-1.5 bg-panel p-4">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-dim">Saved / 1K calls</span>
            <span className={`truncate font-mono text-[28px] font-bold leading-none ${isSaved ? 'text-aqua' : 'text-fg-dim'}`}>
              {isSaved ? `-${fmtUsd(monthlySavedUsd)}` : '—'}
            </span>
            <span className="truncate font-mono text-[11px] text-fg-muted">per 1,000 prompts</span>
            {isSaved && (
              <span className="truncate font-mono text-[11px] text-fg-dim">vs {fmtUsd(costBefore * 1000)} without it</span>
            )}
          </div>

          {/* 4 · ENGINE — speed + integrity */}
          <div className="flex min-w-0 flex-col gap-1.5 bg-panel p-4">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-dim">Engine time</span>
            <span className="truncate font-mono text-[28px] font-bold leading-none text-fg">
              {engineTimeMs !== undefined ? `${engineTimeMs} ms` : '—'}
            </span>
            {hasData && hasChange ? (
              diffData?.losslessVerified === false ? (
                // D2: veto_override dogrulamayi atadi — rozet YALAN SOYLEMEZ.
                <span
                  title="veto_override forced the structural change; the engine did not verify losslessness for this output."
                  className="flex items-center gap-1 truncate font-mono text-[11px] text-danger"
                >
                  <AlertTriangle size={11} /> lossless check skipped (veto override)
                </span>
              ) : (
                <span
                  title="Engine verifies losslessness by comparing the expansion against the original exactly"
                  className="flex items-center gap-1 truncate font-mono text-[11px] text-aqua"
                >
                  <Check size={11} /> verified lossless (engine)
                </span>
              )
            ) : (
              <span className="truncate font-mono text-[11px] text-fg-dim">
                {hasData ? 'no compression applied' : 'engine idle'}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
