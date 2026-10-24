import React, { useState, useEffect, useCallback } from 'react';
import { Play, Square, Network, Cpu, Braces, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { useT } from '../lib/i18n';
import { getActiveProvider } from '../services/aiClient';
import { priceForModel, usePriceMap } from '../lib/pricing';
import {
  AGENT_MOCK_PROVIDER,
  AGENT_TERMINAL,
  cancelAgentRun,
  fetchAgentState,
  startAgentRun,
  type RunState,
  type StartRunRequest,
  type WireMessage,
} from '../services/agentClient';

// Ajan Ağı paneli — Projeler bölümünün merkez sütununda, editör yerine görünür.
//
// Ayırt edici fikir: ajanlar birbirine SERBEST METİN yazmaz; her tur tek bir
// tipli JSON zarfıdır ve zarfın tel biçimi mevcut kayıpsız @T motorundan geçer.
// Bu panel; rolleri, canlı zarf akışını ("Doğal" / "Tel"), token bilançosunu ve
// tahmini maliyeti dürüstçe gösterir. Koşu sunucu-otoritelidir; buradaki her
// sayı backend'den geldiği gibidir.

const STATUS_COLOR: Record<string, string> = {
  idle: '#575654',
  thinking: '#D0A215',
  done: '#3AA99F',
  error: '#D14D41',
  queued: '#575654',
  running: '#D0A215',
  failed: '#D14D41',
  cancelled: '#87857F',
};

const KIND_COLOR: Record<string, string> = {
  plan: '#4385BE',
  result: '#3AA99F',
  review: '#dcb67a',
  report: '#a78bfa',
};

const ROLE_ICON: Record<string, React.ReactNode> = {
  planner: <Network size={13} />,
  coder: <Braces size={13} />,
  reviewer: <AlertTriangle size={13} />,
  reporter: <Cpu size={13} />,
};

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function MessageCard({ msg }: { msg: WireMessage }) {
  const t = useT();
  const [view, setView] = useState<'natural' | 'wire'>('natural');
  const saved = msg.raw_tokens - msg.wire_tokens;
  const pct = msg.raw_tokens > 0 ? Math.round((saved / msg.raw_tokens) * 100) : 0;
  const kindColor = KIND_COLOR[msg.kind] || '#87857F';

  return (
    <div className="border border-[#34332F] rounded-md bg-[#1C1B1A] overflow-hidden shrink-0">
      <div className="flex items-center gap-2 px-2.5 py-1.5 bg-[#282726] border-b border-[#34332F] text-[11px] font-mono">
        <span className="text-[#5F5C57]">#{msg.seq}</span>
        <span className="text-[#CECDC3]">{msg.from}</span>
        <span className="text-[#5F5C57]">→</span>
        <span className="text-[#A8A49E]">{msg.to.length ? msg.to.join(',') : '—'}</span>
        <span className="px-1.5 py-0.5 rounded text-[10px]" style={{ color: kindColor, backgroundColor: `${kindColor}1A` }}>
          {msg.kind}
        </span>
        {msg.task && (
          <span className="px-1.5 py-0.5 rounded bg-[#34332F] text-[#A8A49E] text-[10px]">{msg.task}</span>
        )}
        {msg.status !== 'ok' && (
          <span className="px-1.5 py-0.5 rounded text-[10px]" style={{ color: '#D14D41', backgroundColor: '#D14D411A' }}>
            {msg.status}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <span className="text-[#87857F]">{fmt(msg.raw_tokens)}→{fmt(msg.wire_tokens)} tok</span>
          {msg.compressed && (
            <span className="px-1.5 py-0.5 rounded bg-[#3AA99F]/12 text-[#3AA99F] text-[10px]">-{pct}%</span>
          )}
          <span
            className="px-1.5 py-0.5 rounded text-[10px]"
            style={
              msg.compressed
                ? { color: '#3AA99F', backgroundColor: '#3AA99F14' }
                : { color: '#87857F', backgroundColor: '#34332F80' }
            }
            title={msg.compressed ? t('agents.wireVerified') : t('agents.wirePlain')}
          >
            {msg.compressed ? '@T' : 'json'}
          </span>
        </span>
      </div>

      <div className="flex items-center gap-1 px-2 pt-1.5">
        <button
          type="button"
          onClick={() => setView('natural')}
          className={`px-2 py-0.5 rounded text-[10px] font-medium cursor-pointer transition-colors ${
            view === 'natural' ? 'bg-[#4385BE]/15 text-[#4385BE]' : 'text-[#87857F] hover:text-[#CECDC3]'
          }`}
        >
          {t('agents.viewNatural')}
        </button>
        <button
          type="button"
          onClick={() => setView('wire')}
          className={`px-2 py-0.5 rounded text-[10px] font-medium cursor-pointer transition-colors ${
            view === 'wire' ? 'bg-[#3AA99F]/15 text-[#3AA99F]' : 'text-[#87857F] hover:text-[#CECDC3]'
          }`}
        >
          {t('agents.viewWire')}
        </button>
      </div>

      <pre className="m-0 px-2.5 py-2 text-[11px] font-mono text-[#CECDC3] whitespace-pre-wrap break-all max-h-[240px] overflow-auto">
        {view === 'natural' ? JSON.stringify(msg.raw, null, 2) : msg.wire}
      </pre>
    </div>
  );
}

export function AgentMesh({ embedded = false, initialTask = '' }: { embedded?: boolean; initialTask?: string } = {}) {
  const t = useT();
  const [task, setTask] = useState(initialTask);
  const [maxTasks, setMaxTasks] = useState(5);
  // Varsayılan GERÇEK sağlayıcı; mock yalnız ağsız test için açıkça seçilir.
  const [useMock, setUseMock] = useState(false);
  const [providerLabel, setProviderLabel] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [state, setState] = useState<RunState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDecoder, setShowDecoder] = useState(false);

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

  // Sunucu-otoriteli durumu yokla (bitiş durumunda durur).
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const s = await fetchAgentState(runId);
        if (!alive) return;
        setState(s);
        if (!AGENT_TERMINAL.includes(s.status)) {
          timer = window.setTimeout(tick, 700);
        } else {
          setBusy(false);
        }
      } catch (e) {
        if (!alive) return;
        setError(String(e));
        setBusy(false);
      }
    };
    void tick();
    return () => { alive = false; if (timer) window.clearTimeout(timer); };
  }, [runId]);

  // Maliyet tahmini: aktif sağlayıcının GERÇEK model id'si × birim fiyat.
  // Fiyat bilinmiyorsa sayı uydurulmaz (— gösterilir).
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

  const handleRun = useCallback(async () => {
    const text = task.trim();
    if (!text) return;
    setError(null);
    setState(null);
    setBusy(true);
    let req: StartRunRequest;
    if (useMock) {
      req = { provider: AGENT_MOCK_PROVIDER, model: 'mock', task: text, max_tasks: maxTasks };
    } else {
      const p = await getActiveProvider();
      if (!p) {
        setError(t('agents.needProvider'));
        setBusy(false);
        return;
      }
      req = {
        provider: p.id,
        base_url: p.baseUrl || undefined,
        api_key: p.key,
        model: p.model,
        task: text,
        max_tasks: maxTasks,
      };
    }
    try {
      const id = await startAgentRun(req);
      setRunId(id);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }, [task, useMock, maxTasks, t]);

  const handleStop = useCallback(async () => {
    if (!runId) return;
    await cancelAgentRun(runId).catch(() => false);
  }, [runId]);

  const m = state?.metrics;
  const statusLabel = state ? (t as unknown as (k: string) => string)(`agents.status.${state.status}`) : '';
  const estCost = m && price !== undefined ? m.wire_tokens * price : null;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#1C1B1A] text-[#CECDC3]">
      {/* Header — gömülü modda Agent Company başlığı zaten var; ama ne işe
          yaradığı anlaşılsın diye kısa bir açıklama her modda gösterilir. */}
      {!embedded && (
        <div className="px-3 py-2 border-b border-[#34332F] flex-shrink-0">
          <div className="flex items-center gap-2">
            <Network size={15} className="text-[#3AA99F]" />
            <h2 className="text-[13px] font-semibold text-[#F2F0E5]">{t('agents.title')}</h2>
            {state && (
              <span className="flex items-center gap-1.5 text-[11px] font-mono">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${state.status === 'running' ? 'animate-pulse' : ''}`}
                  style={{ backgroundColor: STATUS_COLOR[state.status] || '#87857F' }}
                />
                <span className="text-[#A8A49E]">{statusLabel}</span>
                <span className="text-[#5F5C57]">·</span>
                <span className="text-[#87857F]">{t('agents.phase')}: {state.phase}</span>
              </span>
            )}
          </div>
          <p className="text-[11px] text-[#87857F] mt-1 leading-relaxed">{t('agents.subtitle')}</p>
        </div>
      )}
      {embedded && (
        <div className="px-3 pt-2.5 pb-1 border-b border-[#34332F] flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold text-[#F2F0E5]">{t('company.runTitle')}</span>
            {state && (
              <span className="flex items-center gap-1.5 text-[10.5px] font-mono ml-auto">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${state.status === 'running' ? 'animate-pulse' : ''}`}
                  style={{ backgroundColor: STATUS_COLOR[state.status] || '#87857F' }}
                />
                <span className="text-[#A8A49E]">{statusLabel}</span>
              </span>
            )}
          </div>
          <p className="text-[10.5px] text-[#87857F] mt-0.5 leading-relaxed">{t('agents.embeddedHint')}</p>
        </div>
      )}

      {/* Composer */}
      <div className="px-3 py-2 border-b border-[#34332F] flex-shrink-0 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void handleRun(); }}
            placeholder={t('agents.taskPlaceholder')}
            className="flex-1 min-w-0 bg-[#100F0F] border border-[#34332F] focus:border-[#3AA99F]/60 rounded-md px-2.5 py-1.5 text-[12px] text-[#F2F0E5] outline-none transition-colors"
          />
          <label className="flex items-center gap-1 text-[11px] text-[#87857F] whitespace-nowrap">
            {t('agents.maxTasks')}
            <input
              type="number"
              min={1}
              max={8}
              value={maxTasks}
              onChange={(e) => setMaxTasks(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
              className="w-12 bg-[#100F0F] border border-[#34332F] rounded px-1.5 py-1 text-[11px] text-[#CECDC3] outline-none"
            />
          </label>
          {busy ? (
            <button
              type="button"
              onClick={() => void handleStop()}
              className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-[#D14D41]/15 text-[#D14D41] border border-[#D14D41]/30 text-[11px] font-medium cursor-pointer hover:bg-[#D14D41]/25 transition-colors"
            >
              <Square size={12} /> {t('agents.stop')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleRun()}
              disabled={!task.trim()}
              className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-[#205EA6] hover:bg-[#4385BE] disabled:opacity-40 disabled:cursor-not-allowed text-white text-[11px] font-medium cursor-pointer transition-colors"
            >
              <Play size={12} /> {t('agents.run')}
            </button>
          )}
        </div>

        {/* Mod seçimi: radyo düğüm yığını yerine segment kontrol. */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-[#6F6C66] flex-shrink-0">{t('agents.modeTitle')}</span>
          <div className="flex rounded-md border border-[#34332F] overflow-hidden">
            <button
              type="button"
              onClick={() => setUseMock(true)}
              className={`px-2.5 py-1 text-[10.5px] cursor-pointer transition-colors ${
                useMock ? 'bg-[#34332F] text-[#F2F0E5]' : 'text-[#87857F] hover:text-[#CECDC3]'
              }`}
            >
              {t('agents.modeMock')}
            </button>
            <button
              type="button"
              onClick={() => setUseMock(false)}
              className={`px-2.5 py-1 text-[10.5px] cursor-pointer transition-colors border-l border-[#34332F] ${
                !useMock ? 'bg-[#34332F] text-[#F2F0E5]' : 'text-[#87857F] hover:text-[#CECDC3]'
              }`}
            >
              {t('agents.modeActive')}
            </button>
          </div>
          <span className="text-[#5F5C57] text-[10.5px] truncate">
            {useMock ? t('agents.modeMockHint') : providerLabel || t('agents.modeActiveHint')}
          </span>
        </div>

        {error && (
          <div className="flex items-start gap-1.5 text-[11px] text-[#D14D41] bg-[#D14D41]/10 border border-[#D14D41]/25 rounded px-2 py-1.5">
            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}
      </div>

      {/* Metrics strip */}
      {m && (
        <div className="px-3 py-2 border-b border-[#34332F] flex-shrink-0 grid grid-cols-3 sm:grid-cols-6 gap-2">
          {[
            { k: t('agents.metric.messages'), v: fmt(m.messages) },
            { k: t('agents.metric.rawTokens'), v: fmt(m.raw_tokens) },
            { k: t('agents.metric.wireTokens'), v: fmt(m.wire_tokens) },
            { k: t('agents.metric.saved'), v: `-${fmt(m.saved_tokens)} (${Math.round(m.savings_pct)}%)`, accent: true },
            { k: t('agents.metric.calls'), v: `${fmt(m.llm_calls)} · ${t('agents.metric.repairs')} ${fmt(m.repairs)}` },
            { k: t('agents.metric.findings'), v: fmt(m.findings) },
          ].map((s) => (
            <div key={s.k} className="bg-[#100F0F] border border-[#34332F] rounded px-2 py-1.5">
              <div className="text-[10px] text-[#87857F] uppercase tracking-wide truncate">{s.k}</div>
              <div className={`text-[13px] font-mono ${s.accent ? 'text-[#3AA99F]' : 'text-[#F2F0E5]'}`}>{s.v}</div>
            </div>
          ))}
          <div className="col-span-3 sm:col-span-6 text-[10px] text-[#87857F] font-mono">
            {t('agents.estCost')}: {estCost !== null ? `≈ $${estCost.toFixed(6)}` : `— (${model || '?'})`}
          </div>
        </div>
      )}

      {/* Agents */}
      {state && (
        <div className="px-3 py-2 border-b border-[#34332F] flex-shrink-0">
          <div className="text-[10px] text-[#87857F] uppercase tracking-wide mb-1.5">{t('agents.agents')}</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {state.agents.map((a) => (
              <div key={a.id} className="bg-[#100F0F] border border-[#34332F] rounded px-2 py-1.5 flex flex-col gap-1">
                <div className="flex items-center gap-1.5 text-[11px] text-[#CECDC3]">
                  <span style={{ color: STATUS_COLOR[a.status] || '#87857F' }}>{ROLE_ICON[a.id]}</span>
                  <span className="truncate">{a.label}</span>
                  <span
                    className={`ml-auto w-1.5 h-1.5 rounded-full ${a.status === 'thinking' ? 'animate-pulse' : ''}`}
                    style={{ backgroundColor: STATUS_COLOR[a.status] || '#87857F' }}
                    title={(t as unknown as (k: string) => string)(`agents.status.${a.status}`)}
                  />
                </div>
                <div className="text-[10px] font-mono text-[#87857F]">
                  {a.calls} {t('agents.calls')} · {fmt(a.tokens_out)} {t('agents.produced')}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Wire stream */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 flex flex-col gap-2">
        {!state && !busy && (
          <div className="flex-1 flex items-center justify-center text-[12px] text-[#87857F] select-none py-10">
            {t('agents.empty')}
          </div>
        )}
        {state?.messages.map((msg) => <MessageCard key={msg.seq} msg={msg} />)}

        {state && state.messages.some((x) => x.compressed) && (
          <div className="border border-[#34332F] rounded-md bg-[#100F0F] shrink-0">
            <button
              type="button"
              onClick={() => setShowDecoder((v) => !v)}
              className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-[#87857F] hover:text-[#CECDC3] cursor-pointer transition-colors"
            >
              {showDecoder ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {t('agents.decoder')}
            </button>
            {showDecoder && (
              <pre className="m-0 px-2.5 py-2 text-[10px] font-mono text-[#3AA99F] whitespace-pre-wrap break-all border-t border-[#34332F]">
                {state.decoder}
              </pre>
            )}
          </div>
        )}

        {state?.error && (
          <div className="text-[11px] text-[#D14D41] bg-[#D14D41]/10 border border-[#D14D41]/25 rounded px-2 py-1.5 break-all shrink-0">
            {state.error}
          </div>
        )}
      </div>
    </div>
  );
}
