interface HeaderProps {
  activePath?: string;
}

export function Header({ 
  activePath = "" 
}: HeaderProps) {
  
  // Split the incoming path and format each part. Boş parçalar (ör. sondaki
  // "/") atılır; aksi halde breadcrumb "projects / x /" gibi boş bir segment
  // ve fazladan ayırıcı çiziyordu.
  const pathSegments = activePath
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);

  return (
    <header className="w-full h-10 bg-[#100F0F] border-b border-[#282726] flex items-center justify-between px-4 font-mono text-xs select-none">
      <div className="flex items-center gap-3">
        
        {/* LOGO */}
        <div className="flex items-center gap-2 font-sans flex-shrink-0">
          <span className="font-bold text-[#F2F0E5] tracking-tight text-[13px]">
            thalamus
          </span>
          <span className="bg-[#1C1B1A] text-[#A8A49E] border border-[#282726] text-[11px] px-1.5 py-0.5 rounded font-medium">
            studio
          </span>
        </div>
        
        <div className="w-[1px] h-[14px] bg-[#282726] flex-shrink-0" />
        
        {/* DYNAMIC PATH */}
        <div className="flex items-center gap-2 text-[#A8A49E] tracking-tight">
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
                      ? "text-[#F2F0E5] font-medium" 
                      : "text-[#A8A49E]"
                  }
                >
                  {segment}
                </span>
                {!isLast && (
                  <span className="text-[#575654] select-none">/</span>
                )}
              </div>
            );
          })}
        </div>

      </div>

      <div />
    </header>
  );
}