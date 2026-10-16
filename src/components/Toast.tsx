import React, { createContext, useContext, useState, useCallback } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastItem {
  id: string;
  title: string;
  message?: string;
  /** Raw technical payload (HTTP status, provider output). Dim mono line. */
  detail?: string;
  type: ToastType;
  durationMs?: number;
}

interface ToastContextValue {
  showToast: (title: string, message?: string, type?: ToastType, durationMs?: number, detail?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** Status-code lookups for the mono code slot (error toasts only). */
const codeOf = (detail?: string): string | null => {
  const m = detail?.match(/^\[(\w+)\]\s*([\s\S]*)$/);
  return m ? m[1] : null;
};
const restOf = (detail?: string): string | undefined => {
  const m = detail?.match(/^\[\w+\]\s*([\s\S]*)$/);
  return m ? m[1] : detail;
};

const RUNNING_COLOR = {
  success: '#3AA99F',
  error: '#D14D41',
  info: '#4385BE',
} as const;

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
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none max-w-sm w-full select-none font-sans">
        {toasts.map(toast => {
          const accent = RUNNING_COLOR[toast.type];
          const code = codeOf(toast.detail);
          const bodyDetail = restOf(toast.detail);
          return (
            <div
              key={toast.id}
              className="pointer-events-auto relative w-full rounded-md bg-[#262522] border overflow-hidden shadow-2xl animate-in fade-in slide-in-from-bottom-2 duration-200"
              style={{ borderColor: `${accent}40` }}
            >
              <div className="px-3 pl-2.5 pr-2 py-2 flex items-start gap-2.5">
                {/* Kod bloğu: hatanın kimliği — hata gönderilmesinde ammo yerine kod, diğer tiplerde ikon. */}
                <div className="flex-shrink-0 mt-px min-w-[30px] flex justify-start">
                  {toast.type === 'error' ? (
                    code ? (
                      <span
                        className="font-mono text-[11px] font-bold leading-5 tracking-tight"
                        style={{ color: accent }}
                      >
                        {code}
                      </span>
                    ) : (
                      <AlertTriangle size={14} className="mt-0.5" style={{ color: accent }} />
                    )
                  ) : toast.type === 'success' ? (
                    <CheckCircle2 size={14} className="mt-0.5" style={{ color: accent }} />
                  ) : (
                    <Info size={14} className="mt-0.5" style={{ color: accent }} />
                  )}
                </div>

                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <span className="text-[12px] font-semibold tracking-tight text-white leading-tight">
                    {toast.title}
                  </span>
                  {toast.message && (
                    <span className="text-[11px] text-[#A8A29B] leading-relaxed">{toast.message}</span>
                  )}
                  {/* Ham detay: sadeleştirae olmadan; meraklıya tooltip. */}
                  {bodyDetail && (
                    <span
                      className="text-[10px] text-[#6F6C66] font-mono leading-snug line-clamp-2 cursor-help pt-0.5"
                      title={bodyDetail}
                    >
                      {bodyDetail}
                    </span>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => removeToast(toast.id)}
                  className="text-[#6F6C66] hover:text-white p-0.5 rounded cursor-pointer transition-colors flex-shrink-0"
                  aria-label="Close"
                >
                  <X size={12} />
                </button>
              </div>

              {/* Süre çubuğu: kaçtığı süreyi gösterir; hover'da titoloşmez, sadece bilgi. */}
              {toast.durationMs && toast.durationMs > 0 && (
                <div
                  className="absolute bottom-0 left-0 h-[2px] toast-timer"
                  style={{ background: `${accent}90`, animationDuration: `${toast.durationMs}ms` }}
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
