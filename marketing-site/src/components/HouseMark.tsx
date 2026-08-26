// The "House Record" mark — roof split Owner Blue / Builder Orange over the paper
// record with planned (blue) and actual (orange) bars. Never recoloured or merged.
// `flip` mirrors the two sides for the second reveal (history) per the design.
export function HouseMark({ flip = false }: { flip?: boolean }) {
  const roofLeft = flip ? '#eb6834' : '#2a78d6';
  const roofRight = flip ? '#2a78d6' : '#eb6834';
  const barTop = flip ? '#eb6834' : '#2a78d6';
  const barBottom = flip ? '#2a78d6' : '#eb6834';
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <rect x="12" y="26" width="40" height="30" rx="2" fill="#fcfcfb" stroke="#0b0b0b" strokeWidth="2" />
      <path d="M32 6 L8 26 L32 26 Z" fill={roofLeft} />
      <path d="M32 6 L56 26 L32 26 Z" fill={roofRight} />
      <rect x="18" y="34" width="28" height="6" rx="3" fill={barTop} />
      <rect x="18" y="44" width="17" height="6" rx="3" fill={barBottom} />
    </svg>
  );
}
