import React, { createContext, useContext, useState, useCallback } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastItem {
  id: string;
  title: string;
  message?: string;
  type: ToastType;
  durationMs?: number;
}

interface ToastContextValue {
  showToast: (title: string, message?: string, type?: ToastType, durationMs?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const showToast = useCallback((title: string, message?: string, type: ToastType = 'info', durationMs = 3000) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const newToast: ToastItem = { id, title, message, type, durationMs };

    setToasts(prev => [...prev.slice(-3), newToast]);

    if (durationMs > 0) {
      setTimeout(() => {
        removeToast(id);
      }, durationMs);
    }
  }, [removeToast]);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none max-w-sm w-full select-none font-sans">
        {toasts.map(toast => (
          <div
            key={toast.id}
            className={`pointer-events-auto p-3 rounded-lg border shadow-xl flex items-start gap-2.5 transition-all duration-200 animate-in fade-in slide-in-from-bottom-2 ${
              toast.type === 'success'
                ? 'bg-[#0f172a] border-emerald-500/40 text-emerald-300'
                : toast.type === 'error'
                ? 'bg-[#180e14] border-rose-500/40 text-rose-300'
                : 'bg-[#111624] border-cyan-500/40 text-cyan-300'
            }`}
          >
            <div className="flex-shrink-0 mt-0.5">
              {toast.type === 'success' && <CheckCircle2 size={15} className="text-emerald-400" />}
              {toast.type === 'error' && <AlertTriangle size={15} className="text-rose-400" />}
              {toast.type === 'info' && <Info size={15} className="text-cyan-400" />}
            </div>

            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
              <span className="text-[12px] font-semibold tracking-tight text-white leading-tight">
                {toast.title}
              </span>
              {toast.message && (
                <span className="text-[11px] text-slate-300 font-mono leading-relaxed">
                  {toast.message}
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={() => removeToast(toast.id)}
              className="text-slate-400 hover:text-white p-0.5 rounded cursor-pointer transition-colors"
              aria-label="Close"
            >
              <X size={12} />
            </button>
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
      showToast: (_title: string, _message?: string) => {}
    };
  }
  return ctx;
}
