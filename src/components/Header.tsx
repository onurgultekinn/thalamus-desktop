import { t } from '../lib/i18n';
import { Kbd } from './CommandPalette';

interface HeaderProps {
  activePath?: string;
  /** Aktif sohbetin ne zaman açıldığı ("14:32" / "3 Kas") — breadcrumb'da adın başına ince çizgiyle akar. */
  activeChatWhen?: string;
  /** Komut paletini açar (Ctrl+K). */
  onOpenPalette?: () => void;
  /** Uygulama geneli Nucleus komut yüzeyini açar. */
  onOpenNucleus?: () => void;
}

export function Header({
  activePath = "",
  activeChatWhen,
  onOpenPalette,
  onOpenNucleus
}: HeaderProps) {

  // Split the incoming path and format each part. Boş parçalar (ör. sondaki
  // "/") atılır; aksi halde breadcrumb "projects / x /" gibi boş bir segment
  // ve fazladan ayırıcı çiziyordu.
  const pathSegments = activePath
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);

  return (
    <header className="w-full h-10 bg-obsidian-bg border-b border-[#282726] flex items-center justify-between px-4 font-sans text-xs select-none">
      <div className="flex items-center gap-3">

        {/* LOGO */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="font-bold text-obsidian-text tracking-tight text-[13px]">
            thalamus
          </span>
          <span className="bg-obsidian-panel text-[#A8A49E] border border-[#282726] text-[11px] px-1.5 py-0.5 rounded font-medium">
            studio
          </span>
        </div>

        <div className="w-[1px] h-[14px] bg-obsidian-surface flex-shrink-0" />

        {/* DYNAMIC PATH — mono yerine uygulama fontu; son segment parlak beyaz
            değil, paletin yumuşak ön planı (göz yormayan kırılım). */}
        <div className="flex items-center gap-2 text-[12px] tracking-tight">
          {pathSegments.map((segment, index) => {
            const isLast = index === pathSegments.length - 1;
            const isRoot = index === 0;
            // Sohbet modunda adın başına açılış zamanı ince çizgiyle akar:
            // "chats / 14:32 │ Sohbet 1". Proje modunda zaman yoktur.
            const when = isLast && !isRoot ? activeChatWhen : null;

            return (
              <div key={index} className="flex items-center gap-2">
                {/* Kök ve son segment aynı soluk tonda: ad yansın, yol sakin kalsın. */}
                <span className="text-obsidian-muted">
                  {when ? (
                    <span className="flex items-center gap-1.5">
                      <span className="text-[10px] font-normal tabular-nums opacity-60">{when}</span>
                      <span aria-hidden="true" className="h-[9px] w-px flex-shrink-0 bg-white/12" />
                      <span>{segment}</span>
                    </span>
                  ) : (
                    segment
                  )}
                </span>
                {!isLast && (
                  <span className="text-obsidian-muted select-none" aria-hidden="true">/</span>
                )}
              </div>
            );
          })}
        </div>

      </div>

      {onOpenNucleus || onOpenPalette ? (
        <div className="flex items-center gap-4">
          {onOpenNucleus && (
            <button
              type="button"
              onClick={onOpenNucleus}
              title="Nucleus — Alt+N"
              className="group flex items-center gap-1.5 text-[11px] text-obsidian-muted transition-colors hover:text-obsidian-soft cursor-pointer"
            >
              <span className="leading-none font-medium">Nucleus</span>
              {/* Kısayol ipucu palettekilerle AYNI kbd rozetini taşır: iki ayrı
                  font/satır hizası derdi biter. */}
              <Kbd>Alt N</Kbd>
            </button>
          )}
          {onOpenPalette && (
            <button
              type="button"
              onClick={onOpenPalette}
              title="Ctrl+K"
              className="group flex items-center gap-1.5 text-[11px] text-obsidian-muted transition-colors hover:text-obsidian-soft cursor-pointer"
            >
              <span className="leading-none font-medium">{t('nav.search')}</span>
              <Kbd>Ctrl K</Kbd>
            </button>
          )}
        </div>
      ) : (
        <div />
      )}
    </header>
  );
}
