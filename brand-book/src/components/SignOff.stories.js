// Execution-phase sign-off (LINA-282, ADR-0023 §6) — the moment a plan stops
// being a working document and becomes a commitment. Everything here is
// net-new, so it is in the book before it is anywhere else.

export default {
  title: "Components/Sign-off",
  parameters: {
    docs: {
      description: {
        component:
          "Sign-off is the hinge the whole product turns on: before it, the plan is editable; after it, every change is a change order. The banner is one shape in four tones — waiting, deciding, sent back, signed — and each one says in words what its colour says in tone. The clay/amber `pending` state is a NET-NEW token family (`--status-pending-change`, light + dark, contrast-gated) for the one condition the palette had no word for: a row that is locked by sign-off AND has a change order moving underneath it. It is deliberately not `warn` (RAG health) and not the builder party ramp — it is a commitment state, and reading it as either of those would be reading it wrong.",
      },
    },
  },
};

export const PendingChangeChip = {
  name: "Pending-change chip",
  render: () =>
    `<div class="row">
      <span class="badge pending">Change pending</span>
      <span class="badge ok">Approved</span>
      <span class="badge bad">Changes requested</span>
      <span class="badge warn">Awaiting sign-off</span>
    </div>`,
};

export const LockedRow = {
  name: "Locked plan row, change in flight",
  parameters: {
    docs: {
      description: {
        story:
          "The tint is never the signal on its own. A signed-off grid is `aria-disabled`, so the row carries the chip too — that is what a colour-blind reader and a screen reader actually get.",
      },
    },
  },
  render: () =>
    `<div style="display:flex;flex-direction:column;gap:8px">
      <div class="sorow"><span class="nm">3.1 &nbsp;First fix — electrical</span></div>
      <div class="sorow pending">
        <span class="nm">3.2 &nbsp;First fix — plumbing</span>
        <span class="badge pending">Change pending</span>
      </div>
      <div class="sorow"><span class="nm">3.3 &nbsp;Plaster and skim</span></div>
    </div>`,
};

export const Banners = {
  name: "Sign-off banners",
  render: () =>
    `<div style="display:flex;flex-direction:column;gap:12px">
      <div class="sob await">
        <div>
          <p class="t">Plan sent for sign-off. Awaiting approval.</p>
          <p class="c">The plan is read-only until it is approved or changes are requested.</p>
        </div>
      </div>
      <div class="sob decide">
        <div>
          <p class="t">Costa Construções is asking you to sign off on this plan.</p>
          <p class="c">Once signed off, every change to the plan has to go through a change order.</p>
        </div>
      </div>
      <div class="sob reject">
        <div>
          <p class="t">Changes were requested — the plan is editable again.</p>
          <p class="c">“Move the roof ahead of the render.” — Ana Reis · 3 March 2026</p>
        </div>
      </div>
      <div class="sob signed">
        <div>
          <p class="t">This plan is signed off by Ana Reis on 4 March 2026.</p>
          <p class="c">To make changes, raise a change order.</p>
        </div>
      </div>
    </div>`,
};
