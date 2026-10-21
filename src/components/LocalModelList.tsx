import { Check, Loader2, Square } from 'lucide-react';
import { useT } from '../lib/i18n';
import type { LocalModelEntry } from '../lib/localModels';

interface LocalModelListProps {
  entries: LocalModelEntry[];
  scanning: boolean;
  scanFailed: boolean;
  busyKey?: string | null;
  onUse: (entry: LocalModelEntry) => void;
  onStart: (entry: LocalModelEntry) => void;
  onStop: (serverId: string) => void;
  onScan?: () => void;
  className?: string;
}

export function LocalModelList({
  entries,
  scanning,
  scanFailed,
  busyKey,
  onUse,
  onStart,
  onStop,
  onScan,
  className = '',
}: LocalModelListProps) {
  const t = useT();

  if (scanning && entries.length === 0) {
    return (
      <div className={`flex items-center gap-2 px-2 py-4 text-[11.5px] text-[#87857F] ${className}`}>
        <Loader2 size={12} className="animate-spin" />
        {t('settings.localScanning')}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className={`flex flex-col items-center gap-2.5 px-2 py-6 text-center ${className}`}>
        <span className="text-[11.5px] text-[#87857F]">
          {scanFailed ? t('settings.localScanFailed') : t('settings.localNone')}
        </span>
        {onScan && (
          <button
            type="button"
            onClick={onScan}
            className="cursor-pointer rounded-md border border-white/[0.08] px-2.5 py-1 text-[11px] text-[#CECDC3] transition-colors hover:border-white/[0.16] hover:bg-white/[0.04]"
          >
            {t('settings.localScan')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-0.5 ${className}`}>
      {entries.map((entry) => {
        const busy = busyKey === entry.key;
        const canUse = entry.running && !entry.inUse;
        const canStart = !entry.running && entry.servable;
        const interactive = !busy && (canUse || canStart);

        const activate = () => {
          if (!interactive) return;
          if (canUse) onUse(entry);
          else if (canStart) onStart(entry);
        };

        return (
          <div
            key={entry.key}
            role={interactive ? 'button' : undefined}
            tabIndex={interactive ? 0 : -1}
            aria-disabled={!interactive}
            onClick={activate}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                activate();
              }
            }}
            title={entry.note ? `${entry.model} — ${entry.note}` : entry.model}
            className={`group flex items-center gap-2.5 rounded-md px-2.5 py-2 transition-colors ${
              entry.inUse
                ? 'bg-white/[0.05]'
                : interactive
                  ? 'cursor-pointer hover:bg-white/[0.03] focus-visible:bg-white/[0.03] focus-visible:outline-none'
                  : busy
                    ? 'cursor-progress'
                    : 'cursor-default'
            } ${!entry.running && !entry.servable ? 'opacity-55' : ''}`}
          >
            <span
              className={`min-w-0 flex-1 truncate text-[12px] font-medium ${
                entry.inUse ? 'text-[#F2F0E5]' : 'text-[#CECDC3]'
              }`}
            >
              {entry.label}
            </span>

            {busy ? (
              <span className="flex flex-shrink-0 items-center gap-1.5 text-[10.5px] text-[#dcb67a]">
                <Loader2 size={11} className="animate-spin" />
                {t('local.warming')}
              </span>
            ) : (
              <>
                {entry.inUse && <Check size={12} className="flex-shrink-0 text-[#3AA99F]" />}
                {entry.running && entry.serverId && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onStop(entry.serverId!);
                    }}
                    title={t('settings.localStop')}
                    aria-label={t('settings.localStop')}
                    className="flex-shrink-0 cursor-pointer rounded p-1 text-[#87857F] transition-colors hover:bg-white/[0.06] hover:text-[#CECDC3]"
                  >
                    <Square size={9} />
                  </button>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
