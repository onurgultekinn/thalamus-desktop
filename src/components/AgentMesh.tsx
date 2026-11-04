import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowUpRight, CheckCircle2, ChevronDown, ChevronRight, FileCode2, Info,
  Loader2, Play, RotateCcw, Settings2, Square, Wand2,
} from 'lucide-react';
import { useT } from '../lib/i18n';
import { getActiveProvider } from '../services/aiClient';
import { priceForModel, usePriceMap } from '../lib/pricing';
import { computeLineDiff, diffStats } from '../lib/diff';
import {
  applyFileEdits, extractEdits, extractFindings, extractPlanSteps, extractReport,
  groupEditsByFile, type AgentEditRecord, type PlanStep,
} from '../lib/agentEdits';
import { readFileViaHost, writeFileViaHost } from '../lib/fileBridge';
import {
  AGENT_MOCK_PROVIDER,
  AGENT_TERMINAL,
  cancelAgentRun,
  fetchAgentState,
  fetchLastRunState,
  saveLastRunId,
  startAgentRun,
  type AgentInfo,
  type RunState,
  type StartRunRequest,
  type WireMessage,
} from '../services/agentClient';

// Ajan koşu ekranı — Akış'taki "Çalıştır" ile açılır.
//
// Tasarım hedefi: bir KONTROL PANOSU değil, bir ÇALIŞMA YÜZEYİ. Kullanıcı
// görevi yazar, koşuyu izler, çıkan değişikliklere karar verir. Bu yüzden
// ekran bir konuşma gibi akar:
//
//   görev  →  ajan satırları (kim ne yaptı)  →  sonuçlar (uygula / aç)
//
// Telemetri (token bilançosu, zarf tel biçimi, dekoder sözleşmesi) tek bir
// "Ayrıntılar" katmanında durur; işin önüne geçmez.

const STATUS_COLOR: Record<string, string> = {
  idle: '#575654',
  queued: '#4A4844',
  thinking: '#dcb67a',
  done: '#3AA99F',
  error: '#D14D41',
  running: '#dcb67a',
  failed: '#D14D41',
  cancelled: '#87857F',
};

/** Zarf türü → satır başındaki küçük nokta rengi. */
const KIND_COLOR: Record<string, string> = {
  plan: '#4385BE',
  result: '#3AA99F',
  review: '#dcb67a',
  report: '#a78bfa',
};

const KIND_LABEL_KEY = {
  plan: 'agents.kind.plan',
  result: 'agents.kind.result',
  review: 'agents.kind.review',
  report: 'agents.kind.report',
} as const;

function kindLabel(t: ReturnType<typeof useT>, kind: string): string {
  const key = KIND_LABEL_KEY[kind as keyof typeof KIND_LABEL_KEY];
  return key ? t(key) : kind;
}

/** AgentCompany'nin `Plan` tipiyle yapısal olarak uyumlu koşu girdisi. */
export interface OrgRunPlan {
  name: string;
  agents: {
    id: string;
    parentId: string | null;
    name: string;
    role: string;
    mission: string;
    resp: string;
  }[];
  links: { from: string; to: string; label: string }[];
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/** 95000 → "1:35" */
function fmtElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Panoya yazar: Clipboard API, reddedilirse execCommand. Sonuç dürüsttür —
 * arayüz başarısızlığı gösterir, sessizce yutmaz.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Ajan satırı — koşunun "konuşma" birimi
// ---------------------------------------------------------------------------

/** Bir zarfı tek cümleye çevirir: kullanıcı JSON değil, olan biteni okur. */
function describe(t: ReturnType<typeof useT>, msg: WireMessage): string {
  const payload = (msg.raw as { payload?: unknown } | null)?.payload;
  const n = Array.isArray(payload) ? payload.length : 0;
  switch (msg.kind) {
    case 'plan':
      return n ? t('run.didPlan', { n: String(n) }) : t('run.didNothing');
    case 'result':
      return n ? t('run.didEdit', { n: String(n) }) : t('run.didNothing');
    case 'review': {
      const errors = Array.isArray(payload)
        ? payload.filter((r) => (r as { severity?: string })?.severity === 'error').length
        : 0;
      if (!n) return t('run.reviewClean');
      return errors
        ? t('run.reviewErrors', { n: String(n), e: String(errors) })
        : t('run.reviewWarn', { n: String(n) });
    }
    case 'report':
      return n ? t('run.didReport', { n: String(n) }) : t('run.didNothing');
    default:
      return '';
  }
}

function PlanSteps({ steps }: { steps: PlanStep[] }) {
  return (
    <ol className="m-0 flex list-none flex-col gap-1 p-0">
      {steps.map((s, i) => (
        <li key={`${s.id}-${i}`} className="flex items-baseline gap-2 text-[11.5px] text-obsidian-soft">
          <span className="w-6 shrink-0 text-right font-mono text-[10.5px] text-obsidian-muted">
            {s.id || i + 1}
          </span>
          <span className="min-w-0 flex-1">{s.title}</span>
          {s.files && (
            <span className="hidden max-w-[220px] shrink-0 truncate font-mono text-[10px] text-obsidian-muted md:block">
              {s.files.replace(/\|/g, ', ')}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

function EditList({ edits, newLabel }: { edits: AgentEditRecord[]; newLabel: string }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {edits.map((e, i) => (
        <li key={`${e.file}-${i}`} className="flex items-baseline gap-2 text-[11.5px] text-obsidian-soft">
          <FileCode2 size={11} className="shrink-0 text-obsidian-muted" />
          <span className="truncate font-mono text-[10.5px] text-obsidian-text">{e.file}</span>
          {e.op === 'create' && (
            <span className="shrink-0 text-[10px] text-obsidian-muted">{newLabel}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function MessageRow({
  msg,
  label,
  onTrace,
}: {
  msg: WireMessage;
  label: string;
  onTrace: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const dot = KIND_COLOR[msg.kind] || '#87857F';
  const steps = useMemo(() => (msg.kind === 'plan' ? extractPlanSteps([msg]) : []), [msg]);
  const edits = useMemo(() => (msg.kind === 'result' ? extractEdits([msg]) : []), [msg]);
  const isError = msg.status === 'fail' || msg.status === 'error';

  return (
    <div className="border-b border-obsidian-border/60 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2.5 py-2 text-left"
        aria-expanded={open}
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: dot }} aria-hidden />
        <span className="w-[92px] shrink-0 truncate text-[11.5px] font-medium text-obsidian-text">
          {label}
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-[11.5px] ${
            isError ? 'text-[#D14D41]' : 'text-obsidian-soft'
          }`}
        >
          {describe(t, msg)}
        </span>
        <span className="shrink-0 text-obsidian-muted">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>

      {open && (
        <div className="pb-3 pl-5 pr-1">
          {steps.length > 0 && <PlanSteps steps={steps} />}
          {edits.length > 0 && <EditList edits={edits} newLabel={t('run.newFile')} />}
          {steps.length === 0 && edits.length === 0 && (
            <p className="m-0 text-[11.5px] text-obsidian-muted">{t('run.noDetail')}</p>
          )}
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={onTrace}
              className="cursor-pointer text-[10.5px] text-obsidian-muted underline decoration-obsidian-border underline-offset-2 transition-colors hover:text-obsidian-text"
            >
              {t('run.onlyThisAgent')}
            </button>
            <button
              type="button"
              onClick={() => setRaw((v) => !v)}
              className="cursor-pointer text-[10.5px] text-obsidian-muted underline decoration-obsidian-border underline-offset-2 transition-colors hover:text-obsidian-text"
            >
              {raw ? t('run.hideRaw') : t('run.showRaw')}
            </button>
          </div>
          {raw && (
            <pre className="m-0 mt-1.5 max-h-[200px] overflow-auto whitespace-pre-wrap break-all rounded-md bg-obsidian-panel p-2 font-mono text-[10px] text-obsidian-muted">
              {JSON.stringify(msg.raw, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Ajan performans kartı — yönetim panelinin ana birimi.
 *
 * Bakan kişi tek bakışta şunu görür: kim, hangi işlevde, ne durumda, kaç kez
 * çağrıldı, ne kadar token harcadı, son turu ne kadar sürdü ve şu an ne
 * yapıyor. Karta tıklamak o ajanın akışını soldaki canlı logda filtreler.
 */
function AgentCard({
  agent,
  selected,
  messageCount,
  onSelect,
}: {
  agent: AgentInfo;
  selected: boolean;
  /** Bu ajanın ürettiği zarf sayısı (log'dan sayılır, uydurulmaz). */
  messageCount: number;
  onSelect: () => void;
}) {
  const t = useT();
  const color = STATUS_COLOR[agent.status] || '#87857F';
  const isThinking = agent.status === 'thinking';
  const isQueued = agent.status === 'queued';
  const isError = agent.status === 'error';

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      title={agent.mission || agent.label}
      className={`flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-lg border p-2.5 text-left transition-colors ${
        selected
          ? 'border-[#dcb67a]/60 bg-[#dcb67a]/[0.07]'
          : isThinking
            ? 'border-[#dcb67a]/35 bg-obsidian-panel'
            : 'border-obsidian-border bg-obsidian-panel hover:border-obsidian-raise'
      }`}
    >
      {/* Ad + durum */}
      <div className="flex items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${isThinking ? 'animate-pulse' : ''}`}
          style={{ backgroundColor: color }}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-obsidian-text">
          {agent.label}
        </span>
        {isThinking && <Loader2 size={11} className="shrink-0 animate-spin text-[#dcb67a]" />}
        {isError && <AlertTriangle size={11} className="shrink-0 text-[#D14D41]" />}
      </div>

      {/* İşlev + durum etiketi */}
      <div className="flex items-center gap-1.5 text-[9.5px] text-obsidian-muted">
        <span className="rounded bg-obsidian-raise/50 px-1 py-0.5">{kindLabel(t, agent.kind)}</span>
        <span className="truncate" style={{ color }}>
          {isThinking
            ? t('run.cardWorking')
            : isQueued
              ? t('run.cardQueued')
              : isError
                ? t('agents.status.error')
                : agent.calls > 0
                  ? t('run.cardDone')
                  : t('agents.status.idle')}
        </span>
      </div>

      {/* Şu an ne yapıyor / görevi */}
      <p className="m-0 line-clamp-2 text-[10.5px] leading-snug text-obsidian-soft">
        {agent.mission || t('run.working')}
      </p>

      {/* Performans şeridi: çağrı · token · süre · zarf */}
      <div className="mt-0.5 flex items-center gap-2 border-t border-obsidian-border/70 pt-1.5 font-mono text-[9.5px] text-obsidian-muted">
        <span title={t('run.cardCalls')}>
          {agent.calls}×
        </span>
        <span className="text-obsidian-muted/40">·</span>
        <span title={t('run.cardTokens')}>{agent.tokens_out > 999 ? `${(agent.tokens_out / 1000).toFixed(1)}k` : agent.tokens_out}t</span>
        {agent.last_ms > 0 && (
          <>
            <span className="text-obsidian-muted/40">·</span>
            <span title={t('run.cardDuration')}>
              {agent.last_ms < 1000 ? `${agent.last_ms}ms` : `${(agent.last_ms / 1000).toFixed(1)}s`}
            </span>
          </>
        )}
        {messageCount > 0 && (
          <>
            <span className="text-obsidian-muted/40">·</span>
            <span className="ml-auto text-obsidian-muted/70">{messageCount} msg</span>
          </>
        )}
      </div>
    </button>
  );
}

/** Şu an çalışan ajan için canlı satır. */
function WorkingRow({ agent }: { agent: AgentInfo }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2.5 border-b border-obsidian-border/60 py-2">
      <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#dcb67a]" aria-hidden />
      <span className="w-[92px] shrink-0 truncate text-[11.5px] font-medium text-obsidian-text">
        {agent.label}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-obsidian-muted">
        {agent.mission || t('run.working')}
      </span>
      <Loader2 size={12} className="shrink-0 animate-spin text-[#dcb67a]" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sonuçlar: kullanıcının karar verdiği yer
// ---------------------------------------------------------------------------

interface FileChange {
  file: string;
  edits: AgentEditRecord[];
  original: string | null;
  loading: boolean;
  state: 'idle' | 'writing' | 'applied' | 'error';
  message: string | null;
}

function DiffRows({ original, proposed }: { original: string; proposed: string }) {
  const t = useT();
  const lines = useMemo(() => computeLineDiff(original, proposed), [original, proposed]);
  const stats = useMemo(() => diffStats(lines), [lines]);
  const shown = lines.length > 300 ? lines.slice(0, 300) : lines;
  return (
    <>
      <div className="flex items-center gap-2 py-1 font-mono text-[10px] text-obsidian-muted">
        <span className="text-[#3AA99F]">+{stats.added}</span>
        <span className="text-[#D14D41]">-{stats.removed}</span>
        {lines.length > 300 && <span>{t('run.moreLines', { n: String(lines.length - 300) })}</span>}
      </div>
      <div className="max-h-[300px] overflow-auto font-mono text-[10.5px] leading-[1.5]">
        {shown.map((l, i) => {
          if (l.type === 'same') {
            return (
              <div key={i} className="flex text-obsidian-muted/60">
                <span className="w-3 shrink-0 select-none" />
                <span className="whitespace-pre-wrap break-all">{l.text || ' '}</span>
              </div>
            );
          }
          const added = l.type === 'added';
          return (
            <div
              key={i}
              className="flex"
              style={{
                color: added ? '#3AA99F' : '#D14D41',
                backgroundColor: added ? '#3AA99F0D' : '#D14D410D',
              }}
            >
              <span className="w-3 shrink-0 select-none">{added ? '+' : '-'}</span>
              <span className="whitespace-pre-wrap break-all">{l.text || ' '}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

function FileRow({
  change,
  onApply,
  onOpen,
  onToggle,
}: {
  change: FileChange;
  onApply: () => void;
  onOpen?: () => void;
  onToggle: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const isCreate = change.edits.every((e) => e.op === 'create');
  const result = useMemo(
    () => (change.original === null ? null : applyFileEdits(change.original, change.edits)),
    [change.original, change.edits]
  );
  const stats = useMemo(
    () => (result ? diffStats(computeLineDiff(change.original ?? '', result.code)) : null),
    [result, change.original]
  );
  const newBody = useMemo(() => change.edits.map((e) => e.body).join('\n'), [change.edits]);

  return (
    <div className="border-b border-obsidian-border/60 last:border-b-0">
      <div className="flex items-center gap-2 py-2">
        <button
          type="button"
          onClick={() => {
            setOpen((v) => !v);
            onToggle();
          }}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
          aria-expanded={open}
        >
          <span className="shrink-0 text-obsidian-muted">
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
          <span className="truncate font-mono text-[11px] text-obsidian-text">{change.file}</span>
          {isCreate ? (
            <span className="shrink-0 text-[10px] text-obsidian-muted">{t('run.newFile')}</span>
          ) : (
            stats && (
              <span className="shrink-0 font-mono text-[10px]">
                <span className="text-[#3AA99F]">+{stats.added}</span>{' '}
                <span className="text-[#D14D41]">-{stats.removed}</span>
              </span>
            )
          )}
        </button>

        {change.state === 'applied' ? (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-[#3AA99F]">
            <CheckCircle2 size={12} /> {t('run.applied')}
          </span>
        ) : (
          <button
            type="button"
            onClick={onApply}
            disabled={change.state === 'writing'}
            className="shrink-0 cursor-pointer rounded-md bg-obsidian-raise/70 px-2.5 py-1 text-[11px] text-obsidian-text transition-colors hover:bg-obsidian-raise disabled:opacity-50"
          >
            {change.state === 'writing' ? <Loader2 size={11} className="animate-spin" /> : t('run.apply')}
          </button>
        )}

        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            className="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-obsidian-muted transition-colors hover:bg-obsidian-raise/50 hover:text-obsidian-text"
            title={t('run.openInEditor')}
            aria-label={t('run.openInEditor')}
          >
            <ArrowUpRight size={12} />
          </button>
        )}
      </div>

      {change.message && (
        <p
          className={`m-0 pb-2 text-[10.5px] ${
            change.state === 'error' ? 'text-[#D14D41]' : 'text-obsidian-muted'
          }`}
        >
          {change.message}
        </p>
      )}

      {open && change.loading && (
        <p className="m-0 flex items-center gap-1.5 pb-2 text-[10.5px] text-obsidian-muted">
          <Loader2 size={11} className="animate-spin" /> {t('run.reading')}
        </p>
      )}
      {open && !change.loading && result && (
        <div className="pb-2">
          <DiffRows original={change.original ?? ''} proposed={result.code} />
        </div>
      )}
      {open && !change.loading && !result && (
        <pre className="m-0 mb-2 max-h-[240px] overflow-auto whitespace-pre-wrap break-all rounded-md bg-obsidian-panel p-2 font-mono text-[10.5px] leading-[1.5] text-[#3AA99F]">
          {newBody}
        </pre>
      )}
    </div>
  );
}

function Results({
  messages,
  onOpenFile,
  flush = false,
}: {
  messages: WireMessage[];
  onOpenFile?: (path: string) => void;
  /** Grid hücresinde: dış boşluk ve üst başlık hücre tarafından sağlanır. */
  flush?: boolean;
}) {
  const t = useT();
  const edits = useMemo(() => extractEdits(messages), [messages]);
  const grouped = useMemo(() => groupEditsByFile(edits), [edits]);
  const findings = useMemo(() => extractFindings(messages), [messages]);
  const report = useMemo(() => extractReport(messages), [messages]);
  const [files, setFiles] = useState<FileChange[]>([]);

  useEffect(() => {
    setFiles((prev) => {
      const byFile = new Map(prev.map((f) => [f.file, f]));
      return [...grouped.entries()].map(([file, list]) => {
        const old = byFile.get(file);
        return {
          file,
          edits: list,
          original: old?.original ?? null,
          loading: false,
          state: old?.state ?? 'idle',
          message: old?.message ?? null,
        };
      });
    });
  }, [grouped]);

  const patch = useCallback((file: string, next: Partial<FileChange>) => {
    setFiles((prev) => prev.map((f) => (f.file === file ? { ...f, ...next } : f)));
  }, []);

  const apply = useCallback(
    async (file: string) => {
      const target = files.find((f) => f.file === file);
      if (!target) return;
      patch(file, { state: 'writing', message: null });
      const original = target.original ?? (await readFileViaHost(file)) ?? '';
      if (target.original === null) patch(file, { original });
      const res = applyFileEdits(original, target.edits);
      if (res.applied === 0) {
        patch(file, { state: 'error', message: res.errors.join('; ') || t('run.searchNotFound') });
        return;
      }
      const written = await writeFileViaHost(file, res.code);
      if (!written.ok) {
        patch(file, {
          state: 'error',
          message:
            written.reason === 'dirty'
              ? t('run.dirtyBlocked')
              : written.reason === 'no-desktop'
                ? t('run.desktopOnly')
                : written.message || t('run.writeFailed'),
        });
        return;
      }
      patch(file, {
        state: 'applied',
        original: res.code,
        message: res.errors.length ? res.errors.join('; ') : null,
      });
    },
    [files, patch, t]
  );

  const applyAll = useCallback(async () => {
    for (const f of files) {
      if (f.state !== 'applied') await apply(f.file);
    }
  }, [files, apply]);

  const ensureOriginal = useCallback(
    async (file: string) => {
      const target = files.find((f) => f.file === file);
      if (!target || target.original !== null || target.loading) return;
      patch(file, { loading: true });
      const text = await readFileViaHost(file);
      patch(file, { loading: false, original: text ?? '' });
    },
    [files, patch]
  );

  const pending = files.filter((f) => f.state !== 'applied').length;
  if (files.length === 0 && findings.length === 0 && report.length === 0) return null;

  return (
    <section className={flush ? '' : 'mt-6'}>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="m-0 text-[12px] font-semibold text-obsidian-text">{t('run.results')}</h3>
        {files.length > 0 && pending > 0 && (
          <button
            type="button"
            onClick={() => void applyAll()}
            className="ml-auto flex cursor-pointer items-center gap-1 rounded-md bg-[#dcb67a] px-2.5 py-1 text-[11px] font-medium text-[#141210] transition-colors hover:bg-[#EBCB99]"
          >
            <Wand2 size={11} /> {t('run.applyAll')}
          </button>
        )}
      </div>

      {files.length > 0 && (
        <div className="border-t border-obsidian-border">
          {files.map((f) => (
            <FileRow
              key={f.file}
              change={f}
              onApply={() => void apply(f.file)}
              onToggle={() => void ensureOriginal(f.file)}
              onOpen={onOpenFile ? () => onOpenFile(f.file) : undefined}
            />
          ))}
        </div>
      )}

      {findings.length > 0 && (
        <div className="mt-4">
          <h4 className="mb-1 text-[11.5px] font-medium text-obsidian-soft">
            {t('run.reviewHeading')}{' '}
            <span className="font-mono text-[10.5px] text-obsidian-muted">{findings.length}</span>
          </h4>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {findings.map((f, i) => {
              const sev =
                f.severity === 'error' ? '#D14D41' : f.severity === 'warn' ? '#D0A215' : '#4385BE';
              return (
                <li key={`${f.code}-${i}`} className="flex items-start gap-2 text-[11.5px]">
                  <span
                    className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: sev }}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 text-obsidian-soft">{f.message || f.code}</span>
                  {f.file && (
                    <span className="shrink-0 font-mono text-[10px] text-obsidian-muted">{f.file}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {report.length > 0 && (
        <p className="m-0 mt-4 text-[11px] text-obsidian-muted">
          {report.map((r) => `${r.metric}: ${r.value}`).join(' · ')}
        </p>
      )}
    </section>
  );
}

/** Plan hücresi: planlayıcıların böldüğü adımlar. */
function PlanCell({ messages }: { messages: WireMessage[] }) {
  const t = useT();
  const steps = useMemo(() => extractPlanSteps(messages), [messages]);
  if (steps.length === 0) {
    return <p className="m-0 text-[11px] text-obsidian-muted">{t('run.planEmpty')}</p>;
  }
  return (
    <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
      {steps.map((s, i) => (
        <li key={`${s.id}-${i}`} className="flex flex-col gap-0.5">
          <div className="flex items-baseline gap-1.5">
            <span className="w-5 shrink-0 text-right font-mono text-[9.5px] text-obsidian-muted">
              {s.id || i + 1}
            </span>
            <span className="min-w-0 flex-1 text-[11px] leading-snug text-obsidian-soft">{s.title}</span>
            {s.risk && s.risk !== 'low' && (
              <span
                className="shrink-0 rounded px-1 py-0.5 text-[8.5px] uppercase"
                style={{
                  color: s.risk === 'high' ? '#D14D41' : '#D0A215',
                  backgroundColor: s.risk === 'high' ? '#D14D411A' : '#D0A2151A',
                }}
              >
                {s.risk}
              </span>
            )}
          </div>
          {s.files && (
            <span className="truncate pl-6 font-mono text-[9px] text-obsidian-muted/80">
              {s.files.replace(/\|/g, ' · ')}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Teknik ayrıntı: ham zarflar ve tel biçimi. Varsayılan kapalı. */
function Details({ state }: { state: RunState }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [seq, setSeq] = useState<number | null>(null);
  const msg = state.messages.find((x) => x.seq === seq) ?? null;
  const saved = state.metrics.raw_tokens - state.metrics.wire_tokens;

  return (
    <section className="mt-8 border-t border-obsidian-border pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex cursor-pointer items-center gap-1.5 text-[10.5px] text-obsidian-muted transition-colors hover:text-obsidian-soft"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {t('run.details')}
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-2">
          <p className="m-0 text-[10.5px] leading-relaxed text-obsidian-muted">
            {t('run.detailsHint', {
              raw: fmt(state.metrics.raw_tokens),
              wire: fmt(state.metrics.wire_tokens),
              saved: fmt(saved),
            })}
          </p>
          <div className="flex flex-wrap gap-1">
            {state.messages.map((x) => (
              <button
                key={x.seq}
                type="button"
                onClick={() => setSeq(seq === x.seq ? null : x.seq)}
                className={`cursor-pointer rounded px-1.5 py-0.5 font-mono text-[9.5px] transition-colors ${
                  seq === x.seq
                    ? 'bg-obsidian-raise text-obsidian-text'
                    : 'bg-obsidian-panel text-obsidian-muted hover:text-obsidian-soft'
                }`}
                title={`#${x.seq} ${x.from} · ${x.kind}`}
              >
                #{x.seq}
              </button>
            ))}
          </div>
          {msg && (
            <>
              <pre className="m-0 max-h-[220px] overflow-auto whitespace-pre-wrap break-all rounded-md bg-obsidian-panel p-2 font-mono text-[10px] text-obsidian-soft">
                {JSON.stringify(msg.raw, null, 2)}
              </pre>
              <pre className="m-0 max-h-[140px] overflow-auto whitespace-pre-wrap break-all rounded-md bg-obsidian-panel p-2 font-mono text-[9.5px] text-[#3AA99F]/80">
                {msg.wire}
              </pre>
              <p className="m-0 font-mono text-[9.5px] text-obsidian-muted">
                {fmt(msg.raw_tokens)} → {fmt(msg.wire_tokens)} tok
                {msg.compressed ? ` · @T${msg.lossless ? ' lossless' : ''}` : ''}
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Ana bileşen
// ---------------------------------------------------------------------------

export function AgentMesh({
  embedded = false,
  initialTask = '',
  org,
  onOpenFile,
}: {
  embedded?: boolean;
  initialTask?: string;
  /** Kullanıcının ajan şirketi; verilirse koşu bu düğümlerle yapılır. */
  org?: OrgRunPlan | null;
  /** "Editörde aç" — verilirse dosya satırlarında görünür. */
  onOpenFile?: (path: string) => void;
} = {}) {
  const t = useT();
  const [task, setTask] = useState(initialTask);
  const [maxTasks, setMaxTasks] = useState(5);
  const [useMock, setUseMock] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [providerLabel, setProviderLabel] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [state, setState] = useState<RunState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filterAgent, setFilterAgent] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [, setTick] = useState(0);

  /**
   * Grid sütun sayısını PANEL genişliği belirler: >= 900px ise iki sütun
   * (akış | sonuçlar), altında tek sütun. Ölçüm mount'ta AÇIKÇA yapılır —
   * ResizeObserver'ın ilk geri çağrısı gizliyken 0 verebiliyor.
   */
  const rootRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = (w: number) => setWide(w >= 900);
    measure(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) measure(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Kök ajanın misyonu yalnızca BOŞ girdiye öneri olarak gelir.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !initialTask) return;
    seededRef.current = true;
    setTask((prev) => (prev ? prev : initialTask));
  }, [initialTask]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const p = await getActiveProvider();
        if (!cancelled) setProviderLabel(p ? `${p.name} · ${p.model}` : '');
      } catch {
        if (!cancelled) setProviderLabel('');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Geçen süre sayacı: yalnızca koşu varken çalışır.
  useEffect(() => {
    if (!runId && !busy) return undefined;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [runId, busy]);

  // Panel kapatılıp açıldığında koşu yetim kalmasın: son koşuya yeniden bağlan.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const s = await fetchLastRunState();
      if (!alive || !s) return;
      setState(s);
      setRunId(s.run_id);
      setBusy(!AGENT_TERMINAL.includes(s.status));
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sunucu-otoriteli durumu yokla.
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    let timer: number | undefined;
    let failures = 0;
    const tick = async () => {
      try {
        const s = await fetchAgentState(runId);
        if (!alive) return;
        failures = 0;
        setState(s);
        if (!AGENT_TERMINAL.includes(s.status)) {
          timer = window.setTimeout(tick, 700);
        } else {
          setBusy(false);
        }
      } catch (e) {
        if (!alive) return;
        failures += 1;
        if (failures >= 3) {
          setError(String(e));
          setBusy(false);
        } else {
          timer = window.setTimeout(tick, 900);
        }
      }
    };
    void tick();
    return () => { alive = false; if (timer) window.clearTimeout(timer); };
  }, [runId]);

  // Maliyet tahmini: gerçek model id'si × birim fiyat; fiyat yoksa sayı yok.
  const [livePricing] = useState(() => {
    try { return localStorage.getItem('tlm_online_pricing') === 'true'; } catch { return false; }
  });
  const prices = usePriceMap(livePricing);
  const [model, setModel] = useState('');
  useEffect(() => {
    let alive = true;
    getActiveProvider()
      .then((p) => { if (alive) setModel(p?.model ?? ''); })
      .catch(() => { if (alive) setModel(''); });
    return () => { alive = false; };
  }, []);
  const price = priceForModel(prices, model);

  // Koşu öncesi ekip önizlemesi (backend sınıflandırmasının aynısı).
  const previewAgents = useMemo<AgentInfo[]>(() => {
    if (!org || org.agents.length === 0) return [];
    const childCount = new Map<string, number>();
    for (const a of org.agents) {
      if (a.parentId) childCount.set(a.parentId, (childCount.get(a.parentId) || 0) + 1);
    }
    return org.agents.map((a) => {
      const text = `${a.role} ${a.name}`.toLowerCase();
      let kind = 'result';
      if ((childCount.get(a.id) || 0) > 0) kind = 'plan';
      else if (/(review|qa|test|audit|verify|check|denet|kontrol)/.test(text)) kind = 'review';
      else if (/(report|summary|lead|chief|rapor|özet|lider)/.test(text)) kind = 'report';
      return {
        id: a.id,
        label: a.name || a.id,
        status: 'idle',
        kind,
        parent: a.parentId,
        mission: a.mission.split('\n')[0]?.trim().slice(0, 90) || '',
        calls: 0,
        tokens_in: 0,
        tokens_out: 0,
        last_ms: 0,
      };
    });
  }, [org]);

  const handleRun = useCallback(async () => {
    const text = task.trim();
    if (!text || busy) return;
    setError(null);
    setState(null);
    setRunId(null);
    setFilterAgent(null);
    setBusy(true);
    let req: StartRunRequest;
    if (useMock) {
      req = { provider: AGENT_MOCK_PROVIDER, model: 'mock', task: text, max_tasks: maxTasks };
    } else {
      const p = await getActiveProvider();
      if (!p) {
        setError(t('run.needProvider'));
        setShowSetup(true);
        setBusy(false);
        return;
      }
      req = {
        provider: p.id,
        base_url: p.baseUrl || undefined,
        use_stored_key: true,
        model: p.model,
        task: text,
        max_tasks: maxTasks,
      };
    }
    if (org && org.agents.length > 0) {
      req.org = {
        name: org.name,
        agents: org.agents.map((a) => ({
          id: a.id,
          parentId: a.parentId,
          name: a.name,
          role: a.role,
          mission: a.mission,
          resp: a.resp,
        })),
        links: org.links.map((l) => ({ from: l.from, to: l.to, label: l.label })),
      };
    }
    try {
      const id = await startAgentRun(req);
      saveLastRunId(id);
      setRunId(id);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }, [task, busy, useMock, maxTasks, org, t]);

  const handleStop = useCallback(async () => {
    if (!runId) return;
    await cancelAgentRun(runId).catch(() => false);
  }, [runId]);

  const agents = state?.agents?.length ? state.agents : previewAgents;
  const labelOf = useCallback(
    (id: string) => agents.find((a) => a.id === id)?.label || id,
    [agents]
  );

  const status = state?.status ?? (busy ? 'running' : 'idle');
  const statusLabel = (t as unknown as (k: string) => string)(`agents.status.${status}`);
  const running = status === 'running' || status === 'queued';
  const finished = !!state && !running;

  const activeAgents = useMemo(() => agents.filter((a) => a.status === 'thinking'), [agents]);
  const queued = agents.filter((a) => a.status === 'queued').length;

  const elapsedMs = state ? Math.max(0, (state.finished_ms ?? Date.now()) - state.started_ms) : 0;
  const m = state?.metrics;
  const estCost = m && price !== undefined ? m.wire_tokens * price : null;

  const timeline = useMemo(() => {
    const msgs = state?.messages ?? [];
    return filterAgent ? msgs.filter((x) => x.from === filterAgent) : msgs;
  }, [state?.messages, filterAgent]);

  // Canlı takip: yeni satır geldikçe en alta in; kullanıcı yukarıdaysa dur.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);
  useEffect(() => {
    if (!running || !stickRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [timeline.length, running, activeAgents.length]);

  const buildSummary = useCallback((): string => {
    if (!state) return '';
    const steps = extractPlanSteps(state.messages);
    const edits = extractEdits(state.messages);
    const finds = extractFindings(state.messages);
    const L: string[] = [`## ${state.task}`, ''];
    L.push(
      t('run.summaryLine', {
        files: String(new Set(edits.map((e) => e.file)).size),
        calls: String(state.metrics.llm_calls),
        tokens: fmt(state.metrics.wire_tokens),
        time: fmtElapsed(elapsedMs),
      })
    );
    if (steps.length) {
      L.push('', '### ' + t('run.planHeading'), '');
      for (const s of steps) {
        L.push(`- **${s.id || '-'}** ${s.title}${s.files ? ` — \`${s.files}\`` : ''}`);
      }
    }
    if (edits.length) {
      L.push('', '### ' + t('run.results'), '');
      for (const [file, list] of groupEditsByFile(edits)) {
        L.push(`- \`${file}\` (${list.length})`);
      }
    }
    if (finds.length) {
      L.push('', '### ' + t('run.reviewHeading'), '');
      for (const f of finds) L.push(`- **[${f.severity}]** ${f.message || f.code}`);
    }
    return L.join('\n');
  }, [state, elapsedMs, t]);

  const copySummary = useCallback(async () => {
    const text = buildSummary();
    if (!text) return;
    const ok = await copyToClipboard(text);
    setCopyState(ok ? 'ok' : 'fail');
    window.setTimeout(() => setCopyState('idle'), 1800);
  }, [buildSummary]);

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col bg-obsidian-bg text-obsidian-soft">
      {/* ── Görev çubuğu ─────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-obsidian-border px-4 py-3">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleRun(); }}
            placeholder={t('run.taskPlaceholder')}
            aria-label={t('run.taskPlaceholder')}
            className="min-w-0 flex-1 rounded-lg border border-obsidian-border bg-obsidian-panel px-3 py-2 text-[12.5px] text-obsidian-text outline-none transition-colors placeholder:text-obsidian-muted/50 focus:border-[#dcb67a]/50"
          />
          <button
            type="button"
            onClick={() => setShowSetup((v) => !v)}
            className={`grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-lg border transition-colors ${
              showSetup
                ? 'border-[#dcb67a]/50 bg-[#dcb67a]/10 text-[#dcb67a]'
                : 'border-obsidian-border text-obsidian-muted hover:text-obsidian-soft'
            }`}
            title={t('run.settings')}
            aria-label={t('run.settings')}
            aria-expanded={showSetup}
          >
            <Settings2 size={14} />
          </button>
          {running ? (
            <button
              type="button"
              onClick={() => void handleStop()}
              className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-[#D14D41]/40 bg-[#D14D41]/10 px-3 text-[12px] font-medium text-[#D14D41] transition-colors hover:bg-[#D14D41]/20"
            >
              <Square size={11} /> {t('run.stop')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleRun()}
              disabled={!task.trim()}
              className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-[#dcb67a] px-3.5 text-[12px] font-medium text-[#141210] transition-colors hover:bg-[#EBCB99] disabled:cursor-default disabled:opacity-40"
            >
              {finished ? <RotateCcw size={12} /> : <Play size={12} />}
              {finished ? t('run.again') : t('run.start')}
            </button>
          )}
        </div>

        {showSetup && (
          <div className="mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-obsidian-border bg-obsidian-panel px-3 py-2 text-[11px]">
            <div className="flex overflow-hidden rounded-md border border-obsidian-border" role="group">
              <button
                type="button"
                onClick={() => setUseMock(true)}
                className={`cursor-pointer px-2.5 py-1 transition-colors ${
                  useMock ? 'bg-obsidian-raise/70 text-obsidian-text' : 'text-obsidian-muted hover:text-obsidian-soft'
                }`}
              >
                {t('run.mock')}
              </button>
              <button
                type="button"
                onClick={() => setUseMock(false)}
                className={`cursor-pointer border-l border-obsidian-border px-2.5 py-1 transition-colors ${
                  !useMock ? 'bg-obsidian-raise/70 text-obsidian-text' : 'text-obsidian-muted hover:text-obsidian-soft'
                }`}
              >
                {t('run.provider')}
              </button>
            </div>
            <span className="min-w-0 flex-1 truncate text-obsidian-muted">
              {useMock ? t('run.mockHint') : providerLabel || t('run.providerHint')}
            </span>
            {!(org && org.agents.length > 0) && (
              <label className="flex shrink-0 items-center gap-1.5 text-obsidian-muted">
                {t('run.maxTasks')}
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={maxTasks}
                  onChange={(e) => setMaxTasks(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                  className="w-10 rounded border border-obsidian-border bg-obsidian-bg px-1 py-0.5 text-center font-mono text-[10.5px] text-obsidian-soft outline-none"
                />
              </label>
            )}
          </div>
        )}

        {/* Durum + ikincil metrikler: tek satır, kutu yok. */}
        {state && (
          <div className="mt-2 flex items-center gap-x-2 gap-y-1 text-[11px] text-obsidian-muted">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? 'animate-pulse' : ''}`}
              style={{ backgroundColor: STATUS_COLOR[status] || '#87857F' }}
              aria-hidden
            />
            <span style={{ color: running ? '#dcb67a' : undefined }}>{statusLabel}</span>
            <span className="text-obsidian-muted/40">·</span>
            <span className="font-mono tabular-nums">{fmtElapsed(elapsedMs)}</span>
            {m && m.llm_calls > 0 && (
              <>
                <span className="text-obsidian-muted/40">·</span>
                <span>
                  {m.llm_calls} {t('run.calls')}
                  {m.repairs > 0 ? ` · ${m.repairs} ${t('run.repairs')}` : ''}
                </span>
              </>
            )}
            {m && m.wire_tokens > 0 && (
              <>
                <span className="text-obsidian-muted/40">·</span>
                <span title={t('run.tokensTitle')}>
                  {fmt(m.wire_tokens)} {t('run.tokens')}
                  <span className="text-[#3AA99F]"> (−{Math.round(m.savings_pct)}%)</span>
                </span>
              </>
            )}
            {estCost !== null && (
              <>
                <span className="text-obsidian-muted/40">·</span>
                <span className="font-mono">
                  ≈${estCost < 0.01 ? estCost.toFixed(4) : estCost.toFixed(3)}
                </span>
              </>
            )}
            {finished && (
              <button
                type="button"
                onClick={() => void copySummary()}
                className="ml-auto shrink-0 cursor-pointer text-[10.5px] text-obsidian-muted underline decoration-obsidian-border underline-offset-2 transition-colors hover:text-obsidian-text"
              >
                {copyState === 'ok'
                  ? t('run.copied')
                  : copyState === 'fail'
                    ? t('run.copyFailed')
                    : t('run.copySummary')}
              </button>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-[#D14D41]/30 bg-[#D14D41]/10 px-3 py-2 text-[11.5px] text-[#D14D41]">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}

      {/* ── YÖNETİM PANOSU: tek ekran, çok hücre ───────────────────
          Bakan kişi her şeyi aynı anda görür:
            sol üst  = AJANLAR (kim ne durumda, kaç çağrı/token/süre)
            sol alt  = CANLI AKIŞ (zarf satırları, otomatik takip)
            sağ üst  = PLAN (planlayıcının böldüğü adımlar)
            sağ alt  = SONUÇLAR (diff + Uygula) ve BULGULAR
          Her hücre KENDİ içinde kayar; sayfa hiç kaymaz. Dar panelde
          aynı hücreler tek sütunda alt alta dizilir. */}
      <div
        className={`min-h-0 flex-1 overflow-hidden p-3 ${
          wide
            ? 'grid grid-cols-[minmax(0,1.35fr)_minmax(340px,1fr)] grid-rows-[minmax(190px,0.42fr)_minmax(0,1fr)] gap-3'
            : 'flex flex-col gap-3 overflow-y-auto'
        }`}
      >
        {/* SOL ÜST: AJAN KARTLARI */}
        <section
          className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-obsidian-border bg-obsidian-panel/30"
          aria-labelledby="run-agents"
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-obsidian-border px-2.5 py-1.5">
            <h3 id="run-agents" className="m-0 text-[10.5px] font-semibold uppercase tracking-wide text-obsidian-muted">
              {t('run.cellAgents')}
            </h3>
            <span className="font-mono text-[9.5px] text-obsidian-muted/70">
              {state ? `${agents.filter((a) => a.calls > 0 || a.status === 'thinking').length}/${agents.length}` : t('run.cardsReady', { n: String(agents.length) })}
            </span>
            {running && (
              <span className="ml-auto flex items-center gap-1 text-[10px] text-[#dcb67a]">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#dcb67a]" />
                {activeAgents.length > 0 ? activeAgents.map((a) => a.label).join(', ') : t('run.starting')}
              </span>
            )}
            {filterAgent && (
              <button
                type="button"
                onClick={() => setFilterAgent(null)}
                className="ml-auto flex cursor-pointer items-center gap-1 rounded bg-[#dcb67a]/15 px-1.5 py-0.5 text-[9.5px] text-[#dcb67a]"
              >
                {labelOf(filterAgent)} ×
              </button>
            )}
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {agents.length === 0 ? (
              <p className="m-0 px-1 py-2 text-[11px] text-obsidian-muted">{t('run.intro')}</p>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {agents.map((a) => (
                  <AgentCard
                    key={a.id}
                    agent={a}
                    selected={filterAgent === a.id}
                    messageCount={(state?.messages ?? []).filter((m) => m.from === a.id).length}
                    onSelect={() => setFilterAgent((prev) => (prev === a.id ? null : a.id))}
                  />
                ))}
              </div>
            )}
          </div>
        </section>

        {/* SOL ALT: CANLI AKIŞ */}
        <section
          className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-obsidian-border bg-obsidian-panel/30"
          aria-labelledby="run-stream"
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-obsidian-border px-2.5 py-1.5">
            <h3 id="run-stream" className="m-0 text-[10.5px] font-semibold uppercase tracking-wide text-obsidian-muted">
              {t('run.cellStream')}
            </h3>
            <span className="font-mono text-[9.5px] text-obsidian-muted/70">{timeline.length}</span>
            {running && <span className="text-[9.5px] text-obsidian-muted/60">{t('run.following')}</span>}
          </header>
          <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-2.5 py-1">
            {timeline.length === 0 ? (
              <p className="m-0 py-2 text-[11px] text-obsidian-muted">
                {busy ? t('run.starting') : t('run.streamEmpty')}
              </p>
            ) : (
              <div className="border-t border-obsidian-border">
                {timeline.map((msg) => (
                  <MessageRow
                    key={msg.seq}
                    msg={msg}
                    label={labelOf(msg.from)}
                    onTrace={() => setFilterAgent(msg.from)}
                  />
                ))}
              </div>
            )}
            {running && activeAgents.length > 0 && (
              <div className="border-t border-obsidian-border">
                {activeAgents.map((a) => (
                  <WorkingRow key={a.id} agent={a} />
                ))}
              </div>
            )}
            {running && queued > 0 && (
              <p className="m-0 py-1.5 text-[10px] text-obsidian-muted">{t('run.queued', { n: String(queued) })}</p>
            )}
            {state?.error && (
              <div className="my-2 flex items-start gap-2 rounded border border-[#D14D41]/30 bg-[#D14D41]/10 px-2 py-1.5 text-[11px] text-[#D14D41]">
                <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                <span className="break-all">{state.error}</span>
              </div>
            )}
            {finished && state && state.messages.length === 0 && !state.error && (
              <p className="m-0 py-2 flex items-center gap-2 text-[11px] text-obsidian-muted">
                <Info size={11} /> {t('run.noOutput')}
              </p>
            )}
            {state && state.messages.length > 0 && <Details state={state} />}
          </div>
        </section>

        {/* SAĞ ÜST: PLAN */}
        <section
          className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-obsidian-border bg-obsidian-panel/30"
          aria-labelledby="run-plan"
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-obsidian-border px-2.5 py-1.5">
            <h3 id="run-plan" className="m-0 text-[10.5px] font-semibold uppercase tracking-wide text-obsidian-muted">
              {t('run.cellPlan')}
            </h3>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
            <PlanCell messages={state?.messages ?? []} />
          </div>
        </section>

        {/* SAĞ ALT: SONUÇLAR + BULGULAR */}
        <section
          className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-obsidian-border bg-obsidian-panel/30"
          aria-labelledby="run-results"
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-obsidian-border px-2.5 py-1.5">
            <h3 id="run-results" className="m-0 text-[10.5px] font-semibold uppercase tracking-wide text-obsidian-muted">
              {t('run.cellResults')}
            </h3>
            {state && state.messages.length > 0 && (
              <span className="font-mono text-[9.5px] text-obsidian-muted/70">
                {extractEdits(state.messages).length} ed
              </span>
            )}
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
            {state ? (
              <>
                <Results messages={state.messages} onOpenFile={onOpenFile} flush />
                {state.messages.length === 0 && (
                  <p className="m-0 text-[11px] text-obsidian-muted">{t('run.resultsEmpty')}</p>
                )}
              </>
            ) : (
              <p className="m-0 text-[11px] text-obsidian-muted">{t('run.resultsEmpty')}</p>
            )}
          </div>
        </section>
      </div>

      {embedded && !state && (
        <p className="m-0 shrink-0 border-t border-obsidian-border px-4 py-2 text-[10.5px] text-obsidian-muted">
          {org && org.agents.length > 0 ? t('run.teamHint') : t('run.intro')}
        </p>
      )}
    </div>
  );
}
