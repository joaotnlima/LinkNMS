export default {
  title: "Brand/Colour",
  parameters: {
    docs: {
      description: {
        component:
          "Four mandatory primitives. Owner Blue carries the planned/agreed side; Builder Orange the actual/on-site side — never the only signal, always paired with a label or position.",
      },
    },
  },
};

const swatch = (name, hex, role) =>
  `<div class="swatch">
    <div class="chip" style="background:${hex}"></div>
    <div class="meta"><span class="lbl">${name}</span><span class="val">${hex}</span></div>
    <div class="role">${role}</div>
  </div>`;

// NOTE: these hexes are transcribed by hand from design-system/tokens.json —
// `npm run tokens` regenerates tokens.css but NOT this file, so the two can
// drift. They were last reconciled at the LINA-86 identity re-base. If you
// change a primitive, change it in tokens.json first, then here.
export const Identity = {
  render: () =>
    `<div class="swatches">
      ${swatch("Owner Blue", "#3e5c8a", "Planned · owner side")}
      ${swatch("Builder Orange", "#b4633b", "Actual · builder side")}
      ${swatch("Ink", "#16181d", "Text & marks")}
      ${swatch("Paper", "#fbfaf7", "Surface")}
    </div>`,
};

export const Semantic = {
  render: () =>
    `<div class="swatches">
      ${swatch("Success", "#2e7d54", "On budget · approved")}
      ${swatch("Warning", "#b7791f", "Needs attention")}
      ${swatch("Danger", "#c0392b", "Over budget · blocked")}
      ${swatch("Fade", "#9a9a9a", "Slogan “built-in.”")}
    </div>`,
};

export const SurfacesAndLines = {
  name: "Surfaces & lines",
  render: () =>
    `<div class="swatches">
      ${swatch("Surface sunken", "#f4f3f0", "Recessed panels")}
      ${swatch("Surface raised", "#ffffff", "Floating containers")}
      ${swatch("Outline", "#dcdbd7", "Rules at rest")}
      ${swatch("Outline strong", "#9b9a95", "Hover / emphasis")}
    </div>`,
};
