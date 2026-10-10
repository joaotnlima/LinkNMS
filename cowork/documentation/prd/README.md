# LinkNMS — PRDs for the to-be screens

**Date:** 2026-10-10.

**Source:** the *LinkNMS Screen Library* design canvas, checked against `joaotnlima/LinkNMS` `main` @ `18b0ec4`.

**Scope:** every screen or gap on the canvas that is **not implemented yet**. As-built screens that are still right (Landing, Sign-in, Portfolio, Record, Audit, Money, Change orders, Tenders, Proposals, Compare, the public RFP form) have no PRD. Superseded boards are in the canvas's **APAGAR** area, waiting for validation.

Suggested home in the repo: `cowork/documentation/prd/` (next to `to-be/`).

## Index

| PRD | Title | Canvas boards | Depends on |
|---|---|---|---|
| [01](./PRD-01-plan-grid-and-task-panel.md) | Plan grid and docked task panel | 3b · B1, B5, PlanGrid | — |
| [02](./PRD-02-tender-in-the-task-panel.md) | Tender from the task panel | 3b · B2, B3, B4; 4c · C2 | 01 |
| [03](./PRD-03-company-directory.md) | Company directory | 4b · D1, D2, D4; tendering/Gaps | — |
| [04](./PRD-04-rfp-directory-connection.md) | RFP ⇄ directory connection | 4c · C0, C1, C2, C3; 4b · D3 | 02, 03 |
| [05](./PRD-05-task-files-and-deliverables.md) | Files tab, project files, deliverables | 3c · F1, F2, F4; account/Gaps (Documents) | 01 |
| [06](./PRD-06-pdf-and-dwg-viewer-markup.md) | PDF and DWG viewer and markup | 3c · F5, F6, Sheet | 05 |
| [07](./PRD-07-shared-project-model.md) | One shared project model | 3c · F3, F8, F9, F10, Viewport | 05 |
| [08](./PRD-08-tendering-home-and-clarifications.md) | Tendering at its own address, clarifications | tendering/Gaps | — |
| [09](./PRD-09-build-bootstrap-gaps.md) | Bootstrap: overview, participants, Excel import | bootstrap/Gaps | — |
| [10](./PRD-10-plan-execution-gaps.md) | Baselines, gated start, daily log, site calendar, sign-off | plan/Gaps, PlanSignOff | 01 |
| [11](./PRD-11-contracts-and-money.md) | Contracts, change orders, measurements, payments — **PARKED** | record/Gaps | — |
| [12](./PRD-12-coordination-and-account.md) | Notifications, quality, questions, settings, share links | account/Gaps | — |
| [13](./PRD-13-baseline-changes-in-the-plan.md) | Changes against the baseline, shown and managed in the plan | 3b · B6, B7, B8 | 01, 12 (N-1) |

## Decisions

Resolved by the founder on 2026-10-10 and recorded as **D-42 to D-50** in `to-be/01-decisions.md`. The table below keeps the original questions for context.

These conflict with recorded decisions or shipped work. Each PRD's §7 has the detail.

| # | Decision | Conflicts with | PRD |
|---|---|---|---|
| 1 | Tender compose and award in a **docked panel**, not the LINA-420 modal | Shipped LINA-420 (no recorded decision) | 01, 02 |
| 2 | **Amend D-17**: add a "Checked" proof level (IMPIC), and completeness/payment never change result order | D-17 (self-declared only; completeness boosts ranking) | 03 |
| 3 | **Amend D-40**: self-serve apply becomes ask-to-bid with owner approval; `/marketplace` is retired into the company inbox | D-40 Slice 1 (shipped) | 04 |
| 4 | **Amend D-41, doc 24 and BRAND.md** for model editing (at least record-side links and pins; IFC properties optional) | D-41 view-only; BRAND.md "does not author or edit models" | 07 |
| 5 | Add `/projects/{id}/model` to the URL map | to-be/20 | 07 |
| 6 | Deliverable approval and dependency start: **gate or warn** | D-23 "show the change, do not gate it" | 05, 10 |
| 7 | DWG converter (ODA / APS / LibreDWG): licence and cost **not verified** | — | 06 |
| 8 | Upload cap (board 200 MB; RFP model 100 MB; task UI says 10 MB, unenforced) | `modules/tendering/domain/rfp-model.mjs:18` | 05 |
| 9 | **Baseline trigger** while contracts are parked: on award, on plan approval, or keep signature (D-13) | D-13 | 13 |
| 10 | Does an overrun push linked tasks daily, or only as a projection? | D-22 | 13 |

## Unverified technical points

- **web-ifc 0.0.57 write API.** Not found in code. `node_modules` was not installed in the audit checkout. Blocks PRD-07 IFC property edits.
- **Postgres row-level enforcement of model edit scope** over thousands of GlobalIds: benchmark it (PRD-07).
- **IMPIC public lookup:** whether one exists and is usable (PRD-03).
- **pdf.js:** licence and bundle size (PRD-06).

## Suggested order

1. **PRD-12 notifications** (N-1, N-2): every other PRD emits into it.
2. **PRD-01** (depth, Tender column, docked panel, permalink bug).
3. **PRD-02**, then **PRD-08**.
4. **PRD-05**, then **PRD-06** (PDF first, DWG behind the converter decision).
5. **PRD-03**, then **PRD-04**, after decisions 2–3.
6. **PRD-07**, after decision 4.
7. **PRD-13** right after PRD-01 (the backend segments already exist), once the baseline trigger is decided.
8. **PRD-09, PRD-10** in the order the build lifecycle needs them. PRD-11 is parked.

## Bugs found during validation (fix without waiting for a PRD)

- **Task permalink:** a task opened by permalink on a non-baselined plan has no Tender tab, chips or band. The props are not passed (`tasks/[stageKey]/page.tsx:88-110`). PRD-01 P-5.
- **Dead redirects:** `/plan/build` and `/plan/import` redirect to `?compose=…`, which `/plan` ignores. PRD-01 C-1.
- **Outline depth:** the UI drops rows deeper than 3 levels on load (`lib/v2/planning-hydrate.ts`), although the backend allows 10. PRD-01 G-1.
- **Currency:** `$` in `lib/format.ts` against € elsewhere. PRD-11 K-11.
- **Invite role:** the invite-code page always says "general contractor". PRD-09 O-5.
