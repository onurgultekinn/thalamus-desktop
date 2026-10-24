import { Fragment, memo, useEffect, useRef, useState, type RefObject } from 'react';
import { FileCode2, FolderOpen, KeyRound, Gauge, Pencil } from 'lucide-react';
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
  projectName,
  chatEndRef,
  chatKey,
  onSampleCode,
  onOpenProject,
  onOpenSettings,
  onEngineDiagnostic,
  onRegenerate,
  onEditMessage,
  onAnswerQuestion,
  hasProvider = false,
}: {
  messages: Message[];
  loading: boolean;
  loadingLabel?: string;
  userName: string;
  targetModel: string;
  onlinePricing: boolean;
  projectName: string;
  chatEndRef: RefObject<HTMLDivElement | null>;
  /** Identity of the open chat; resets the render window when it changes. */
  chatKey: string;
  onSampleCode: (code: string) => void;
  onOpenProject: () => void;
  onOpenSettings: () => void;
  onEngineDiagnostic: () => void;
  onRegenerate: (idx: number) => void;
  /** Kullanıcı mesajını düzeltip o noktadan yeniden yanıt üretir. */
  onEditMessage: (idx: number, content: string) => void;
  onAnswerQuestion: (idx: number, answer: string) => void;
  /** En az bir sağlayıcı anahtarı bağlı mı? Bağlıysa "model bağla" kartı gizlenir. */
  hasProvider?: boolean;
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
        <div className="flex flex-col items-center justify-center min-h-[400px] h-full max-w-3xl mx-auto px-4 py-8 select-none">
          <div className="text-center mb-8">
            <h2 className="hand text-[26px] leading-tight mb-1" style={{ color: 'rgb(var(--tlm-gold))' }}>{t('chat.welcome')}</h2>
            <svg className="sketch-underline" viewBox="0 0 220 8" fill="none" aria-hidden="true">
              <path d="M2 5 C 30 2, 55 7, 85 4 S 150 2, 180 5 S 210 3, 218 4" stroke="#dcb67a" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <p className="text-xs text-[#A8A49E] max-w-md mx-auto leading-relaxed mt-4">
              {t('chat.welcomeSub')}
            </p>
          </div>

          {/* İçeriğe göre akar: önizleme paneli açıkken daralan sütunda 2 kolona
              zorlanıp kartlar ezilmez, gerektiğinde tek kolona düşer. */}
          <div className="grid gap-4 w-full" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))' }}>
            {/* CARD 1: Sample prompt */}
            <button
              type="button"
              onClick={() => onSampleCode(`def calc_data(items):\n    # Redundant calculation optimization example\n    total = 0\n    for x in items:\n        val = x * 2.0\n        total += val\n    return total`)}
              className="sketch-border flex items-start gap-3.5 p-4 bg-[#1C1B1A]/80 hover:bg-[#282726] hover:border-[#dcb67a]/60 text-left cursor-pointer transition-all duration-300 group"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-[#dcb67a] transition-colors group-hover:border-[#dcb67a]/40 group-hover:bg-[#dcb67a]/10 flex-shrink-0">
                <FileCode2 size={17} strokeWidth={1.75} />
              </div>
              <div className="flex flex-col gap-1 min-w-0">
                <span className="text-[13px] font-semibold text-[#F2F0E5] group-hover:text-white transition-colors">{t('chat.card.sample.title')}</span>
                <span className="text-[11px] text-[#A8A49E] leading-normal">{t('chat.card.sample.desc')}</span>
              </div>
            </button>

            {/* CARD 2: Open project */}
            <button
              type="button"
              onClick={onOpenProject}
              className="sketch-border flex items-start gap-3.5 p-4 bg-[#1C1B1A]/80 hover:bg-[#282726] hover:border-[#dcb67a]/60 text-left cursor-pointer transition-all duration-300 group"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-[#dcb67a] transition-colors group-hover:border-[#dcb67a]/40 group-hover:bg-[#dcb67a]/10 flex-shrink-0">
                <FolderOpen size={17} strokeWidth={1.75} />
              </div>
              <div className="flex flex-col gap-1 min-w-0">
                <span className="text-[13px] font-semibold text-[#F2F0E5] group-hover:text-white transition-colors">{t('chat.card.project.title')}</span>
                <span className="text-[11px] text-[#A8A49E] leading-normal">{t('chat.card.project.desc', { project: projectName })}</span>
              </div>
            </button>

            {/* CARD 3: Connect a model — yalnız bağlı sağlayıcı yokken */}
            {!hasProvider && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="sketch-border flex items-start gap-3.5 p-4 bg-[#1C1B1A]/80 hover:bg-[#282726] hover:border-[#dcb67a]/60 text-left cursor-pointer transition-all duration-300 group"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-[#dcb67a] transition-colors group-hover:border-[#dcb67a]/40 group-hover:bg-[#dcb67a]/10 flex-shrink-0">
                <KeyRound size={17} strokeWidth={1.75} />
              </div>
              <div className="flex flex-col gap-1 min-w-0">
                <span className="text-[13px] font-semibold text-[#F2F0E5] group-hover:text-white transition-colors">{t('chat.card.model.title')}</span>
                <span className="text-[11px] text-[#A8A49E] leading-normal">{t('chat.card.model.desc')}</span>
              </div>
            </button>
            )}

            {/* CARD 4: Engine status */}
            <button
              type="button"
              onClick={onEngineDiagnostic}
              className="sketch-border flex items-start gap-3.5 p-4 bg-[#1C1B1A]/80 hover:bg-[#282726] hover:border-[#dcb67a]/60 text-left cursor-pointer transition-all duration-300 group"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-[#dcb67a] transition-colors group-hover:border-[#dcb67a]/40 group-hover:bg-[#dcb67a]/10 flex-shrink-0">
                <Gauge size={17} strokeWidth={1.75} />
              </div>
              <div className="flex flex-col gap-1 min-w-0">
                <span className="text-[13px] font-semibold text-[#F2F0E5] group-hover:text-white transition-colors">{t('chat.card.engine.title')}</span>
                <span className="text-[11px] text-[#A8A49E] leading-normal">{t('chat.card.engine.desc')}</span>
              </div>
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Eskiler burada durur: tek tusla bir sayfa daha getirilir. */}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setVisibleCount(c => c + WINDOW_STEP)}
              className="mx-auto mt-1 mb-2 px-3 py-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] text-[11px] text-[#A8A49E] hover:text-[#F2F0E5] hover:bg-white/[0.06] cursor-pointer transition-colors"
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
              <div className="acanthus-ivy-container">
                <div className="ivy-edge ivy-top" />
                <div className="ivy-edge ivy-bottom" />
                <div className="ivy-edge ivy-left" />
                <div className="ivy-edge ivy-right" />

                <div className="analytics-inner-content">
                  <div className="flex flex-col">
                    <div className="column-label">{t('chat.tokenSavings')}</div>
                    <div className="flex items-center">
                      <span className="analytics-text-green">{t('chat.reduced', { pct: msg.metrics.savingsPercentage })}</span>
                      <span className="analytics-tokens-note">
                        ({msg.metrics.originalTokens} → {msg.metrics.compressedTokens} tokens)
                      </span>
                    </div>
                  </div>

                  {onlinePricing && (
                    <>
                      <div className="inner-divider" />
                      <div className="flex flex-col">
                        <div className="column-label">{t('chat.financialSavings')}</div>
                        <div className="analytics-text-gold shadow-amber-500/15">
                          {msg.metrics.financialSavings}
                        </div>
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
                        <span className="dot-separator">·</span>
                        <span title={msg.streaming ? t('chat.streaming') : t('chat.latency')}>
                          {msg.streaming ? t('chat.streaming') : latencyMs ? fmtLatency(latencyMs) : '—'}
                        </span>
                      </>
                    )}
                  </div>
                </div>

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
                      className="pretty-scrollbar min-h-[118px] w-full resize-none overflow-hidden rounded-md bg-[#100F0F]/60 px-3 py-3 text-[13.5px] leading-relaxed text-[#F2F0E5] outline-none ring-1 ring-inset ring-white/[0.07] transition-shadow focus:ring-[#dcb67a]/40"
                    />
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setEditingIdx(null)}
                          className="cursor-pointer rounded px-2 py-1 text-[11px] text-[#87857F] transition-colors hover:bg-white/[0.05] hover:text-[#CECDC3]"
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
                    {msg.engine && msg.engine.compressedTokens > 0 && msg.engine.compressedTokens < msg.engine.originalTokens && (
                      <>
                        <span className="dot-separator">·</span>
                        <span className="text-[#3AA99F]" title={t('chat.engineTitle')}>
                          {t('chat.engineBadge', { from: msg.engine.originalTokens, to: msg.engine.compressedTokens })}
                        </span>
                      </>
                    )}
                    <span className="dot-separator">·</span>
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
            <div className="custom-loader-card">
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
  prev.userName === next.userName &&
  prev.targetModel === next.targetModel &&
  prev.onlinePricing === next.onlinePricing &&
  prev.projectName === next.projectName &&
  prev.chatEndRef === next.chatEndRef &&
  prev.chatKey === next.chatKey
);
