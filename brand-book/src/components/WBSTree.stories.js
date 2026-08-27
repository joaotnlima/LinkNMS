export default {
  title: "Components/WBS tree",
  parameters: {
    docs: {
      description: {
        component:
          "The imported plan as a work-breakdown tree: top-level actions (shaded, bold) each holding their sub-actions, with a mini gantt bar per row. This is what the contractor previews before confirming the import, and what populates the master timeline afterward. Bars use the contractor tint by default; the owner tint marks owner-held trades in a hybrid build. See flows/01-bootstrap-project.md, screens 10–11.",
      },
    },
  },
};

const act = (label, left, width, tint = "b") =>
  `<div class="r act"><span class="lab">${label}</span><span class="gz"><i class="${tint === "o" ? "o" : ""}" style="left:${left}%;width:${width}%"></i></span></div>`;
const sub = (label, left, width, tint = "b") =>
  `<div class="r sub"><span class="lab">${label}</span><span class="gz"><i class="${tint === "o" ? "o" : ""}" style="left:${left}%;width:${width}%"></i></span></div>`;

export const ImportedPlan = {
  name: "Imported plan",
  render: () =>
    `<div class="wbs">
      ${act("1 · Foundations", 2, 26)}
      ${sub("Excavation", 2, 10)}
      ${sub("Rebar &amp; formwork", 11, 9)}
      ${sub("Pour &amp; cure", 19, 9)}
      ${act("2 · Structure", 28, 30)}
      ${act("3 · Roof", 56, 16)}
      ${act("4 · MEP rough-in", 60, 22)}
    </div>`,
};

export const HybridOwnerTrade = {
  name: "Hybrid — owner-held trade",
  render: () =>
    `<div class="wbs">
      ${act("1 · Structure (GC)", 2, 34)}
      ${act("2 · Electrical (owner-hired)", 30, 26, "o")}
      ${sub("1st fix", 30, 14, "o")}
      ${sub("2nd fix", 60, 12, "o")}
    </div>`,
};
