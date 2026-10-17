interface HeaderProps {
  activePath?: string;
}

export function Header({ 
  activePath = "" 
}: HeaderProps) {
  
  // Split the incoming path and format each part
  const pathSegments = activePath.split('/').map(segment => segment.trim());

  return (
    <header className="w-full h-10 bg-ink border-b border-surface flex items-center justify-between px-4 font-mono text-xs select-none">
      <div className="flex items-center gap-3">
        
        {/* LOGO */}
        <div className="flex items-center gap-2 font-sans flex-shrink-0">
          <span className="font-bold text-fg tracking-tight text-[13px]">
            thalamus
          </span>
          <span className="bg-panel text-fg-muted border border-surface text-[11px] px-1.5 py-0.5 rounded font-medium">
            studio
          </span>
        </div>
        
        <div className="w-[1px] h-[14px] bg-surface flex-shrink-0" />
        
        {/* DYNAMIC PATH */}
        <div className="flex items-center gap-2 text-fg-muted tracking-tight">
          {pathSegments.map((segment, index) => {
            const isLast = index === pathSegments.length - 1;
            const isRoot = index === 0;

            return (
              <div key={index} className="flex items-center gap-2">
                <span
                  className={
                    isRoot
                      ? "text-fg-dim" 
                      : isLast
                      ? "text-fg font-medium" 
                      : "text-fg-muted"
                  }
                >
                  {segment}
                </span>
                {!isLast && (
                  <span className="text-fg-dim select-none">/</span>
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