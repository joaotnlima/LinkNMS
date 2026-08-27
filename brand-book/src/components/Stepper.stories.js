export default {
  title: "Components/Stepper",
  parameters: {
    docs: {
      description: {
        component:
          "Linear progress for a short wizard. The bootstrap flow is 3 steps (Basics → Operating model → Invite); the Excel import is 3 steps (Choose file → Map columns → Preview). Segments are labelled and never rely on colour alone — the step count is always spelled out above the track.",
      },
    },
  },
  argTypes: {
    label: { control: "text" },
    total: { control: { type: "number", min: 2, max: 6 } },
    current: { control: { type: "number", min: 1, max: 6 } },
  },
  args: { label: "Step 2 of 3 · How it's built", total: 3, current: 2 },
  render: ({ label, total, current }) => {
    const segs = Array.from({ length: total }, (_, i) => {
      const n = i + 1;
      const cls = n < current ? "done" : n === current ? "on" : "";
      return `<span class="seg ${cls}"></span>`;
    }).join("");
    return `<div class="stepper"><div class="lbl">${label}</div><div class="track">${segs}</div></div>`;
  },
};

export const Step1 = { name: "Step 1 · Basics", args: { label: "Step 1 of 3 · Basics", current: 1 } };
export const Step2 = { name: "Step 2 · Operating model" };
export const Step3 = { name: "Step 3 · Invite", args: { label: "Step 3 of 3 · Invite", current: 3 } };
export const ImportStep = {
  name: "Import · Map columns",
  args: { label: "Import · Step 2 of 3 · Map columns", current: 2 },
};
