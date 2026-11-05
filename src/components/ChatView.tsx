import { Fragment, memo, useEffect, useRef, useState, type RefObject } from 'react';
import { Cog, Pencil } from 'lucide-react';
import { AskQuestionCard } from './AskQuestionCard';
import { MarkdownMessage } from './MarkdownMessage';
import { StreamingMessage } from './StreamingMarkdown';
import { TextDivider } from './TextDivider';
import { useToast } from './Toast';
import { askQuestionAsText } from '../lib/askQuestion';
import { useT } from '../lib/i18n';
import type { Message } from '../types';

/** Gecikme: 1 sn altı ms, üstü tek ondalıkla saniye. */
const fmtLatency = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

/**
 * Düşünme bloğu: model yazarken içerik uzar; kullanıcı yukarı kaydırıp okumaya
 * çıkmadıysa görünüm kendiliğinden en yeni satırda kalır.
 */
function ReasoningBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const t = useT();
  const preRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);
  // Akış sürerken blok kendiliğinden açık gelir ve en yeni satırı izler;
  // kullanıcı kapatırsa dokunmayız, yukarı kaydırırsa takibi bırakırız.
  const [open, setOpen] = useState(streaming);
  useEffect(() => {
    if (streaming) setOpen(true);
  }, [streaming]);
  useEffect(() => {
    const el = preRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [text, open]);
  return (
    <details
      className="msg-reasoning"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>{t('chat.reasoning')}</summary>
      <pre
        ref={preRef}
        className="msg-reasoning-text pretty-scrollbar"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
        }}
      >
        {text}
      </pre>
    </details>
  );
}

/**
 * Rendering window: opening a long chat mounts every message, and each mount
 * runs react-markdown + Prism on the main thread while JSON.parse/stringify run
 * for persistence - so a 200-message chat freezes the open path. We render only
 * the tail and let the user pull older messages in, page by page.
 */
const WINDOW_INITIAL = 30;
const WINDOW_STEP = 30;

/**
 * Chat view: welcome cards + message list + loading indicator.
 * Pure presentational component; all behavior comes in via props (App.tsx keeps
 * ownership). Message cards are not re-rendered unless the `msg` object changes.
 */
function ChatViewInner({
  messages,
  loading,
  loadingLabel,
  userName,
  onlinePricing,
  chatEndRef,
  chatKey,
  showWelcome = false,
  onStartChat,
  onOpenProjectView,
  onRegenerate,
  onEditMessage,
  onAnswerQuestion,
}: {
  messages: Message[];
  loading: boolean;
  loadingLabel?: string;
  userName: string;
  targetModel: string;
  onlinePricing: boolean;
  chatEndRef: RefObject<HTMLDivElement | null>;
  /** Identity of the open chat; resets the render window when it changes. */
  chatKey: string;
  /** True yalnızca hiç sohbet ve proje yokken: tam karşılama ekranı. */
  showWelcome?: boolean;
  /** Karşılama köprüleri: "yeni sohbet başlat" / "bir proje aç". */
  onStartChat?: () => void;
  onOpenProjectView?: () => void;
  onRegenerate: (idx: number) => void;
  /** Kullanıcı mesajını düzeltip o noktadan yeniden yanıt üretir. */
  onEditMessage: (idx: number, content: string) => void;
  onAnswerQuestion: (idx: number, answer: string) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(WINDOW_INITIAL);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const editRef = useRef<HTMLTextAreaElement>(null);

  // Metin kutusu içeriğe göre KENDİLİĞİNDEN büyür (elle boyutlandırma yok);
  // bir noktadan sonra kendi içinde kaydırır.
  useEffect(() => {
    const el = editRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, 360);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > 360 ? 'auto' : 'hidden';
  }, [draft, editingIdx]);

  // Yeni sohbete gecince pencere sifirlanir: eski sohbette acilan 200 mesaj
  // yeni sohbete tasinip ayni donmayi yaratmasin.
  useEffect(() => {
    setVisibleCount(WINDOW_INITIAL);
    setEditingIdx(null);
    setDraft('');
  }, [chatKey]);

  const { showToast } = useToast();
  const t = useT();

  // Pencere: son N mesaj render edilir; eskiler kullanicinin istegiyle gelir.
  const windowStart = Math.max(0, messages.length - visibleCount);
  const visibleMessages = windowStart > 0 ? messages.slice(windowStart) : messages;
  const hiddenCount = windowStart;
  const loadOlderRef = useRef<HTMLButtonElement | null>(null);
  const loadOlder = () => {
    const scroller = loadOlderRef.current?.closest('[data-chat-scroll]') as HTMLElement | null;
    if (!scroller) { setVisibleCount(c => c + WINDOW_STEP); return; }
    const prevHeight = scroller.scrollHeight;
    const prevTop = scroller.scrollTop;
    setVisibleCount(c => c + WINDOW_STEP);
    requestAnimationFrame(() => {
      scroller.scrollTop = prevTop + (scroller.scrollHeight - prevHeight);
    });
  };

  const saveEdit = () => {
    if (editingIdx === null) return;
    const text = draft.trim();
    if (!text) return;
    onEditMessage(editingIdx, text);
    setEditingIdx(null);
    setDraft('');
  };

  return (
    <>
      {messages.length === 0 && !loading ? (
        showWelcome ? (
          <div className="flex flex-col items-center justify-center min-h-[400px] h-full max-w-3xl mx-auto px-4 py-8 select-none">
            <div className="text-center">
              <h2 className="text-[17px] font-semibold tracking-tight text-obsidian-text mb-1">{t('chat.welcome')}</h2>
              <p className="text-xs text-[#A8A49E] max-w-md mx-auto leading-relaxed mt-4">
                {t('chat.welcomeA')}
                <button type="button" onClick={onStartChat} className="welcome-bridge">{t('chat.welcomeLinkChat')}</button>
                {t('chat.welcomeB')}
                <button type="button" onClick={onOpenProjectView} className="welcome-bridge">{t('chat.welcomeLinkProject')}</button>
                {t('chat.welcomeC')}
              </p>
            </div>
          </div>
        ) : (
          /* Karşılama sonrası boş sohbet: proje boş ekranıyla aynı dil —
             sakin başlık + tek cümle; boş tuval artık kasıtlı duruyor. */
          <div className="flex flex-col items-center justify-center min-h-[400px] h-full max-w-3xl mx-auto px-4 py-8 select-none">
            <div className="text-center">
              <h2 className="text-[16px] font-semibold tracking-tight text-obsidian-text mb-1">{t('chat.emptyTitle')}</h2>
              <p className="text-xs text-[#A8A49E] max-w-md mx-auto leading-relaxed mt-4">
                {t('chat.emptyBody')}
              </p>
            </div>
          </div>
        )
      ) : (
        <>
          {/* Eskiler burada durur: tek tusla bir sayfa daha getirilir. */}
          {hiddenCount > 0 && (
            <button
              ref={loadOlderRef}
              type="button"
              onClick={loadOlder}
              className="mx-auto mt-1 mb-2 px-3 py-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] text-[11px] text-[#A8A49E] hover:text-obsidian-text hover:bg-white/[0.06] cursor-pointer transition-colors"
              title={`${hiddenCount} earlier message${hiddenCount === 1 ? '' : 's'} hidden for speed`}
            >
              {t('chat.loadOlder', { n: Math.min(WINDOW_STEP, hiddenCount), s: Math.min(WINDOW_STEP, hiddenCount) === 1 ? '' : 's' })}
              <span className="text-[#6F6C66]"> · {t('chat.hidden', { n: hiddenCount })}</span>
            </button>
          )}

          {visibleMessages.map((msg, i) => {
            const idx = windowStart + i;
            const latencyMs = msg.latencyMs ?? msg.metrics?.executionTimeMs;
            const copyText = msg.content.trim() || (msg.question ? askQuestionAsText(msg.question) : '');
            const liveContent = msg.streaming
              ? msg.content.replace(/```(?:question|ask|soru)[\s\S]*$/i, '').trimEnd()
              : msg.content;
            // Akış yeni başladığında boş bir "hayalet" balon + alttaki yükleme
            // kartı üst üste görünüyordu. İlk parça (cevap veya düşünme) gelene
            // kadar balonu çizme; yükleme kartı tek başına kalsın.
            if (msg.role === 'assistant' && msg.streaming && !liveContent.trim() && !msg.reasoning?.trim()) {
              return null;
            }
            return (
          <Fragment key={idx}>

            {msg.role === 'assistant' && msg.metrics && (
              <div className="metrics-row">
                <div className="analytics-inner-content">
                  {/* Tek satırlık ölçüm: etiket ve değer yan yana — her yanıtın
                      üstünde kutu içinde kutu gibi duran kart değildi amaç. */}
                  <div className="flex items-baseline gap-1.5">
                    <span className="column-label column-label-inline">{t('chat.tokenSavings')}</span>
                    {msg.metrics.savingsPercentage > 0 ? (
                      <>
                        <span className="analytics-text-green">{t('chat.reduced', { pct: msg.metrics.savingsPercentage })}</span>
                        <span className="analytics-tokens-note">
                          ({msg.metrics.originalTokens} → {msg.metrics.compressedTokens} tokens)
                        </span>
                      </>
                    ) : (
                      <span className="analytics-tokens-note">{t('chat.savingsNone')}</span>
                    )}
                  </div>

                  {onlinePricing && (
                    <>
                      <div className="inner-divider" />
                      <div className="flex items-baseline gap-1.5">
                        <span className="column-label column-label-inline">{t('chat.financialSavings')}</span>
                        <span className="analytics-text-gold shadow-amber-500/15">
                          {msg.metrics.financialSavings}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            <div className={`msg-wrapper ${msg.role === 'user' ? 'msg-user-right' : 'msg-assistant-left'}`}>
              <div className="msg-bubble">

                <div className="msg-header">
                  <div className="msg-header-left">
                    <svg className="msg-avatar" viewBox="0 0 24 24">
                      <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                    </svg>
                    <span>{msg.role === 'user' ? (userName || t('sidebar.anonymous')) : t('chat.thalamus')}</span>
                  </div>
                  <div className="msg-header-right">
                    {msg.role === 'assistant' && (
                      <>
                        {/* D1: modelName yoksa pazarlama modeli uydurma.
                            Rozette yalnız MODEL id'si gösterilir; "Custom
                            (OpenAI-compatible) · claude-..." gibi uzun etiket
                            başlığa sıkışır — tam etiket tooltip'te durur. */}
                        <span
                          className="msg-model-name"
                          title={msg.modelName || undefined}
                        >
                          {(msg.modelName || t('chat.localMessage')).split(' · ').pop()}
                        </span>
                        <span className="dot-separator" aria-hidden="true">·</span>
                        <span title={msg.streaming ? t('chat.streaming') : t('chat.latency')}>
                          {msg.streaming ? t('chat.streaming') : latencyMs ? fmtLatency(latencyMs) : '—'}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {/* run_command kayıtları (auto/autonomous): komut metni, çıkış
                    kodu ve süre. Kabuk komutu sessizce çalışmaz. */}
                {msg.role === 'assistant' && !!msg.toolRuns?.length && (
                  <div className="flex flex-col gap-1 px-1">
                    {msg.toolRuns.map((run, i) => (
                      <details
                        key={`${run.command}-${i}`}
                        className="rounded border border-white/10 bg-white/[0.03] text-[10px] leading-tight"
                      >
                        <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1 font-mono text-white/50">
                          <span className="text-[#4385BE]">$</span>
                          <span className="truncate">{run.command}</span>
                          <span
                            className={`ml-auto shrink-0 ${
                              run.exitCode === 0
                                ? 'text-emerald-400/80'
                                : run.exitCode == null
                                  ? 'text-amber-400/80'
                                  : 'text-red-400/80'
                            }`}
                          >
                            {run.exitCode == null ? 'exit ?' : `exit ${run.exitCode}`}
                          </span>
                          {typeof run.durationMs === 'number' && (
                            <span className="shrink-0 text-white/30">{run.durationMs} ms</span>
                          )}
                        </summary>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap px-2 pb-1 font-mono text-white/40">
                          {run.command}
                        </pre>
                      </details>
                    ))}
                  </div>
                )}

                {/* Ajan araç etkinliği: tool-loop sırasında çağrılan araçlar.
                    Akış sırasında canlı ("çalışıyor" hissi), bitince kompakt
                    çip geçmişi — metinden ayrı, gürültü değil. */}
                {msg.role === 'assistant' && !!msg.toolActivity?.length && (
                  <div className="flex flex-wrap items-center gap-1 px-1">
                    {msg.toolActivity.map((name, i) => {
                      const count = msg.toolActivity!.filter(n => n === name).length;
                      const last = i === msg.toolActivity!.lastIndexOf(name);
                      // Her araç bir kez (son tekrarında ×N sayacıyla).
                      if (!last) return null;
                      const active = msg.streaming && i === msg.toolActivity!.length - 1;
                      return (
                        <span
                          key={`${name}-${i}`}
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] leading-none ${
                            active
                              ? 'border-[#4385BE]/50 bg-[#4385BE]/15 text-[#4385BE]'
                              : 'border-white/10 bg-white/5 text-white/50'
                          }`}
                          title={active ? `${name} çalışıyor…` : name}
                        >
                          <Cog size={10} className={active ? 'animate-pulse' : ''} />
                          {name}
                          {count > 1 && <span className="opacity-60">×{count}</span>}
                        </span>
                      );
                    })}
                  </div>
                )}

                {/* Düşünme (reasoning): model destekliyorsa ve kullanıcı
                    kapatmadıysa gelir. Varsayılan KAPALI gelir (gürültü değil,
                    isteğe bağlı ayrıntı); tıklayınca açılır. */}
                {msg.role === 'assistant' && !!msg.reasoning?.trim() && (
                  <ReasoningBlock text={msg.reasoning.trim()} streaming={msg.streaming} />
                )}

                {editingIdx === idx ? (
                  <div className="flex flex-col gap-2 pb-0.5">
                    <textarea
                      ref={editRef}
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setEditingIdx(null);
                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveEdit();
                      }}
                      rows={4}
                      className="pretty-scrollbar min-h-[118px] w-full resize-none overflow-hidden rounded-md bg-obsidian-bg/60 px-3 py-3 text-[13.5px] leading-relaxed text-obsidian-text outline-none ring-1 ring-inset ring-white/[0.07] transition-shadow focus:ring-[#dcb67a]/40"
                    />
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setEditingIdx(null)}
                          className="cursor-pointer rounded px-2 py-1 text-[11px] text-obsidian-muted transition-colors hover:bg-white/[0.05] hover:text-obsidian-soft"
                        >
                          {t('common.cancel')}
                        </button>
                        <button
                          type="button"
                          onClick={saveEdit}
                          disabled={!draft.trim() || loading}
                          className="cursor-pointer rounded border border-[#dcb67a]/30 bg-[#dcb67a]/10 px-2.5 py-1 text-[11px] font-medium text-[#dcb67a] transition-colors hover:border-[#dcb67a]/50 hover:bg-[#dcb67a]/15 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {t('chat.resend')}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    {(liveContent.trim().length > 0 || msg.stopped) && (
                      <div className={`mod-text ${msg.content.length > 300 && !msg.streaming && !msg.streamed ? 'msg-content-scrollable pretty-scrollbar' : ''}`}>
                        {msg.streaming
                          ? <StreamingMessage content={liveContent} />
                          : <MarkdownMessage content={msg.content} />}
                        {msg.stopped && (
                          <div className="msg-stopped-note">
                            {msg.stopped === 'timeout'
                              ? t('chat.timeoutNote')
                              : msg.stopped === 'error'
                                ? t('chat.brokenNote')
                                : msg.stopped === 'length'
                                  ? t('chat.lengthNote')
                                  : t('chat.stoppedNote')}
                          </div>
                        )}
                      </div>
                    )}
                    {msg.role === 'user' && !!msg.files?.length && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1 px-1">
                        <span className="text-[9.5px] font-mono uppercase tracking-wide text-white/50">
                          {t('chat.attachmentsSent')}
                        </span>
                        {msg.files.map((f, i) => (
                          <span
                            key={`${f.name}-${i}`}
                            className="inline-flex items-center gap-1 rounded border border-white/15 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-white/75"
                            title={f.name}
                          >
                            <span className="truncate max-w-[180px]">{f.name}</span>
                            {f.chars !== undefined && (
                              <span className="text-white/40">{Math.max(1, Math.ceil(f.chars / 1024))} KB</span>
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                    {msg.role === 'assistant' && msg.question && !msg.streaming && (
                      <AskQuestionCard
                        question={msg.question}
                        answered={msg.questionAnswer}
                        disabled={loading || idx !== messages.length - 1}
                        onAnswer={(answer) => onAnswerQuestion(idx, answer)}
                      />
                    )}
                  </>
                )}

                <div className="msg-footer">
                  <div className="msg-actions">
                    {msg.role === 'assistant' && (
                      <button
                        className="msg-btn-action"
                        title={t('chat.regenerate')}
                        onClick={() => onRegenerate(idx)}
                      >
                        <svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>
                      </button>
                    )}
                    {msg.role === 'user' && (
                      <button
                        className="msg-btn-action"
                        title={t('chat.edit')}
                        disabled={loading}
                        onClick={() => {
                          setEditingIdx(editingIdx === idx ? null : idx);
                          setDraft(msg.content);
                        }}
                      >
                        <Pencil />
                      </button>
                    )}
                    <button
                      className="msg-btn-action"
                      title={t('chat.copy')}
                      onClick={() => {
                        navigator.clipboard.writeText(copyText)
                          .then(() => showToast(t('chat.copied'), undefined, 'success'))
                          .catch(() => showToast(t('chat.copyFailed'), t('chat.copyFailedMsg'), 'error', undefined, '[500] clipboard unavailable'));
                      }}
                    >
                      <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </button>
                  </div>

                  <div className="msg-metrics">
                    <span>
                      {/* T7: her tahmin '≈' taşır; görsel mesajlar ek'teki ölçülmüş
                          estTokens'i toplar — '[1 image] = 1 tokens' yalanı gitti. */}
                      {msg.usage && (msg.usage.prompt_tokens || msg.usage.completion_tokens)
                        ? t('chat.usage', { input: msg.usage.prompt_tokens ?? 0, output: msg.usage.completion_tokens ?? 0 })
                        : msg.metrics?.compressedTokens
                          ? t('chat.tokens', { n: msg.metrics.compressedTokens })
                          : msg.images?.length
                            ? t('chat.tokensImageEst', { n: msg.images.reduce((s, i) => s + i.estTokens, 0) + Math.ceil(copyText.length / 4) })
                            : t('chat.tokensEst', { n: Math.ceil(copyText.length / 4) })}
                    </span>
                    {!!msg.usage?.cachedTokens && (
                      <>
                        <span className="dot-separator" aria-hidden="true">·</span>
                        <span className="text-[#3AA99F]" title={t('chat.promptCache')}>
                          {t('chat.usageCached', { n: msg.usage.cachedTokens })}
                        </span>
                      </>
                    )}
                    {!!msg.usage?.creditsRemaining && (
                      <>
                        <span className="dot-separator" aria-hidden="true">·</span>
                        <span className="text-[#D0A215]" title="EVREN">
                          {t('chat.usageCredits', { n: msg.usage.creditsRemaining })}
                        </span>
                      </>
                    )}
                    {msg.engine && msg.engine.compressedTokens > 0 && msg.engine.compressedTokens < msg.engine.originalTokens && (
                      <>
                        <span className="dot-separator" aria-hidden="true">·</span>
                        <span className="text-[#3AA99F]" title={t('chat.engineTitle')}>
                          {t('chat.engineBadge', { from: msg.engine.originalTokens, to: msg.engine.compressedTokens })}
                        </span>
                      </>
                    )}
                    <span className="dot-separator" aria-hidden="true">·</span>
                    <span>{msg.timestamp}</span>
                  </div>
                </div>

            </div>
          </div>

            {msg.role === 'assistant' && idx < messages.length - 1 && (
              <TextDivider />
            )}

          </Fragment>
            );
          })}
        </>
      )}

      {loading &&
        !visibleMessages.some(
          (m) => m.streaming && (m.content.trim() || m.reasoning?.trim())
        ) && (
          <div className="msg-wrapper msg-assistant-left">
            <div className="custom-loader-card" role="status" aria-live="polite">
              <div className="custom-loader-container">
                <span>{loadingLabel || t('chat.processing')}</span>
                <div className="custom-loader-words">
                  <span className="custom-loader-word">{t('chat.proc.models')}</span>
                  <span className="custom-loader-word">{t('chat.proc.prompts')}</span>
                  <span className="custom-loader-word">{t('chat.proc.keys')}</span>
                  <span className="custom-loader-word">{t('chat.proc.tokens')}</span>
                  <span className="custom-loader-word">{t('chat.proc.models')}</span>
                </div>
              </div>
            </div>
          </div>
        )}

      <div ref={chatEndRef} />
    </>
  );
}

/**
 * Memoized: keystrokes in the composer re-render App, but message cards are
 * expensive (markdown + Prism). Callbacks are intentionally excluded from the
 * comparison — they are recreated per render, and every piece of state they
 * close over (messages, loading, active chat) is already a compared prop, so a
 * stale callback cannot observe anything the current render would not.
 */
export const ChatView = memo(ChatViewInner, (prev, next) =>
  prev.messages === next.messages &&
  prev.loading === next.loading &&
  prev.loadingLabel === next.loadingLabel &&
  prev.userName === next.userName &&
  prev.targetModel === next.targetModel &&
  prev.onlinePricing === next.onlinePricing &&
  prev.chatEndRef === next.chatEndRef &&
  prev.chatKey === next.chatKey &&
  prev.showWelcome === next.showWelcome
);
