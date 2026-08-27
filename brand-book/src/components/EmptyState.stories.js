export default {
  title: "Components/Empty state",
  parameters: {
    docs: {
      description: {
        component:
          "A first screen is never a blank dashboard. Empty states carry a dashed frame, a plain-language line, and exactly one primary action — so the stressed, first-time owner (and the busy contractor) always know the single next step. Used to bootstrap a build (owner) and to prompt the plan upload (contractor). See flows/01-bootstrap-project.md, screens 1 & 7.",
      },
    },
  },
  argTypes: {
    title: { control: "text" },
    detail: { control: "text" },
    action: { control: "text" },
    intent: { control: "inline-radio", options: ["primary", "builder"] },
  },
  args: {
    title: "No builds yet",
    detail: "Start a shared record for your house. Everyone working on it reads the same facts.",
    action: "Create your first build",
    intent: "primary",
  },
  render: ({ title, detail, action, intent }) =>
    `<div class="emptystate">
      <svg class="es-ic" viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/></svg>
      <div class="es-t">${title}</div>
      <div class="es-d">${detail}</div>
      <button class="btn ${intent} lg">${action}</button>
    </div>`,
};

export const OwnerFirstBuild = { name: "Owner — first build" };

export const ContractorAddPlan = {
  name: "Contractor — add plan",
  args: {
    title: "Add your plan to start the record",
    detail:
      "Upload your schedule of actions, sub-actions and timelines. Excel is fine — you'll map the columns next.",
    action: "Upload plan (Excel)",
    intent: "builder",
  },
};
