/**
 * Mesajlar arası ayraç: yalnız ince bir çizgi. Eski altın asma yaprağı süsü
 * (divider.webp) "yapay zekâ süsü" izlenimi veriyordu; ayraç görünmez olsun,
 * içerik öne çıksın.
 */
export function TextDivider() {
  return (
    <div
      aria-hidden="true"
      style={{
        alignSelf: 'center',
        width: '100%',
        maxWidth: '660px', /* mesaj kartlarıyla tam hizalı */
        margin: '0.65rem auto',
        height: '1px',
        flexShrink: 0,
        backgroundColor: 'rgb(var(--tlm-border))',
        opacity: 0.55,
      }}
    />
  );
}
