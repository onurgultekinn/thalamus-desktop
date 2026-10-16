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
          return (
            <div
              key={toast.id}
              className="pointer-events-auto w-full rounded-md bg-[#201F1D] border border-[#3A3835] shadow-2xl px-3 py-2.5 flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-1 duration-150"
            >
              <div className="flex items-baseline gap-2">
                {toast.type === 'error' && code ? (
                  <span className="font-mono text-[11px] font-bold tracking-tight flex-shrink-0" style={{ color: accent }}>
                    {code}
                  </span>
                ) : (
                  <span
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0 self-center"
                    style={{ background: accent }}
                  />
                )}

                <span className="text-[12px] font-medium tracking-tight text-[#F1EFEA] leading-[18px] flex-1 min-w-0">
                  {toast.title}
                </span>

                <button
                  type="button"
                  onClick={() => removeToast(toast.id)}
                  className="text-[#6F6C66] hover:text-[#F1EFEA] cursor-pointer transition-colors flex-shrink-0 self-center"
                  aria-label="Close"
                >
                  <X size={12} />
                </button>
              </div>

              {toast.message && (
                <span className="text-[11px] text-[#ACA79F] leading-snug">{toast.message}</span>
              )}

              {(bodyDetail || (toast.type === 'error' && code)) && (
                <span className="text-[10px] text-[#6B6862] font-mono leading-snug line-clamp-2 cursor-help pt-0.5" title={bodyDetail}>
                  {bodyDetail}
                  {bodyDetail && code ? ' · ' : ''}
                  {toast.type === 'error' && code ? `wiki › ${code}` : ''}
                </span>
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
