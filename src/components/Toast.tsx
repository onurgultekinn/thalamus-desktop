import React, { createContext, useContext, useState, useCallback } from 'react';
import { X } from 'lucide-react';

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
const restOf = (detail?: string): string | undefined => {
  const m = detail?.match(/^\[\w+\]\s*([\s\S]*)$/);
  return m ? m[1] : detail;
};

/**
 * Explanations are written as "what happened. What to do." — the second part is
 * the actionable instruction. Split it so the toast can show the cause and the
 * action as two visually distinct lines.
 */
const splitMessage = (message?: string): { cause?: string; action?: string } => {
  if (!message) return {};
  const parts = message.split(/(?<=[.!?])\s+/);
  if (parts.length < 2) return { cause: message };
  return { cause: parts[0], action: parts.slice(1).join(' ') };
};

/** Single accent per type; everything else stays neutral. */
const ACCENT: Record<ToastType, string> = {
  success: '#8F9D77',
  error: '#C97F73',
  info: '#7D8BA6',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const showToast = useCallback(
    (title: string, message?: string, type: ToastType = 'info', durationMs?: number, detail?: string) => {
      const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const dur = durationMs ?? (type === 'error' ? 6000 : type === 'success' ? 3500 : 3000);
      const newToast: ToastItem = { id, title, message, detail, type, durationMs: dur };

      setToasts(prev => [...prev.slice(-3), newToast]);

      if (dur > 0) {
        setTimeout(() => {
          removeToast(id);
        }, dur);
      }
    },
    [removeToast]
  );

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-1.5 pointer-events-none max-w-sm w-full select-none font-sans">
        {toasts.map(toast => {
          const accent = ACCENT[toast.type];
          const code = codeOf(toast.detail);
          const bodyDetail = restOf(toast.detail);
          const { cause, action } = splitMessage(toast.message);
          return (
            <div
              key={toast.id}
              className="pointer-events-auto relative w-full rounded-md bg-[#201F1D] border border-[#3A3835] shadow-2xl px-3.5 py-3 pb-3.5 flex flex-col gap-1.5 overflow-hidden animate-in fade-in slide-in-from-bottom-1 duration-150"
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
                  aria-label="Close"
                >
                  <X size={13} />
                </button>
              </div>

              {/* Ne oldu: sakin, okunur gri ton. */}
              {cause && (
                <span className="text-[12px] text-[#CFCAC2] leading-[19px] tracking-[-0.01em]">{cause}</span>
              )}

              {/* Ne yapmalısın: girintili, aksan yaylı aksiyon satırı - göz ilk buraya gider. */}
              {action && (
                <span className="flex items-start gap-1.5 text-[12px] leading-[19px] tracking-[-0.01em] text-[#E7E3DB]">
                  <span className="flex-shrink-0" style={{ color: accent }}>→</span>
                  <span className="flex-1 min-w-0">{action}</span>
                </span>
              )}

              {/* Teknik detay: mono, okunur gri ton - netleştirici ince ayırıcı üstünde. */}
              {(bodyDetail || (toast.type === 'error' && code)) && (
                <span
                  className="text-[10.5px] text-[#928D85] font-mono leading-[16px] line-clamp-2 cursor-help mt-0.5 pt-1.5 border-t border-[#312F2C]"
                  title={bodyDetail}
                >
                  {bodyDetail}
                  {bodyDetail && code ? '  ·  ' : ''}
                  {toast.type === 'error' && code ? `wiki › ${code}` : ''}
                </span>
              )}

              {/* Kalan süre çubuğu: kırık beyaz, alttan iner. */}
              {toast.durationMs && toast.durationMs > 0 && (
                <div
                  className="absolute bottom-0 left-0 h-[1.5px] toast-timer"
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
