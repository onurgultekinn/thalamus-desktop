import React, { createContext, useContext, useState, useCallback } from 'react';
import { CheckCircle2, AlertTriangle, Info, X, BookOpen } from 'lucide-react';

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

/** Status-code lookups for the mono code slot (error toasts only). */
const codeOf = (detail?: string): string | null => {
  const m = detail?.match(/^\[(\w+)\]\s*([\s\S]*)$/);
  return m ? m[1] : null;
};
const restOf = (detail?: string): string | undefined => {
  const m = detail?.match(/^\[\w+\]\s*([\s\S]*)$/);
  return m ? m[1] : detail;
};

/** Aşırı renk yok: tüm toasts aynı zemin/çerçeve, alt çizgide tek nüans rengi. */
const ACCENT: Record<ToastType, string> = {
  success: '#8F9D77',
  error: '#D4776C',
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
              className="pointer-events-auto relative w-full rounded bg-[#232220] border border-[#3B3935] shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-200"
            >
              {/* Sol 2px tüm toasts: tek tip göstergesi — başka renkli yangın yok. */}
              <div className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: accent }} />

              <div className="px-2.5 pl-3.5 pr-2 py-2 flex flex-col gap-1">
                {/* Başlık satırı: [kod] başlık + X — tek satırda sıkı ve akıcı. */}
                <div className="flex items-start gap-2">
                  {toast.type === 'error' && code ? (
                    <span
                      className="font-mono text-[11px] font-bold leading-[18px] tracking-tight flex-shrink-0"
                      style={{ color: accent }}
                    >
                      [{code}]
                    </span>
                  ) : (
                    <span className="leading-[18px] flex-shrink-0" style={{ color: accent }}>
                      {toast.type === 'success' ? (
                        <CheckCircle2 size={13} className="mt-0.5" />
                      ) : toast.type === 'error' ? (
                        <AlertTriangle size={13} className="mt-0.5" />
                      ) : (
                        <Info size={13} className="mt-0.5" />
                      )}
                    </span>
                  )}

                  <span className="text-[12px] font-semibold tracking-tight text-[#F3F1EC] leading-[18px] flex-1 min-w-0">
                    {toast.title}
                  </span>

                  <button
                    type="button"
                    onClick={() => removeToast(toast.id)}
                    className="text-[#6F6C66] hover:text-white p-0.5 rounded cursor-pointer transition-colors flex-shrink-0"
                    aria-label="Close"
                  >
                    <X size={12} />
                  </button>
                </div>

                {/* Açıklama: kısa ve öz İngilizce; kullanıcı bunu okuyarak anlar. */}
                {toast.message && (
                  <span className="text-[11px] text-[#B9B4AC] leading-snug">{toast.message}</span>
                )}

                {/* Ham detay: teknik payload, dim mono — isteyen tooltip'ten tam metin okur. */}
                {bodyDetail && (
                  <span
                    className="text-[10px] text-[#6B6862] font-mono leading-snug line-clamp-2 cursor-help pt-0.5"
                    title={bodyDetail}
                  >
                    {bodyDetail}
                  </span>
                )}

                {/* Wiki referansı: hala anlaşılmadıysa adres hazır. */}
                {toast.type === 'error' && code && (
                  <span className="flex items-center gap-1 text-[10px] text-[#6B6862] pt-0.5">
                    <BookOpen size={9} />
                    <span className="font-mono">wiki › {code}</span>
                  </span>
                )}
              </div>

              <div
                className="absolute bottom-0 left-0 h-[2px] toast-timer"
                style={{ background: accent, animationDuration: `${toast.durationMs}ms` }}
              />
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
