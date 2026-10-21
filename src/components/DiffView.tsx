import React, { useEffect, useRef, useState } from 'react';
import { Copy, Check, AlertTriangle } from 'lucide-react';
import { SyntaxHighlighter, vscDarkPlus } from '../lib/codeHighlight';
import { useT } from '../lib/i18n';

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
  /** Gerçekte kullanılan model id'si (sağlayıcı çözümlemesinden gelir). */
  modelName?: string;
  /** ≈ USD per token; bilinmiyorsa undefined → tahmin gösterilmez. */
  pricePerToken?: number;
}

const MONO: React.CSSProperties['fontFamily'] = "'Ubuntu Sans Mono', Consolas, monospace";


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
  const t = useT();
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
      <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-[#282726] bg-[#1C1B1A] px-4 py-2">
        <span className="flex flex-shrink-0 items-center gap-1.5 text-[11px] font-semibold text-[#A8A49E]">
          <span className={`h-2 w-2 rounded-full ${dotClass}`} />
          {label}
          {tsvHint && (
            <span
              title={t('diff.tsvLegend')}
              className="ml-1 cursor-help rounded border border-white/[0.08] bg-white/[0.05] px-1.5 py-px font-mono text-[11px] font-normal text-[#575654]"
            >
              TSV
            </span>
          )}
        </span>

        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-[11px] text-[#A8A49E]">{metric}</span>
          <button
            type="button"
            onClick={handleCopy}
            title={t('diff.copy')}
            className="flex-shrink-0 cursor-pointer rounded p-1 text-[#575654] transition-colors hover:bg-white/[0.05] hover:text-[#A8A49E]"
          >
            {copied ? <Check size={12} className="text-[#3AA99F]" /> : <Copy size={12} />}
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="diff-code-pane min-h-0 flex-1 overflow-auto bg-[#100F0F] pretty-scrollbar"
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
              color: '#575654',
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
          <div className="flex h-full min-h-[140px] items-center justify-center px-4 py-8 font-mono text-[11px] text-[#575654]">
            {t('diff.noData')}
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
  const t = useT();
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

  // Cost impact: real token counts × the active model's price. The price is
  // only an estimate; when the model id is unknown no number is invented.
  const activeModelName = modelName || '—';
  const priceKnown = typeof pricePerToken === 'number' && Number.isFinite(pricePerToken);
  const activePrice = priceKnown ? pricePerToken : 0;
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
  const origMetric = `${fmtInt(origTokens)} ${t('diff.tok')} · ${fmtBytes(origBytes)}`;
  const optMetric = `${fmtInt(optTokens)} ${t('diff.tok')} · ${fmtBytes(optBytes)}`;

  const origLang = detectLanguage(origCode);
  const optLang = origCode && origCode !== optCode && origLang === 'json' ? 'text' : origLang;

  return (
    <div className="diff-view-layout flex h-full w-full select-none flex-col overflow-hidden bg-[#100F0F] font-sans text-[#F2F0E5]">
      {/* TOP BAR */}
      <div className="flex h-[42px] flex-shrink-0 items-center justify-between border-b border-[#282726] bg-[#1C1B1A] px-4 font-mono text-[12px]">
        <div className="flex items-center gap-2 whitespace-nowrap text-[#A8A49E] lowercase tracking-tight">
          <span className="max-w-[120px] truncate text-[#575654]" title={t('diff.chats')}>
            {t('diff.chats')}
          </span>
          {title && (
            <>
              <span className="select-none text-[#575654]">/</span>
              <span className="max-w-[200px] truncate font-medium text-[#F2F0E5]">{title}</span>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={onCloseDiff}
          className="flex flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-[#575654] bg-[#282726] px-3 py-1 font-mono text-[11px] text-[#A8A49E] transition-colors hover:bg-[#575654] hover:text-[#F2F0E5]"
        >
          {t('diff.close')}
        </button>
      </div>

      {/* CODE PANES — highlighted, schema lines marked, scroll-synced. Falls back to an empty hero. */}
      {hasData ? (
        <div className="grid min-h-[240px] flex-1 grid-cols-2 divide-x divide-[#282726] overflow-hidden bg-[#100F0F]">
          <CodePane
            label={t('diff.original')}
            dotClass="bg-[#D14D41]"
            code={origCode}
            lang={origLang}
            metric={origMetric}
            scrollRef={leftScrollRef}
            onScroll={handleScrollSync('left')}
          />
          <CodePane
            label={t('diff.optimized')}
            dotClass="bg-[#3AA99F]"
            code={optCode}
            lang={optLang}
            metric={optMetric}
            tsvHint
            scrollRef={rightScrollRef}
            onScroll={handleScrollSync('right')}
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-[#100F0F] text-center">
          <span className="text-[13px] font-semibold text-[#A8A49E]">{t('diff.noDataTitle')}</span>
          <span className="text-[11px] text-[#575654]">{t('diff.noDataHint')}</span>
        </div>
      )}

      {/* BOTTOM: four KPI tiles — the answer at a glance, all values computed, clean with zero data */}
      <div className="flex-shrink-0 bg-[#100F0F] p-3">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-[#282726] bg-[#282726] lg:grid-cols-4">
          {/* 1 · TOKEN SAVINGS */}
          <div className="flex min-w-0 flex-col gap-1.5 bg-[#1C1B1A] p-4">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#575654]">{t('diff.tokenSavings')}</span>
            <span
              className={`truncate font-mono text-[28px] font-bold leading-none ${
                isSaved ? 'text-[#3AA99F]' : savingsPct < 0 && hasData ? 'text-[#D14D41]' : 'text-[#575654]'
              }`}
            >
              {!hasData ? '—' : savingsPct > 0 ? `-${savingsPct}%` : savingsPct < 0 ? `+${Math.abs(savingsPct)}%` : '0%'}
            </span>
            <span className="truncate font-mono text-[11px] text-[#A8A49E]">
              {hasData ? `${fmtInt(origTokens)} → ${fmtInt(optTokens)} ${t('diff.tok')}` : t('diff.awaiting')}
            </span>
            {hasData && baselinePct !== null && (
              <span className="truncate font-mono text-[11px] text-[#575654]">
                {savingsPct > baselinePct
                  ? t('diff.aboveMinify', { n: (savingsPct - baselinePct).toFixed(1) })
                  : t('diff.minifyAlone', { n: baselinePct })}
              </span>
            )}
          </div>

          {/* 2 · COST / CALL on the active model */}
          <div className="flex min-w-0 flex-col gap-1.5 bg-[#1C1B1A] p-4">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#575654]">{t('diff.costPerCall')}</span>
            <span className="truncate font-mono text-[28px] font-bold leading-none text-[#F2F0E5]">
              {hasData && priceKnown ? fmtUsd(costAfter) : '—'}
            </span>
            <span className="truncate font-mono text-[11px] text-[#A8A49E]">{activeModelName}</span>
            {hasData && !priceKnown && (
              <span className="truncate font-mono text-[11px] text-[#575654]">{t('diff.priceUnknown')}</span>
            )}
            {hasData && priceKnown && isSaved && (
              <span className="truncate font-mono text-[11px] text-[#575654]">{t('diff.wasUncompressed', { v: fmtUsd(costBefore) })}</span>
            )}
          </div>

          {/* 3 · PROJECTED SAVINGS AT VOLUME */}
          <div className="flex min-w-0 flex-col gap-1.5 bg-[#1C1B1A] p-4">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#575654]">{t('diff.saved1k')}</span>
            <span className={`truncate font-mono text-[28px] font-bold leading-none ${isSaved && priceKnown ? 'text-[#3AA99F]' : 'text-[#575654]'}`}>
              {isSaved && priceKnown ? `-${fmtUsd(monthlySavedUsd)}` : '—'}
            </span>
            <span className="truncate font-mono text-[11px] text-[#A8A49E]">{t('diff.per1k')}</span>
            {isSaved && priceKnown && (
              <span className="truncate font-mono text-[11px] text-[#575654]">{t('diff.vsWithout', { v: fmtUsd(costBefore * 1000) })}</span>
            )}
          </div>

          {/* 4 · ENGINE — speed + integrity */}
          <div className="flex min-w-0 flex-col gap-1.5 bg-[#1C1B1A] p-4">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#575654]">{t('diff.engineTime')}</span>
            <span className="truncate font-mono text-[28px] font-bold leading-none text-[#F2F0E5]">
              {engineTimeMs !== undefined ? `${engineTimeMs} ms` : '—'}
            </span>
            {hasData && hasChange ? (
              diffData?.losslessVerified === false ? (
                // D2: veto_override dogrulamayi atadi — rozet YALAN SOYLEMEZ.
                <span
                  title={t('diff.losslessSkippedTitle')}
                  className="flex items-center gap-1 truncate font-mono text-[11px] text-[#D14D41]"
                >
                  <AlertTriangle size={11} /> {t('diff.losslessSkipped')}
                </span>
              ) : (
                <span
                  title={t('diff.losslessVerifiedTitle')}
                  className="flex items-center gap-1 truncate font-mono text-[11px] text-[#3AA99F]"
                >
                  <Check size={11} /> {t('diff.losslessVerified')}
                </span>
              )
            ) : (
              <span className="truncate font-mono text-[11px] text-[#575654]">
                {hasData ? t('diff.noCompression') : t('diff.engineIdle')}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
