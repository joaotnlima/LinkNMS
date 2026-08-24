export default {
  title: "Components/Button",
  parameters: {
    docs: {
      description: {
        component:
          "Three intents; one primary per view (the commit action). 44 px minimum touch target; `lg` (52 px) for the bottom-anchored action on phones.",
      },
    },
  },
  argTypes: {
    label: { control: "text" },
    intent: { control: "inline-radio", options: ["primary", "secondary", "danger"] },
    size: { control: "inline-radio", options: ["md", "lg"] },
    disabled: { control: "boolean" },
  },
  args: { label: "Log change", intent: "primary", size: "md", disabled: false },
  render: ({ label, intent, size, disabled }) => {
    const b = document.createElement("button");
    b.className = `btn ${intent}${size === "lg" ? " lg" : ""}`;
    b.textContent = label;
    b.disabled = disabled;
    return b;
  },
};

export const Primary = {};
export const Secondary = { args: { intent: "secondary", label: "Cancel" } };
export const Danger = { args: { intent: "danger", label: "Delete" } };
export const Large = { args: { size: "lg", label: "Approve budget" } };
export const Disabled = { args: { disabled: true, label: "Disabled" } };

export const AllIntents = {
  name: "All intents",
  render: () =>
    `<div class="row">
      <button class="btn primary">Log change</button>
      <button class="btn secondary">Cancel</button>
      <button class="btn danger">Delete</button>
      <button class="btn primary" disabled>Disabled</button>
      <button class="btn primary lg">Approve budget</button>
    </div>`,
};
