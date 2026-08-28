---
title: Flow 01 — Bootstrap a construction project
status: specified
personas: [Client / Owner, General / Trade Contractor]
mockup: ../../design/web-app/screens/bootstrap-flow.html
penmap: ../../pen/linkNMS-flows.pen
relates:
  - ./00-flows-index.md
  - ../03-operating-models.md
  - ../05-functional-scope.md
---

# Flow 01 — Bootstrap a construction project

**The flow the product cannot start without.** Until a build exists, has a
responsible party, and has a plan of actions and timelines, there is nothing
for the shared record to record. This flow takes an owner from an empty
account to a populated master timeline, with a General Contractor invited and
their plan imported.

- **Who:** the **Owner** (screens 1–5, 11) and the **General Contractor**
  (screens 6–11). In the direct-to-specialty model the same shape runs with a
  specialty as the invited party instead of a GC.
- **When:** the very first thing that happens on a build, before any decision,
  change order or budget line exists.
- **Design targets:** owner screens are phone-first (the first-time owner is
  anxious, mobile, brief-session — see
  [personas/owner/01-first-time-owner.md](../personas/owner/01-first-time-owner.md)).
  The Excel import (screens 9–10) is the one step designed desktop-first: it is
  management work with dense tabular mapping, exactly the "progressive
  enhancement for the computer" the [DESIGN.md](../../design/web-app/DESIGN.md)
  describes. It stays usable — not comfortable — on a phone.

## Why the operating model is asked first, and only once

The [operating-models doc](../03-operating-models.md) establishes that a build
is turnkey, direct-to-specialty, or hybrid, and that this changes *who is
accountable for what*, not merely a label. We capture it on screen 3 because it
decides the very next screen: turnkey invites one GC who owns the whole plan;
direct invites each specialty; hybrid does both. We never ask again — the
answer is a property of the build, surfaced later as context, never re-prompted.
This directly serves the first-time owner, who "doesn't want to learn how to
manage a build."

## Why an Excel import at all

The GC already has the plan — in a spreadsheet, a Project file, or a printout.
Asking them to re-enter dozens of actions and sub-actions by hand on day one is
how you lose the busy trade before the record ever fills. So screen 8 accepts
the artefact they already have (`.xlsx`), and screens 9–10 make the machine
prove it understood the file rather than guessing: the GC maps each spreadsheet
column to a known field, and reviews the parsed result before anything is
committed. **Nothing is inferred silently** — the anti-pattern the whole
product exists to kill.

The imported shape maps onto the functional scope directly: *actions* and
*sub-actions* become the per-Trade-Contract timeline
([scope §2](../05-functional-scope.md)); the *dependency* column seeds the
dependency-gated start that closes the "I started assuming it was ready"
dispute.

## Screen sequence

Numbers match the [hi-fi mockup](../../design/web-app/screens/bootstrap-flow.html)
and the [Pencil flow map](../../pen/linkNMS-flows.pen).

| # | Screen | Persona | Key elements | New components |
|---|---|---|---|---|
| 1 | Empty portfolio | Owner | `EmptyState`: "No builds yet", primary CTA **Create your first build** | `EmptyState` |
| 2 | New build · Basics | Owner | `Stepper` (1 of 3), fields: build name, address, build type | `Stepper` |
| 3 | New build · Operating model | Owner | `Stepper` (2 of 3), segmented choice Turnkey / Direct / Hybrid + one-line explainer each | — |
| 4 | Invite General Contractor | Owner | `Stepper` (3 of 3), `PartyInvite`: name, email, role=GC, scope note | `PartyInvite` |
| 5 | Invite sent | Owner | pending `Badge`, build skeleton created, "awaiting the contractor" | — |
| 6 | GC accepts invite | GC | invite landing card, who invited them + build, **Accept & join** | — |
| 7 | GC empty build | GC | `EmptyState`: "Add your plan", primary CTA **Upload plan (Excel)**, template download link | — |
| 8 | Upload · Dropzone | GC | `FileDropzone`: drag `.xlsx`, filename + parsing state, sheet picker | `FileDropzone` |
| 9 | Import · Map columns | GC | `ImportMapping`: each spreadsheet column → field (Action / Sub-action / Start / End / Trade / Dependency); unmapped-column warnings | `ImportMapping` |
| 10 | Import · Preview | GC | `WBSTree` of actions→sub-actions + mini gantt; row & warning counts; **Confirm import** | `WBSTree` |
| 11 | Timeline populated | Owner + GC | master timeline shows imported actions; owner notified; record stamped | — |

## The Excel contract (screens 8–10)

We accept the GC's own file rather than dictating a rigid template, but we do
publish a **suggested template** (linked on screens 7–8) so a GC starting from
scratch has a fast path. Expected columns, in the template and recognised by
the mapper:

| Field | Required | Notes |
|---|---|---|
| Action | yes | Top-level work item (e.g. "Foundations"). Groups its sub-actions. |
| Sub-action | no | Child task (e.g. "Excavation", "Rebar", "Pour"). Rows with a blank Action inherit the previous Action. |
| Start | yes | Date. Mapper flags unparseable dates per row rather than failing the whole import. |
| End (or Duration) | yes | Date or working-days duration; the mapper accepts either and normalises. |
| Trade | no | Which specialty owns it — seeds the Trade Contract mapping (scope §8, BIM disciplines). |
| Dependency | no | References another Action/Sub-action; seeds dependency-gated start (scope §2). |

**Parsing rules the design assumes:**

- The mapper shows a live preview of the first ~10 parsed rows so the GC sees
  the effect of each column assignment immediately.
- Per-row problems (bad date, dependency pointing at a non-existent row) are
  listed as warnings, not blockers — the GC can confirm the import and fix the
  flagged rows afterward. Only a missing required-field *mapping* blocks
  Confirm.
- Import is **re-runnable and non-destructive**: re-uploading produces a diff
  against the existing timeline, never a silent overwrite (every change stays
  in the record). Full diff/merge UI is a follow-up; v1 imports into an empty
  timeline and warns if one already exists.

## Edge cases & states

- **Invite to an existing LinkNMS user** vs. a new email — screen 6 differs
  (in-app accept vs. email → account creation → accept). Both land on screen 7.
- **Owner is also the coordinator (direct model)** — screen 4 invites a
  specialty; screen 7's upload can be done by the owner if no GC holds the
  master plan. The screens are the same; only the party tag changes.
- **Empty / malformed spreadsheet** — dropzone rejects non-`.xlsx`; an empty or
  header-only sheet returns to screen 8 with an inline explanation, never a
  dead end.
- **Multi-sheet workbook** — screen 8 exposes a sheet picker; the mapper runs
  against the chosen sheet.
- **Existing timeline on re-upload** — warn before import; offer to review as a
  diff (follow-up) or cancel.

## Accessibility & on-site notes

- Every step is reachable one-handed; the primary action is bottom-anchored and
  ≥52 px on phones (`btn.lg`).
- RAG and status never rely on colour alone — the invite/pending/imported
  states pair an icon + label with the tint.
- The mapper's column selects use text labels, not colour coding, so it works
  for the low-tech GC in bright site light.

## Handoff notes for engineering

- New components are added to Storybook in `brand-book/` in this same change:
  `EmptyState`, `Stepper`, `PartyInvite`, `FileDropzone`, `ImportMapping`,
  `WBSTree`. See `brand-book/src/components/*.stories.js`.
- Excel parsing is out of design scope, but the mapper UI assumes a parser that
  returns: sheet list, detected columns (header + sample values), and per-row
  parse results with field-level errors. Design to that contract.
- The imported model must write to the record as a single stamped event
  ("Plan imported by {GC}, {n} actions, {m} sub-actions, {t}"), so screen 11's
  provenance line and the change history both have a source.
