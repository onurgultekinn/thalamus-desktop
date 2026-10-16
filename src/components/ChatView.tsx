import { Fragment, type RefObject } from 'react';
import { FileCode2, FolderOpen, KeyRound, Gauge } from 'lucide-react';
import { MarkdownMessage } from './MarkdownMessage';
import { TextDivider } from './TextDivider';
import { useToast } from './Toast';
import type { Message } from '../types';

/**
 * Chat view: welcome cards + message list + loading indicator.
 * Pure presentational component; all behavior comes in via props (App.tsx keeps
 * ownership). Message cards are not re-rendered unless the `msg` object changes.
 */
export function ChatView({
  messages,
  loading,
  userName,
  onlinePricing,
  projectName,
  chatEndRef,
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
  onSampleCode: (code: string) => void;
  onOpenProject: () => void;
  onOpenSettings: () => void;
  onEngineDiagnostic: () => void;
  onRegenerate: (idx: number) => void;
  onInspectDiff: (msg: Message, idx: number) => void;
}) {
  const { showToast } = useToast();
  return (
    <>
      {messages.length <= 1 && !loading ? (
        <div className="flex flex-col items-center justify-center min-h-[400px] h-full max-w-3xl mx-auto px-4 py-8 select-none">
          <div className="text-center mb-8">
            <h2 className="hand text-[26px] leading-tight mb-1" style={{ color: '#dcb67a' }}>Welcome to Thalamus</h2>
            <svg className="sketch-underline" viewBox="0 0 220 8" fill="none" aria-hidden="true">
              <path d="M2 5 C 30 2, 55 7, 85 4 S 150 2, 180 5 S 210 3, 218 4" stroke="#dcb67a" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <p className="text-xs text-[#A8A49E] max-w-md mx-auto leading-relaxed mt-4">
              Thalamus compresses prompts on your machine, without changing what they mean. Pick a starting point:
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
                <span className="text-[13px] font-semibold text-[#F2F0E5] group-hover:text-white transition-colors">Sample prompt</span>
                <span className="text-[11px] text-[#A8A49E] leading-normal">A short Python snippet, ready to compress.</span>
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
                <span className="text-[13px] font-semibold text-[#F2F0E5] group-hover:text-white transition-colors">Open project</span>
                <span className="text-[11px] text-[#A8A49E] leading-normal">Browse {projectName}: files, editor, terminal.</span>
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
                <span className="text-[13px] font-semibold text-[#F2F0E5] group-hover:text-white transition-colors">Connect a model</span>
                <span className="text-[11px] text-[#A8A49E] leading-normal">Add provider keys so replies can use a model.</span>
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
                <span className="text-[13px] font-semibold text-[#F2F0E5] group-hover:text-white transition-colors">Engine status</span>
                <span className="text-[11px] text-[#A8A49E] leading-normal">Pings the local engine and reports latency.</span>
              </div>
            </button>
          </div>
        </div>
      ) : (
        messages.map((msg, idx) => (
          <Fragment key={idx}>

            {msg.role === 'assistant' && msg.metrics && (
              <div className="acanthus-ivy-container">
                <div className="ivy-edge ivy-top" />
                <div className="ivy-edge ivy-bottom" />
                <div className="ivy-edge ivy-left" />
                <div className="ivy-edge ivy-right" />

                <div className="analytics-inner-content">
                  <div className="flex flex-col">
                    <div className="column-label">TOKEN SAVINGS</div>
                    <div className="flex items-center">
                      <span className="analytics-text-green">%{msg.metrics.savingsPercentage} Reduced</span>
                      <span className="analytics-tokens-note">
                        ({msg.metrics.originalTokens} → {msg.metrics.compressedTokens} tokens)
                      </span>
                    </div>
                  </div>

                  {onlinePricing && (
                    <>
                      <div className="inner-divider" />
                      <div className="flex flex-col">
                        <div className="column-label">FINANCIAL SAVINGS</div>
                        <div className="analytics-text-gold shadow-amber-500/15">
                          {msg.metrics.financialSavings}
                        </div>
                      </div>
                    </>
                  )}

                  <div className="inner-divider" />
                  <div className="flex flex-col items-start">
                    <div className="column-label">CODE CHANGE ANALYSIS</div>
                    <button
                      type="button"
                      className="analytics-diff-btn"
                      onClick={() => onInspectDiff(msg, idx)}
                    >
                      Inspect Structural Changes Visually →
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
                    <span>{msg.role === 'user' ? (userName || 'Anonymous User') : 'Thalamus Engine'}</span>
                  </div>
                  <div className="msg-header-right">
                    {/* D1: modelName yoksa pazarlama modeli uydurma — motoru soyle */}
                    <span className="msg-model-name">{msg.modelName || 'Local Compression Engine'}</span>
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
                        title="Regenerate"
                        onClick={() => onRegenerate(idx)}
                      >
                        <svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>
                      </button>
                    )}
                    <button
                      className="msg-btn-action"
                      title="Copy"
                      onClick={() => {
                        navigator.clipboard.writeText(msg.content)
                          .then(() => showToast('Copied', 'Message copied to clipboard.', 'success'))
                          .catch(() => showToast('Copy Failed', 'Clipboard is not available.', 'error'));
                      }}
                    >
                      <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </button>
                  </div>

                  <div className="msg-metrics">
                    <span>
                      {msg.metrics?.compressedTokens
                        ? `${msg.metrics.compressedTokens} tokens`
                        : `${Math.ceil(msg.content.length / 4)} tokens`}
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
        ))
      )}

      {loading && (
        <div className="msg-wrapper msg-assistant-left">
          <div className="custom-loader-card">
            <div className="custom-loader-container">
              <span>PROCESSING:</span>
              <div className="custom-loader-words">
                <span className="custom-loader-word">models</span>
                <span className="custom-loader-word">prompts</span>
                <span className="custom-loader-word">keys</span>
                <span className="custom-loader-word">tokens</span>
                <span className="custom-loader-word">models</span>
              </div>
            </div>
          </div>
        </div>
      )}

      <div ref={chatEndRef} />
    </>
  );
}
