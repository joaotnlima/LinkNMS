export default {
  title: "Components/File dropzone",
  parameters: {
    docs: {
      description: {
        component:
          "Accepts the plan the contractor already has (an .xlsx of actions, sub-actions and timelines) rather than making them re-key it. Two states: idle (drop target) and uploading (file chip + parse progress + sheet name). Rejects non-.xlsx inline; an empty/header-only sheet returns here with an explanation, never a dead end. See flows/01-bootstrap-project.md, screen 8.",
      },
    },
  },
};

export const Idle = {
  render: () =>
    `<div class="dropzone">
      <svg class="dz-ic" viewBox="0 0 24 24"><path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></svg>
      <div class="dz-t">Drop your .xlsx here</div>
      <div class="dz-d">or click to browse — max 10 MB</div>
    </div>`,
};

export const Uploading = {
  render: () =>
    `<div class="filechip">
      <span class="xl">XLS</span>
      <div style="flex:1">
        <div class="fn">plano-obra-casa-almeida.xlsx</div>
        <div class="fs">248 KB · reading &ldquo;Cronograma&rdquo;…</div>
        <div class="prog"><i style="width:72%"></i></div>
      </div>
    </div>`,
};

export const Rejected = {
  name: "Rejected — wrong type",
  render: () =>
    `<div class="dropzone" style="border-color:var(--danger);background:#fbeae7">
      <svg class="dz-ic" viewBox="0 0 24 24" style="stroke:var(--danger)"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>
      <div class="dz-t" style="color:var(--danger)">That's not an .xlsx file</div>
      <div class="dz-d">Export your plan as Excel (.xlsx) and try again, or download our template.</div>
    </div>`,
};
