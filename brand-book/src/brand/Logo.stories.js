import { mark, lockup } from "../lib/mark.js";

export default {
  title: "Brand/Logo",
  parameters: {
    docs: {
      description: {
        component:
          'The "House Record" mark: a roof split at the ridge into Owner Blue and Builder Orange, over the paper record holding planned (blue) and actual (orange) bars. **The icon is the logo** — the name and slogan are added only where a surface needs them.',
      },
    },
  },
};

const specimen = (inner, cap, dark = false) =>
  `<div class="specimen"><div class="stage${dark ? " dark" : ""}">${inner}</div><div class="cap">${cap}</div></div>`;

export const Mark = {
  name: "Mark (the logo)",
  render: () =>
    `<div class="specimens">
      ${specimen(mark(80, "light"), "Icon — the primary logo")}
      ${specimen(mark(80, "reversed"), "Reversed — dark surfaces", true)}
      ${specimen(mark(80, "mono"), "Monochrome — tonal split")}
    </div>`,
};

export const Lockups = {
  render: () =>
    `<div class="specimens">
      ${specimen(lockup({ size: 44, name: 24 }), "Horizontal — icon + name")}
      ${specimen(lockup({ size: 52, name: 24, slogan: true }), "Horizontal — + slogan")}
      ${specimen(lockup({ size: 56, name: 24, slogan: true, stack: true }), "Stacked — icon above name")}
    </div>`,
};

export const ClearSpaceAndMisuse = {
  name: "Clear space & misuse",
  render: () =>
    `<div style="display:grid;gap:20px">
      <div class="card" style="text-align:center;padding:28px">
        <span class="clearspace">${lockup({ size: 44, name: 24 })}</span>
        <div class="cap" style="margin-top:10px">Clear space equal to the height of the “L”.</div>
      </div>
      <div class="dd">
        <div class="card do"><h4>Do</h4><ul>
          <li>Keep the roof split in the two identity colours.</li>
          <li>Use the mono fallback (Ink on Paper) when one colour is required.</li>
          <li>Give the lockup clear space and a calm surface.</li>
        </ul></div>
        <div class="card dont"><h4>Don't</h4><ul>
          <li>Recolour the split, or merge the two halves into one flat colour.</li>
          <li>Add shadow, gradient, glow or outline; stretch, rotate or re-case the wordmark.</li>
          <li>Bake the wordmark into the icon asset, or shrink it until the split blurs.</li>
        </ul></div>
      </div>
    </div>`,
};
