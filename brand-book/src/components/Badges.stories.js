export default {
  title: "Components/Status & party",
  parameters: {
    docs: {
      description: {
        component:
          "Colour is never the sole signal — every badge carries a label (and, where useful, an icon or a fixed position). Status describes budget/state; party tags label a row or comment by role.",
      },
    },
  },
};

export const Status = {
  render: () =>
    `<div class="row">
      <span class="badge ok">On budget</span>
      <span class="badge warn">Needs attention</span>
      <span class="badge bad">Over budget</span>
      <span class="badge edit">Edited</span>
    </div>`,
};

export const PartyTag = {
  name: "Party tag",
  render: () =>
    `<div class="row">
      <span class="party owner">Owner side</span>
      <span class="party builder">Builder side</span>
    </div>`,
};
