export function TextDivider() {
  return (
    <div
      style={{
        alignSelf: 'center',
        width: '100%',
        maxWidth: '660px',        /* Ends exactly aligned with our cards */
        margin: '1.5rem auto',    /* Balanced vertical breathing room between messages */
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        height: '28px',
        overflow: 'hidden',
      }}
    >
      {/* Left thin line */}
      <div style={{ flex: 1, height: '1px', backgroundColor: 'rgba(255, 255, 255, 0.04)' }} />

      {/* Center ornament */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '0 16px', height: '100%', flexShrink: 0 }}>
        <img
          src="/divider.webp"
          alt=""
          draggable={false}
          style={{
            width: '260px',
            height: 'auto',
            objectFit: 'contain',
            display: 'block',
            opacity: 0.7,
            pointerEvents: 'none',
          }}
        />
      </div>

      {/* Right thin line */}
      <div style={{ flex: 1, height: '1px', backgroundColor: 'rgba(255, 255, 255, 0.04)' }} />
    </div>
  );
}
