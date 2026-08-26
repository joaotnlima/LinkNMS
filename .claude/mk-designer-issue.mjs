import fs from 'node:fs';

const description = `Wireframes/mockups for the **R0 MVP** of the shared-record core, so the CEO can visualize and approve the roadmap (LINA-12). The roadmap is saved as document \`roadmap\` on LINA-12 — §4 (First release / MVP scope) is the spec to design against.

## Why now
CEO reviewed the roadmap (LINA-12) and asked for something visual before approving: *"Without any wireframes or mockups I can't visualize — please request designer to follow up with something visual for approval."* This is that follow-up. Low-fidelity wireframes are enough for this round; polish is not required.

## The R0 story to visualize (homeowner + GC, responsive web)
Design the thinnest end-to-end loop that lets a homeowner and one GC resolve *"who decided this, when, and how much did it move the budget?"*:

1. **Project dashboard** — current budget vs. baseline, count of open change orders, entry points to the decision log and budget view.
2. **Decision log** — list of decisions (title, author, timestamp; append-only / revision-preserving) + an "Add decision" form.
3. **Change order** — raise a CO with a cost delta and status (proposed → approved / rejected); **detail view** with Approve / Reject stamping who + when. Note: a CO can only be approved by a party other than its proposer (or the owner) — reflect that in the UI state.
4. **Budget-impact trail** — a readable running ledger: baseline → each approved CO delta → current total; each approved change shows who decided it, when, and how much it moved the budget, on one screen.

## Non-technical requirements
- **Low-tech, on-site-friendly:** large tap targets, plain language (no jargon), works one-handed on a phone.
- **Trust cues:** make immutability / authorship + timestamps visible; approvals should feel like a record, not a chat.
- **Brand:** use the House Record mark + "Trust built-in." per the design system.
- **Two-sided clarity:** it must be obvious who proposed vs. who approved.

## Deliverable
- Wireframes/mockups (attach to this issue or save as a document) covering the 4 surfaces above as one connected flow.
- Enough fidelity for the CEO to approve the direction and for the Founding Engineer to build against §4.2 (data model → API → UI).

## Handoff
When ready, @-mention the Product Manager on this issue. I'll attach the visuals to LINA-12 and re-request CEO approval. Parent roadmap: LINA-12.`;

const body = {
  projectId: '8dab166d-a756-4c71-8ff3-9503a857972a',
  goalId: 'ebfae9d0-af7a-4ab0-95b5-d40eabb8f6f3',
  parentId: process.env.PAPERCLIP_TASK_ID,
  title: 'Wireframe the R0 shared-record MVP flow (homeowner + GC)',
  status: 'todo',
  workMode: 'standard',
  priority: 'high',
  assigneeAgentId: '7b864ae2-285d-49ed-bfdb-2e839bff7423',
  description,
};

const out = process.env.PAPERCLIP_RUN_SCRATCH_DIR + '/designer-issue.json';
fs.writeFileSync(out, JSON.stringify(body));
console.log(out);
