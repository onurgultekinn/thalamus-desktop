import { Fragment, memo, useEffect, useState, type RefObject } from 'react';
import { FileCode2, FolderOpen, KeyRound, Gauge } from 'lucide-react';
import { MarkdownMessage } from './MarkdownMessage';
import { TextDivider } from './TextDivider';
import { useToast } from './Toast';
import { useT } from '../lib/i18n';
import type { Message } from '../types';

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
  onInspectDiff,
}: {
  messages: Message[];
  loading: boolean;
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
  onInspectDiff: (msg: Message, idx: number) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(WINDOW_INITIAL);

  // Yeni sohbete gecince pencere sifirlanir: eski sohbette acilan 200 mesaj
  // yeni sohbete tasinip ayni donmayi yaratmasin.
  useEffect(() => {
    setVisibleCount(WINDOW_INITIAL);
  }, [chatKey]);

  const { showToast } = useToast();
  const t = useT();

  // Pencere: son N mesaj render edilir; eskiler kullanicinin istegiyle gelir.
  const windowStart = Math.max(0, messages.length - visibleCount);
  const visibleMessages = windowStart > 0 ? messages.slice(windowStart) : messages;
  const hiddenCount = windowStart;

  return (
    <>
      {messages.length <= 1 && !loading ? (
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

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full">
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

            {/* CARD 3: Connect a model */}
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

                  <div className="inner-divider" />
                  <div className="flex flex-col items-start">
                    <div className="column-label">{t('chat.codeChange')}</div>
                    <button
                      type="button"
                      className="analytics-diff-btn"
                      onClick={() => onInspectDiff(msg, idx)}
                    >
                      {t('chat.inspectChanges')}
                    </button>
                  </div>
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
                    {/* D1: modelName yoksa pazarlama modeli uydurma */}
                    <span className="msg-model-name">{msg.modelName || t('chat.localMessage')}</span>
                    <span className="dot-separator">·</span>
                    <span>
                      {msg.metrics?.executionTimeMs
                        ? `${msg.metrics.executionTimeMs}ms`
                        : '—'}
                    </span>
                  </div>
                </div>

                <div className={`mod-text ${msg.content.length > 300 ? 'msg-content-scrollable pretty-scrollbar' : ''}`}>
                  <MarkdownMessage content={msg.content} />
                </div>

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
                    <button
                      className="msg-btn-action"
                      title={t('chat.copy')}
                      onClick={() => {
                        navigator.clipboard.writeText(msg.content)
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
                      {msg.metrics?.compressedTokens
                        ? t('chat.tokens', { n: msg.metrics.compressedTokens })
                        : msg.images?.length
                          ? t('chat.tokensImageEst', { n: msg.images.reduce((s, i) => s + i.estTokens, 0) + (typeof msg.content === 'string' ? Math.ceil(msg.content.length / 4) : 0) })
                          : t('chat.tokensEst', { n: Math.ceil(msg.content.length / 4) })}
                    </span>
                    {onlinePricing && (
                      <>
                        <span className="dot-separator">·</span>
                        <span>{msg.metrics?.cost || '—'}</span>
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

      {loading && (
        <div className="msg-wrapper msg-assistant-left">
          <div className="custom-loader-card">
            <div className="custom-loader-container">
              <span>{t('chat.processing')}</span>
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
