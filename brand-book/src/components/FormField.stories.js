export default {
  title: "Components/Form field",
  parameters: {
    docs: {
      description: {
        component:
          "Label above the control (never placeholder-as-label). Border → Owner Blue on focus → Danger with a message on error. Currency and date variants use tabular figures.",
      },
    },
  },
  argTypes: {
    label: { control: "text" },
    value: { control: "text" },
    error: { control: "text" },
  },
  args: { label: "Change amount", value: "€ 3,200", error: "" },
  render: ({ label, value, error }) => {
    const wrap = document.createElement("div");
    wrap.className = "field" + (error ? " err" : "");
    wrap.innerHTML = `<label>${label}</label><input class="num" value="${value}">${
      error ? `<div class="msg">${error}</div>` : ""
    }`;
    return wrap;
  },
};

export const Default = {};
export const Error = {
  args: { value: "€ -", error: "Enter an amount greater than zero." },
};
