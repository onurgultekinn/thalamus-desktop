import React from 'react';
import { AlertTriangle, Inbox, Loader2 } from 'lucide-react';

const base = 'flex flex-col items-start gap-2 rounded border px-3 py-2.5 text-[11px] leading-relaxed';

export function LoadingState({ label, className = '' }: { label: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={`flex items-center gap-2 px-2 py-3 text-[10.5px] text-obsidian-muted ${className}`}>
      <Loader2 size={12} className="animate-spin" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  className = '',
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`${base} border-obsidian-raise bg-obsidian-panel text-obsidian-soft ${className}`}>
      <div className="flex items-center gap-2">
        <Inbox size={13} className="shrink-0 text-obsidian-muted" />
        <p className="font-medium text-[#DEDBD1]">{title}</p>
      </div>
      {description && <p className="text-obsidian-muted">{description}</p>}
      {action && <div className="mt-0.5">{action}</div>}
    </div>
  );
}

export function ErrorState({
  message,
  details,
  detailsLabel,
  onRetry,
  retryLabel,
  className = '',
}: {
  message: string;
  details?: string;
  detailsLabel?: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  return (
    <div role="alert" className={`${base} border-[#D14D41]/30 bg-[#D14D41]/10 text-[#D14D41] ${className}`}>
      <div className="flex items-start gap-2">
        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="break-words">{message}</p>
          {details && detailsLabel && (
            <details className="mt-1">
              <summary className="cursor-pointer text-[10px] text-[#D14D41]/80">{detailsLabel}</summary>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-[#D14D41]/80">
                {details}
              </pre>
            </details>
          )}
        </div>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="ml-5 inline-flex items-center rounded border border-[#D14D41]/40 px-2 py-0.5 text-[10.5px] text-[#D14D41] transition-colors hover:bg-[#D14D41]/15"
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}
