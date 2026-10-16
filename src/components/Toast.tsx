import React, { createContext, useContext, useState, useCallback } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastItem {
  id: string;
  title: string;
  message?: string;
  /** Raw technical payload (HTTP status, provider output). Dim, 11px mono line. */
  detail?: string;
  type: ToastType;
  durationMs?: number;
}

interface ToastContextValue {
  showToast: (title: string, message?: string, type?: ToastType, durationMs?: number, detail?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const showToast = useCallback(
    (title: string, message?: string, type: ToastType = 'info', durationMs?: number, detail?: string) => {
      const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      // Standarta oturmuş süre: hata okunmaya ihtiyaç duyar (6sn), diğerleri kısa.
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
        {toasts.map(toast => (
          <div
            key={toast.id}
            className={`pointer-events-auto relative rounded-lg border shadow-2xl overflow-hidden bg-[#1C1B1A] animate-in fade-in slide-in-from-bottom-2 duration-200 ${
              toast.type === 'success'
                ? 'border-[#3AA99F]/30'
                : toast.type === 'error'
                  ? 'border-[#D14D41]/35'
                  : 'border-[#4385BE]/35'
            }`}
          >
            {/* Sol durum şeridi — tipten bağımsız eşit genişlik (standart). */}
            <div
              className="absolute left-0 top-0 bottom-0 w-1"
              style={{
                background:
                  toast.type === 'success'
                    ? '#3AA99F'
                    : toast.type === 'error'
                      ? '#D14D41'
                      : '#4385BE',
              }}
            />

            <div className="pl-3.5 pr-2.5 py-2.5 flex items-start gap-2.5">
              <div
                className={`flex-shrink-0 mt-0.5 w-5 h-5 rounded flex items-center justify-center ${
                  toast.type === 'success'
                    ? 'bg-[#3AA99F]/15'
                    : toast.type === 'error'
                      ? 'bg-[#D14D41]/15'
                      : 'bg-[#4385BE]/15'
                }`}
              >
                {toast.type === 'success' && <CheckCircle2 size={13} className="text-[#3AA99F]" />}
                {toast.type === 'error' && <AlertTriangle size={13} className="text-[#D14D41]" />}
                {toast.type === 'info' && <Info size={13} className="text-[#4385BE]" />}
              </div>

              <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                {/* Başlık: her zaman beyaz, 12px yarı kalın — üç tipte de standart. */}
                <span className="text-[12px] font-semibold tracking-tight text-white leading-tight">
                  {toast.title}
                </span>
                {/* Metin: açıklayıcı, anlaşılır dil; teknik jargon burada değil. */}
                {toast.message && (
                  <span className="text-[11px] text-[#CECDC3] leading-relaxed">{toast.message}</span>
                )}
                {/* Detay: ham teknik payload — dim mono, tam okumak için title tooltip. */}
                {toast.detail && (
                  <span
                    className="text-[10.5px] text-[#87857F] font-mono leading-snug line-clamp-2 cursor-help"
                    title={toast.detail}
                  >
                    {toast.detail}
                  </span>
                )}
              </div>

              <button
                type="button"
                onClick={() => removeToast(toast.id)}
                className="text-[#87857F] hover:text-white p-0.5 rounded cursor-pointer transition-colors"
                aria-label="Close"
              >
                <X size={12} />
              </button>
            </div>
          </div>
        ))}
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
