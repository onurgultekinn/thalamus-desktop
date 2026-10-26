import { t } from '../lib/i18n';

interface HeaderProps {
  activePath?: string;
  /** Komut paletini açar (Ctrl+K). */
  onOpenPalette?: () => void;
  /** Uygulama geneli Nucleus komut yüzeyini açar. */
  onOpenNucleus?: () => void;
}

export function Header({
  activePath = "",
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
    <header className="w-full h-10 bg-[#100F0F] border-b border-[#282726] flex items-center justify-between px-4 font-sans text-xs select-none">
      <div className="flex items-center gap-3">

        {/* LOGO */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="font-bold text-[#F2F0E5] tracking-tight text-[13px]">
            thalamus
          </span>
          <span className="bg-[#1C1B1A] text-[#A8A49E] border border-[#282726] text-[11px] px-1.5 py-0.5 rounded font-medium">
            studio
          </span>
        </div>

        <div className="w-[1px] h-[14px] bg-[#282726] flex-shrink-0" />

        {/* DYNAMIC PATH — mono yerine uygulama fontu; son segment parlak beyaz
            değil, paletin yumuşak ön planı (göz yormayan kırılım). */}
        <div className="flex items-center gap-2 text-[12px] tracking-tight">
          {pathSegments.map((segment, index) => {
            const isLast = index === pathSegments.length - 1;
            const isRoot = index === 0;

            return (
              <div key={index} className="flex items-center gap-2">
                <span
                  className={
                    isRoot
                      ? "text-[#575654]"
                      : isLast
                      ? "text-[#CECDC3] font-medium"
                      : "text-[#87857F]"
                  }
                >
                  {segment}
                </span>
                {!isLast && (
                  <span className="text-[#4A4845] select-none">/</span>
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
              className="group flex items-center gap-1.5 text-[11px] text-[#87857F] transition-colors hover:text-[#CECDC3] cursor-pointer"
            >
              <span className="leading-none font-medium">Nucleus</span>
              <span className="text-[10px] leading-none text-[#575654] group-hover:text-[#87857F] transition-colors select-none">
                Alt N
              </span>
            </button>
          )}
          {onOpenPalette && (
            <button
              type="button"
              onClick={onOpenPalette}
              title="Ctrl+K"
              className="group flex items-center gap-1.5 text-[11px] text-[#87857F] transition-colors hover:text-[#CECDC3] cursor-pointer"
            >
              <span className="leading-none font-medium">{t('nav.search')}</span>
              <span className="text-[10px] leading-none text-[#575654] group-hover:text-[#87857F] transition-colors select-none">
                Ctrl K
              </span>
            </button>
          )}
        </div>
      ) : (
        <div />
      )}
    </header>
  );
}
