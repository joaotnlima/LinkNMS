// The "House Record" mark and lockups as HTML strings, so every story and
// specimen draws from one definition. Variants: light | reversed | mono.

export function mark(size = 72, variant = "light") {
  const body =
    variant === "reversed"
      ? 'fill="none" stroke="#fbfaf7"'
      : 'fill="#fbfaf7" stroke="#16181d"';
  const roofL = variant === "mono" ? "#16181d" : "#3e5c8a";
  const roofR = variant === "mono" ? "#5b5b58" : "#b4633b";
  const barP = variant === "mono" ? "#16181d" : "#3e5c8a";
  const barA = variant === "mono" ? "#5b5b58" : "#b4633b";
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">
    <rect x="12" y="26" width="40" height="30" rx="2" ${body} stroke-width="2"/>
    <path d="M32 6 L8 26 L32 26 Z" fill="${roofL}"/>
    <path d="M32 6 L56 26 L32 26 Z" fill="${roofR}"/>
    <rect x="18" y="34" width="28" height="6" rx="3" fill="${barP}"/>
    <rect x="18" y="44" width="17" height="6" rx="3" fill="${barA}"/>
  </svg>`;
}

export function lockup({
  size = 44,
  name = 28,
  slogan = false,
  stack = false,
  variant = "light",
} = {}) {
  const sloganHtml = slogan
    ? `<span class="slogan" style="font-size:${Math.round(name * 0.5)}px"><b>Trust</b> built-in.</span>`
    : "";
  return `<span class="lockup${stack ? " stack" : ""}">
    ${mark(size, variant)}
    <span class="wm"><span class="name" style="font-size:${name}px">LinkNMS</span>${sloganHtml}</span>
  </span>`;
}
