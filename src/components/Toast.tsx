import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { wikiUrlFor, splitExplanation } from '../lib/errors';
import { useT } from '../lib/i18n';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastItem {
  id: string;
  title: string;
  message?: string;
  /** Raw technical payload. `[401] raw…` format starts with the error code. */
  detail?: string;
  type: ToastType;
  durationMs?: number;
}

interface ToastContextValue {
  showToast: (title: string, message?: string, type?: ToastType, durationMs?: number, detail?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** Error code lookup: the detail string starts with `[401] raw…`. */
const codeOf = (detail?: string): string | null => {
  const m = detail?.match(/^\[(\w+)\]\s*([\s\S]*)$/);
  return m ? m[1] : null;
};

/**
 * Explanations are "what happened. What to do." — the first sentence usually
 * restates the title, so only the actionable tail is rendered.
 */
const splitMessage = (message?: string): { cause?: string; action?: string } => {
  const { cause, rest } = splitExplanation(message);
  return { cause, action: rest };
};

/** Single accent per type; everything else stays neutral. */
const ACCENT: Record<ToastType, string> = {
  success: '#8F9D77',
  error: '#C97F73',
  info: '#7D8BA6',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const t = useT();
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, { handle: number; endsAt: number; remaining: number }>());

  const clearTimer = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer.handle);
    timers.current.delete(id);
  }, []);

  const removeToast = useCallback((id: string) => {
    clearTimer(id);
    setToasts(prev => prev.filter(t => t.id !== id));
  }, [clearTimer]);

  const schedule = useCallback((id: string, duration: number) => {
    const handle = window.setTimeout(() => {
      timers.current.delete(id);
      setToasts(prev => prev.filter(t => t.id !== id));
    }, duration);
    timers.current.set(id, { handle, endsAt: Date.now() + duration, remaining: duration });
  }, []);

  const pauseTimer = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (!timer || timer.handle === -1) return;
    window.clearTimeout(timer.handle);
    timers.current.set(id, {
      ...timer,
      handle: -1,
      remaining: Math.max(0, timer.endsAt - Date.now()),
    });
  }, []);

  const resumeTimer = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (!timer || timer.handle !== -1) return;
    if (timer.remaining <= 0) { removeToast(id); return; }
    schedule(id, timer.remaining);
  }, [removeToast, schedule]);

  useEffect(() => () => {
    for (const timer of timers.current.values()) window.clearTimeout(timer.handle);
    timers.current.clear();
  }, []);

  const showToast = useCallback(
    (title: string, message?: string, type: ToastType = 'info', durationMs?: number, detail?: string) => {
      const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const dur = durationMs ?? (type === 'error' ? 6000 : type === 'success' ? 3500 : 3000);
      const newToast: ToastItem = { id, title, message, detail, type, durationMs: dur };

      setToasts(prev => [...prev.slice(-3), newToast]);

      if (dur > 0) schedule(id, dur);
    },
    [schedule]
  );

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div
        role="region"
        aria-label={t('toast.region')}
        className="fixed bottom-4 right-4 z-50 flex flex-col gap-1.5 pointer-events-none max-w-sm w-full select-none font-sans"
      >
        {toasts.map(toast => {
          const accent = ACCENT[toast.type];
          const code = codeOf(toast.detail);
          const { cause, action } = splitMessage(toast.message);
          return (
            <div
              key={toast.id}
              role={toast.type === 'error' ? 'alert' : 'status'}
              aria-atomic="true"
              onMouseEnter={() => pauseTimer(toast.id)}
              onMouseLeave={() => resumeTimer(toast.id)}
              onFocus={() => pauseTimer(toast.id)}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) resumeTimer(toast.id);
              }}
              className="group pointer-events-auto relative w-full rounded-md bg-[#201F1D] border border-[#3A3835] shadow-2xl px-3.5 py-3 pb-3.5 flex flex-col gap-1.5 overflow-hidden animate-in fade-in slide-in-from-bottom-1 duration-150"
            >
              <div className="flex items-baseline gap-2">
                {toast.type === 'error' && code ? (
                  <span className="font-mono text-[12px] font-bold tracking-tight flex-shrink-0" style={{ color: accent }}>
                    {code}
                  </span>
                ) : (
                  <span
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0 self-center"
                    style={{ background: accent }}
                  />
                )}

                <span className="text-[12.5px] font-semibold tracking-tight text-[#F4F2ED] leading-[19px] flex-1 min-w-0">
                  {toast.title}
                </span>

                <button
                  type="button"
                  onClick={() => removeToast(toast.id)}
                  className="text-[#807C74] hover:text-[#F4F2ED] cursor-pointer transition-colors flex-shrink-0 self-center"
                  aria-label={t('common.close')}
                >
                  <X size={13} />
                </button>
              </div>

              {/* Baslik zaten "ne oldu"yu soyluyor: tekrar eden ilk cumle (cause)
                  atilir, yalniz aksiyon/aciklama satiri kalir. Aksiyon yoksa
                  mesajin tamami gosterilir. */}
              {(action ?? (cause ? cause : undefined)) && (
                <span className="text-[11.5px] text-[#C6C1B8] leading-[18px] tracking-[-0.01em]">
                  {action ?? cause}
                </span>
              )}

              {/* Alt satır: tek cümlelik yol gösterici; wiki yayınlanınca tıklanabilir olur. */}
              {toast.type === 'error' && code && (
                wikiUrlFor(code) ? (
                  <a
                    href={wikiUrlFor(code) as string}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] font-mono leading-[15px] mt-0.5 pt-1.5 border-t border-[#2E2C29] text-[#8A867E] hover:text-[#CFCAC2] hover:underline cursor-pointer w-fit"
                  >
                    {t('toast.wikiLink')}
                  </a>
                ) : (
                  <span className="text-[10px] text-[#7E7A73] font-mono leading-[15px] mt-0.5 pt-1.5 border-t border-[#2E2C29] w-fit">
                    {t('toast.wiki')}
                  </span>
                )
              )}

              {/* Kalan süre çubuğu: kırık beyaz, alttan iner. */}
              {toast.durationMs && toast.durationMs > 0 && (
                <div
                  className="absolute bottom-0 left-0 h-[1.5px] toast-timer group-hover:[animation-play-state:paused] group-focus-within:[animation-play-state:paused]"
                  style={{ background: 'rgba(244,242,237,0.34)', animationDuration: `${toast.durationMs}ms` }}
                />
              )}
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return {
      showToast: (_title: string, _message?: string) => {},
    };
  }
  return ctx;
}
