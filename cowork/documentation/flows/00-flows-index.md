---
title: LinkNMS — Application flows
status: living document
owner: Product Designer
relates:
  - ../personas.md
  - ../03-operating-models.md
  - ../05-functional-scope.md
---

# Application flows

This is the map of *what a user does* in LinkNMS, screen by screen, keyed to
the personas in [personas.md](../personas.md) and the functional scope in
[05-functional-scope.md](../05-functional-scope.md). Each flow answers one
question: for this persona, in this situation, what is the shortest legible
path through the shared record?

The visual counterpart to this document is the Pencil flow map at
[`cowork/pen/linkNMS-flows.pen`](../../pen/linkNMS-flows.pen) and the
build-ready mockups under
[`cowork/design/web-app/screens/`](../../design/web-app/screens/). When a flow
here introduces a UI element that does not yet exist, it is added to the
brand-book Storybook (`brand-book/`) in the same change — no orphan components.

## Design premise (inherited, not restated per flow)

- **Mobile-first, non-negotiably.** The contractor and subcontractor work from
  a phone on site. The phone layout is the primary target; desktop is a
  progressive enhancement for management and reporting work (see
  [web-app DESIGN.md](../../design/web-app/DESIGN.md)).
- **Neutral referee.** Nothing reads as one party's tool against another.
  Planned vs. actual and owner-side vs. builder-side are distinguished by
  position and label first, colour second. Colour is never the only signal.
- **The record is the product.** Every flow leaves a tamper-evident trail:
  who did it, when, and what it changed.

## The full flow set

Flows are grouped by the life of a build. **Bold** = specified in detail;
the rest are named here so the whole shape is visible and prioritisation can
happen against it (priority is the Product Manager's call, not the designer's).

### A. Bootstrap a build — *specified: [01-bootstrap-project.md](./01-bootstrap-project.md)*

1. **Owner creates a build** (name, address, type).
2. **Owner declares the operating model** — turnkey / direct-to-specialty /
   hybrid. Asked once; it shapes who gets invited, never asked again.
3. **Owner invites the General Contractor** (or, in the direct model, the first
   specialty) to a scoped Trade Contract.
4. **GC accepts the invite** and joins the build.
5. **GC uploads the project plan as an Excel** of actions / sub-actions /
   timelines, maps the columns, and confirms the import.
6. **The master timeline is populated** and the owner is notified.

This is the flow the product cannot start without: until a build exists, has a
responsible party, and has a plan, there is nothing to keep a record *of*.

### B. Run the record (day-to-day)

7. Owner portfolio / build switcher across multiple builds.
8. Build home — four-pillar status (schedule, budget, scope, safety) — *hi-fi
   mockup exists: `r0-mockups-hifi.html`*.
9. Log a decision / raise a change order — *hi-fi mockup exists*.
10. Approve or reject a change order (owner) — *hi-fi mockup exists*.
11. Budget-impact trail / ledger — *hi-fi mockup exists*.
12. Task detail with dependency-gated start and acceptance criteria.
13. Daily log & site photos (Site Manager / Foreman).

### C. Coordination & quality

14. Cross-trade site calendar & overlap detection.
15. Raise / resolve a non-conformity (Quality Inspection, HSE) — routed back
    through whoever raised it before it can close.
16. Architect clarification & design-change approval queue.
17. Scope-gap flag → route unclaimed work to the owner to assign.

### D. Money & closeout

18. Payment milestone unlock on verified completion.
19. Cross-contract cash-flow view (owner).
20. Cost-to-completion & variance report.
21. Share a scoped, expiring document link (licensing authority — never an
    account; see [personas.md](../personas.md)).

### E. Records *about* non-users

22. Log a neighbour / condominium occurrence (kept by the site team).
23. Generate a disruptive-work notice from the site-presence calendar.

## Persona → entry-point map

| Persona | First screen they land on | Primary flow they live in |
|---|---|---|
| Client / Owner | Portfolio (or bootstrap, if first build) | A, B, D |
| Client's Representative | The owner's build, delegated access | B (approvals) |
| General / Trade Contractor | Invite accept → their Trade Contract | A5, B, D |
| Site Manager / Foreman | Build home, task list | B12–13, C14 |
| Subcontractor | Their own tasks only | B12, C15 |
| Architect | Design-change / clarification queue | C16 |
| Quality Inspection / HSE | Verification & incident queue | C15 |
| Licensing Authority | Scoped share link (no account) | D21 |
| Neighbour | *recorded about, not a user* | E22–23 |

## How to read a detailed flow doc

Each `NN-*.md` file describes one flow as: **who / when**, the **screen
sequence** (numbered, matching the mockup and the Pencil board), the
**components** each screen uses (existing or new-to-Storybook), the **edge
cases**, and the **handoff notes** for engineering.
