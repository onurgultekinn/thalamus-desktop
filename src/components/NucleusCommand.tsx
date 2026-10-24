import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  FileText,
  FolderOpen,
  KeyRound,
  MessageSquare,
  MessageSquarePlus,
  RotateCcw,
  ScanSearch,
  Settings2,
  Square,
  X,
  type LucideIcon,
} from 'lucide-react';
import { aiChatStream, type AiMessage } from '../services/aiClient';
import { MarkdownMessage } from './MarkdownMessage';
import { useT, type TranslationKey } from '../lib/i18n';
import {
  buildNucleusSystemPrompt,
  parseNucleusReply,
  stripNucleusAction,
  type NucleusAction,
  type NucleusContext,
  type NucleusView,
} from '../lib/nucleusActions';
import { NUCLEUS_LIMITS } from '../lib/nucleusPolicy';
import { FLOATING_CHROME, FloatResizeHandle, useAutoMinWidth, useFloatingPanel } from './floating';

interface NucleusTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  action?: NucleusAction;
  noKey?: boolean;
  /** Yerel komut geri bildirimi: balon deÄŸil, tek satÄ±r durum. */
  quiet?: boolean;
}

interface NucleusCommandProps {
  open: boolean;
  onClose: () => void;
  context: NucleusContext;
  onAction: (action: NucleusAction) => void;
}

interface NucleusSuggestion {
  id: string;
  label: string;
  icon: LucideIcon;
  run: () => void;
}

const VIEW_KEY: Record<NucleusView, TranslationKey> = {
  chat: 'nucleus.context.chat',
  project: 'nucleus.context.project',
};

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function NucleusCommand({ open, onClose, context, onAction }: NucleusCommandProps) {
  const t = useT();
  const [turns, setTurns] = useState<NucleusTurn[]>([]);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [selection, setSelection] = useState('');

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamedRef = useRef('');
  const stoppedRef = useRef(false);
  const discardedRef = useRef(false);
  const requestSeqRef = useRef(0);
  const stickToBottomRef = useRef(true);

  const float = useFloatingPanel('nucleus-command', {
    def: {
      x: Math.max(16, (typeof window !== 'undefined' ? window.innerWidth : 1280) - 472),
      y: 64,
      w: 440,
      h: 560,
    },
    min: { w: 360, h: 300 },
    alwaysFloating: true,
  });
  useAutoMinWidth(float.headerRef, float.setMinWidth);

  useEffect(() => {
    if (!open) {
      discardedRef.current = true;
      requestSeqRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      setBusy(false);
      setStreamText('');
      return;
    }
    discardedRef.current = false;
    stoppedRef.current = false;
    stickToBottomRef.current = true;
    try {
      setSelection((window.getSelection()?.toString() || '').trim().slice(0, NUCLEUS_LIMITS.pageSelectionChars));
    } catch {
      setSelection('');
    }
    const id = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    el.style.overflowY = el.scrollHeight > 120 ? 'auto' : 'hidden';
  }, [value, open]);

  useEffect(() => {
    const el = threadRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [open, turns.length, streamText, busy]);

  const actionReply = (action: NucleusAction): string => {
    if (action.type === 'navigate') {
      return t('nucleus.action.navigate', { view: t(VIEW_KEY[action.view]) });
    }
    if (action.type === 'new_chat') return t('nucleus.action.newChat');
    if (action.type === 'open_settings') return t('nucleus.action.settings');
    if (action.type === 'toggle_sidebar') return t('nucleus.action.sidebar');
    return t('nucleus.action.stop');
  };

  const runAction = (action: NucleusAction, closeAfter = false, delay: number = NUCLEUS_LIMITS.localActionCloseDelayMs) => {
    onAction(action);
    if (!closeAfter) return;
    if (delay <= 0) {
      onClose();
      return;
    }
    window.setTimeout(onClose, delay);
  };

  const addAssistant = (text: string, action?: NucleusAction, noKey = false, quiet = false) => {
    setTurns((prev) => [...prev, { id: newId(), role: 'assistant', text, action, noKey, quiet }]);
  };

  const runLocalAction = (action: NucleusAction) => {
    addAssistant(actionReply(action), action, false, true);
    const closeNow = action.type === 'open_settings';
    runAction(action, closeNow, closeNow ? 0 : undefined);
  };

  const submit = async (raw: string, options?: { summarize?: boolean }) => {
    if (busy) return;
    const text = raw.trim();
    if (!text) return;

    stickToBottomRef.current = true;
    setTurns((prev) => [...prev, { id: newId(), role: 'user', text }]);
    setValue('');

    if (!context.hasProvider) {
      addAssistant(t('nucleus.noKey'), undefined, true);
      return;
    }

    const system: AiMessage = {
      role: 'system',
      content: buildNucleusSystemPrompt({
        ...context,
        transcript: [context.transcript, selection ? `\nSELECTED TEXT:\n${selection}` : '']
          .filter(Boolean)
          .join('\n'),
      }),
    };
    const history: AiMessage[] = turns
      .filter((turn) => !turn.noKey)
      .slice(-NUCLEUS_LIMITS.historyTurns)
      .map((turn) => ({ role: turn.role, content: turn.text }));
    const userContent = options?.summarize
      ? `${text}\n\nSummarize the current chat transcript above. Include decisions, open tasks, and the next step.`
      : text;

    const controller = new AbortController();
    const requestSeq = ++requestSeqRef.current;
    abortRef.current = controller;
    stoppedRef.current = false;
    discardedRef.current = false;
    streamedRef.current = '';
    setBusy(true);
    setStreamText('');

    try {
      const result = await aiChatStream(
        [...(system ? [system] : []), ...history, { role: 'user', content: userContent }],
        [],
        null,
        controller.signal,
        {},
        {
          onDelta: (delta) => {
            if (requestSeq !== requestSeqRef.current) return;
            streamedRef.current += delta;
            setStreamText(stripNucleusAction(streamedRef.current));
          },
        }
      );
      if (discardedRef.current || requestSeq !== requestSeqRef.current) return;
      const rawReply = result.content || streamedRef.current;
      const parsed = parseNucleusReply(rawReply);
      let reply = parsed.text;
      const quiet = !reply && !!parsed.action;
      if (!reply && parsed.action) reply = actionReply(parsed.action);
      if (!reply) reply = t('nucleus.done');
      addAssistant(reply, parsed.action, false, quiet);
      if (parsed.action) {
        const closeNow = parsed.action.type === 'open_settings';
        runAction(
          parsed.action,
          closeNow,
          closeNow ? 0 : NUCLEUS_LIMITS.actionCloseDelayMs
        );
      }
    } catch (err) {
      if (discardedRef.current || requestSeq !== requestSeqRef.current) return;
      const aborted = controller.signal.aborted;
      if (aborted && stoppedRef.current) {
        const partial = stripNucleusAction(streamedRef.current);
        if (partial) addAssistant(`${partial}\n\n${t('nucleus.stoppedNote')}`);
        else addAssistant(t('nucleus.stopped'));
      } else {
        const missing = err instanceof Error && err.message === 'API_KEY_MISSING';
        addAssistant(
          missing
            ? t('nucleus.noKey')
            : t('nucleus.requestFailed', { error: err instanceof Error ? err.message : String(err) }),
          undefined,
          missing
        );
      }
    } finally {
      if (!discardedRef.current && requestSeq === requestSeqRef.current) {
        setBusy(false);
        setStreamText('');
      }
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const stop = () => {
    stoppedRef.current = true;
    abortRef.current?.abort();
  };

  const clearConversation = () => {
    requestSeqRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setStreamText('');
    setTurns([]);
    stickToBottomRef.current = true;
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit(value);
    }
  };

  if (!open) return null;

  const visibleStream = stripNucleusAction(streamText);
  const contextLabel = t(VIEW_KEY[context.view]);
  const detail = context.view === 'project'
    ? context.activeFile
      ? `${context.activeFile}${context.activeFileLine ? `:${context.activeFileLine}` : ''}`
      : context.projectName
    : context.chatTitle;
  const contextDetail = detail || context.modelLabel;

  const suggestions: NucleusSuggestion[] = [
    {
      id: 'navigate',
      label: context.view === 'project' ? t('nucleus.suggest.chat') : t('nucleus.suggest.project'),
      icon: context.view === 'project' ? MessageSquare : FolderOpen,
      run: () => runLocalAction(
        context.view === 'project'
          ? { type: 'navigate', view: 'chat' }
          : { type: 'navigate', view: 'project' }
      ),
    },
    {
      id: 'new-chat',
      label: t('nucleus.suggest.newChat'),
      icon: MessageSquarePlus,
      run: () => runLocalAction({ type: 'new_chat' }),
    },
  ];

  if (context.messageCount > 0) {
    suggestions.push({
      id: 'summarize',
      label: t('nucleus.suggest.summarize'),
      icon: FileText,
      run: () => void submit(t('nucleus.suggest.summarize'), { summarize: true }),
    });
  }

  if (context.view === 'project' && context.activeFile) {
    suggestions.push({
      id: 'explain',
      label: t('nucleus.suggest.explainHere'),
      icon: ScanSearch,
      run: () => void submit(t('nucleus.suggest.explainHere')),
    });
  }

  suggestions.push({
    id: 'settings',
    label: t('nucleus.suggest.settings'),
    icon: Settings2,
    run: () => runLocalAction({ type: 'open_settings' }),
  });

  const frameStyle: React.CSSProperties = {
    ...(float.style ?? {
      position: 'fixed',
      left: 16,
      top: 64,
      width: 430,
      height: 560,
    }),
    zIndex: 75,
  };

  return (
    <div
      ref={float.frameRef}
      style={frameStyle}
      className={`${FLOATING_CHROME} animate-in bg-[#1C1B1A] font-sans`}
      role="dialog"
      aria-label={t('nucleus.title')}
      data-nucleus-panel
    >
      <div
        ref={float.headerRef}
        onPointerDown={float.onDragStart}
        className="flex h-11 flex-shrink-0 cursor-move select-none items-center gap-2 overflow-hidden whitespace-nowrap border-b border-[#282726] bg-[#100F0F] px-3"
      >
        <span className="flex-shrink-0 font-sans text-[13px] font-semibold tracking-tight text-[#F2F0E5]">
          {t('nucleus.title')}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-[#6F6C66]">
          {contextDetail || contextLabel}
        </span>
        {turns.length > 0 && (
          <button
            type="button"
            onClick={clearConversation}
            title={t('nucleus.clear')}
            aria-label={t('nucleus.clear')}
            className="flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-[#87857F] transition-colors hover:bg-white/[0.05] hover:text-[#CECDC3] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#dcb67a]/50"
          >
            <RotateCcw size={13} />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          title={t('common.close')}
          aria-label={t('common.close')}
          className="flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-[#87857F] transition-colors hover:bg-white/[0.05] hover:text-[#CECDC3] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#dcb67a]/50"
        >
          <X size={14} />
        </button>
      </div>

      <div
        ref={threadRef}
        onScroll={() => {
          const el = threadRef.current;
          if (!el) return;
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        role="log"
        aria-live="polite"
        className="min-h-0 flex-1 overflow-y-auto p-3 pretty-scrollbar"
      >
        {turns.length === 0 && !busy ? (
          <div className="flex min-h-full flex-col justify-end">
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((suggestion) => {
                const Icon = suggestion.icon;
                return (
                  <button
                    key={suggestion.id}
                    type="button"
                    onClick={suggestion.run}
                    className="flex cursor-pointer items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-1 text-[11.5px] text-[#A8A49E] transition-colors hover:border-[#dcb67a]/40 hover:bg-white/[0.04] hover:text-[#F2F0E5] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#dcb67a]/50"
                  >
                    <Icon size={12} className="flex-shrink-0 text-[#87857F]" />
                    <span className="truncate">{suggestion.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {turns.map((turn) => (
              <div key={turn.id} className={`nucleus-msg flex ${turn.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {turn.noKey ? (
                  <div className="flex items-center gap-2 text-[11.5px] text-[#D0A215]">
                    <KeyRound size={12} className="flex-shrink-0" />
                    <span>{turn.text}</span>
                    <button
                      type="button"
                      onClick={() => runAction({ type: 'open_settings' }, true, 0)}
                      className="cursor-pointer underline decoration-[#D0A215]/40 underline-offset-2 transition-colors hover:text-[#EBCB99]"
                    >
                      {t('nucleus.openSettings')}
                    </button>
                  </div>
                ) : turn.quiet ? (
                  <div className="flex items-center gap-1.5 text-[11.5px] text-[#87857F]">
                    <Check size={11} strokeWidth={2.2} className="flex-shrink-0 text-[#dcb67a]" />
                    {turn.text}
                  </div>
                ) : turn.role === 'user' ? (
                  <div className="max-w-[88%] whitespace-pre-wrap rounded-lg bg-[#242321] px-3 py-2 text-[13px] leading-relaxed text-[#F2F0E5]">
                    {turn.text}
                  </div>
                ) : (
                  <div className="w-full rounded-lg border border-white/[0.05] bg-[#201F1D] px-3 py-2 text-[13px] leading-relaxed text-[#CECDC3]">
                    <MarkdownMessage content={turn.text} />
                  </div>
                )}
              </div>
            ))}

            {busy && (
              <div className="nucleus-msg flex justify-start" role="status" aria-label={t('nucleus.thinking')}>
                <div className="w-full rounded-lg border border-white/[0.05] bg-[#201F1D] px-3 py-2.5">
                  {visibleStream ? (
                    <div className="text-[13px] leading-relaxed text-[#CECDC3]">
                      <MarkdownMessage content={visibleStream} />
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      {[0, 1, 2].map((i) => (
                        <span
                          key={i}
                          className="h-1 w-1 animate-pulse rounded-full bg-[#87857F]"
                          style={{ animationDelay: `${i * 160}ms` }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex-shrink-0 border-t border-[#282726] p-2.5">
        <div className="flex items-end gap-2 rounded-lg border border-[#34332F] bg-[#100F0F] py-2 pl-3 pr-2 transition-colors focus-within:border-[#dcb67a]/50">
          <textarea
            ref={inputRef}
            data-nucleus-input
            aria-label={t('nucleus.placeholder')}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('nucleus.placeholder')}
            rows={1}
            className="max-h-[132px] min-h-[24px] flex-1 resize-none overflow-hidden bg-transparent text-[13px] leading-relaxed text-[#F2F0E5] caret-[#dcb67a] outline-none placeholder:text-[#575654] pretty-scrollbar"
          />
          {busy ? (
            <button
              type="button"
              onClick={stop}
              aria-label={t('nucleus.stop')}
              title={t('nucleus.stop')}
              className="flex h-6 w-6 flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-[#CECDC3] transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#dcb67a]/50"
            >
              <Square size={9} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit(value)}
              disabled={!value.trim()}
              aria-label={t('nucleus.send')}
              title={t('nucleus.send')}
              className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md transition-colors active:scale-[0.96] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#dcb67a]/50 ${
                value.trim()
                  ? 'cursor-pointer bg-[#dcb67a] text-[#100F0F] hover:bg-[#E8C58F]'
                  : 'cursor-not-allowed text-[#575654]'
              }`}
            >
              <ArrowUp size={13} />
            </button>
          )}
        </div>
      </div>

      <FloatResizeHandle onPointerDown={float.onResizeStart} />
    </div>
  );
}
