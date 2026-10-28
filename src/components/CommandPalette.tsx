import { useEffect, useMemo, useRef, useState } from 'react';
import { fold } from '../lib/chatSearch';
import { useT } from '../lib/i18n';
import { useDialog } from '../lib/useDialog';

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  /** Aramada etiket dışında da eşleşsin (ör. "settings" → "Ayarlar"). */
  keywords?: string;
  run: () => void;
}

/** Alt bardaki ortak klavye rozeti. */
function Kbd({ children }: { children: string }) {
  return (
    <span className="inline-flex min-w-[20px] items-center justify-center rounded border border-obsidian-raise bg-obsidian-bg px-1.5 py-0.5 font-mono text-[10px] leading-none text-[#A8A49E]">
      {children}
    </span>
  );
}

/**
 * Komut paleti (Ctrl+K): komutlar + sohbetler tek listede, bölümlenmiş halde.
 * Klavye ile gezilir; Enter çalıştırır, Escape kapatır. Hiçbir eylem arka
 * planda kendiliğinden tetiklenmez.
 */
export function CommandPalette({
  open,
  onClose,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  actions: PaletteAction[];
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    // Odak, palet açıldıktan sonra; aksi halde arka plandaki composer alır.
    const id = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(id);
  }, [open]);

  const needle = fold(query.trim());
  const filtered = useMemo(
    () =>
      needle
        ? actions.filter((a) => fold(`${a.label} ${a.hint ?? ''} ${a.keywords ?? ''}`).includes(needle))
        : actions,
    [actions, needle]
  );

  // Bölümler: sohbet eylemleri ("palette:chat:") ayrı grupta, komutlar üstte.
  const groups = useMemo(() => {
    const commands = filtered.filter((a) => !a.id.startsWith('palette:chat:'));
    const chats = filtered.filter((a) => a.id.startsWith('palette:chat:'));
    const out: { title: string; items: PaletteAction[] }[] = [];
    if (commands.length) out.push({ title: t('palette.groupCommands'), items: commands });
    if (chats.length) out.push({ title: t('palette.groupChats'), items: chats });
    return out;
  }, [filtered, t]);

  // Seçim indeksi bölümler arasında düz bir sırayla ilerler.
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const dialogProps = useDialog({ open, onClose, panelRef });

  if (!open) return null;

  const runAt = (idx: number) => {
    const action = flat[idx];
    if (!action) return;
    onClose();
    // Kapanış animasyonu/durum güncellemesi çalışsın diye bir sonraki tura bırak.
    window.setTimeout(action.run, 0);
  };

  let cursor = 0;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/60 px-4 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        {...dialogProps}
        aria-label={t('palette.title')}
        tabIndex={-1}
        className="w-full max-w-[560px] overflow-hidden rounded-xl border border-obsidian-raise bg-obsidian-panel shadow-[0_24px_70px_-20px_rgba(0,0,0,0.9)] outline-none"
      >
        <div className="flex items-center gap-2.5 border-b border-[#282726] px-3.5 py-3">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((i) => Math.min(i + 1, flat.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((i) => Math.max(i - 1, 0)); }
              else if (e.key === 'Enter') { e.preventDefault(); runAt(selected); }
            }}
            placeholder={t('palette.placeholder')}
            className="w-full border-none bg-transparent text-[13px] text-obsidian-text outline-none placeholder:text-[#6F6C66]"
            spellCheck={false}
            autoComplete="off"
          />
          <Kbd>Esc</Kbd>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5 pretty-scrollbar">
          {flat.length === 0 && (
            <p className="px-3 py-6 text-center text-[12px] text-obsidian-muted">{t('palette.empty')}</p>
          )}
          {groups.map((group) => (
            <div key={group.title} className="mb-1">
              <div className="px-2.5 pb-1 pt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-[#6F6C66]">
                {group.title}
              </div>
              {group.items.map((action) => {
                const idx = cursor++;
                return (
                  <button
                    key={action.id}
                    type="button"
                    data-active={idx === selected}
                    onMouseEnter={() => setSelected(idx)}
                    onClick={() => runAt(idx)}
                    className={`flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors ${
                      idx === selected ? 'bg-white/[0.07] text-obsidian-text' : 'text-obsidian-soft hover:bg-white/[0.04]'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate text-[12.5px]">{action.label}</span>
                    {action.hint && (
                      <span className="flex-shrink-0 truncate text-[10.5px] text-obsidian-muted">{action.hint}</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 border-t border-[#282726] px-3.5 py-2 text-[10.5px] text-obsidian-muted">
          <Kbd>↑↓</Kbd>
          <span>{t('palette.nav')}</span>
          <span className="mx-1 text-[#34332F]">·</span>
          <Kbd>↵</Kbd>
          <span>{t('palette.runAction')}</span>
          <span className="mx-1 text-[#34332F]">·</span>
          <Kbd>Esc</Kbd>
          <span>{t('palette.close')}</span>
        </div>
      </div>
    </div>
  );
}
