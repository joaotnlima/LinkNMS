# PRD-08 — Tendering at its own address, and clarifications

| | |
|---|---|
| Status | Draft — for founder review |
| Date | 2026-10-10 |
| Validated against | `main` @ `18b0ec4` |
| Design boards | 4 · tendering/Gaps (items 1–2); kept as-built boards Tenders, Proposals, Compare, RfpPublic, RfpSubmitted |
| Related docs | to-be/20 §3–4 (URL map), to-be/06 (clarifications), to-be/23 |
| Depends on | — (independent of PRD-02) |

## 1. Problem

- The whole tender lives inside `/plan/procurement` behind query parameters (`?rfp=`, `?compare=`). You can't link to an RFP or a comparison, and breadcrumbs don't match to-be/20.
- "Questions close" is a field on the RFP, but bidders have nowhere to ask and the owner nowhere to answer for all bidders at once. Questions go to email and get lost, or reach one bidder only, which is unfair.

## 2. Today (as-built)

| Element | State | Where |
|---|---|---|
| Tenders list, new RFP, drafts, proposals inbox, compare, award | Built at `/projects/{id}/plan/procurement` | `app/src/app/projects/[id]/plan/procurement/page.tsx:114`, `components/ProcurementSection.tsx` |
| Tender modal over `/plan` and drawer Tender tab | Built (LINA-420) | `PlanBuildEditor.tsx:1482-1520`, `TenderDrawerTab.tsx` |
| Clarifications: `askClarification`, `answerClarification` | **Backend only**, no UI | `modules/tendering/http/register.mjs:129-132` |

## 3. Requirements

### 3.1 Own address (to-be/20)

| ID | Requirement | Priority |
|---|---|---|
| H-1 | `/projects/{id}/tendering`: every RFP the viewer can see, grouped by lifecycle state, with covered tasks, bids due and `n/m in`. | Must |
| H-2 | `/projects/{id}/tendering/rfps/{id}`: RFP detail, including scope, bidders by source (PRD-04), files and clarifications. | Must |
| H-3 | `/projects/{id}/tendering/rfps/{id}/proposals`: inbox and full comparison (today's Proposals + Compare, unchanged in behaviour). | Must |
| H-4 | `/plan/procurement?rfp=…` and `?compare=…` redirect to the new routes. The panel's "Open in all tenders →" points at H-1 / H-2. | Must |
| H-5 | Composing stays in the task panel (PRD-02). `/tendering/rfps/new` exists for RFPs not started from a row and opens a task picker first (D-29: RFPs launch from a row or subtree). | Should |

### 3.2 Clarifications

| ID | Requirement | Priority |
|---|---|---|
| H-6 | A bidder, from `/rfp/{token}` or in-app, asks a question until "questions close". | Must |
| H-7 | The issuer sees open questions on the RFP detail and in the task panel's Tender tab (count badge). It answers **for all bidders**. The asker's identity is never shown to other bidders. | Must |
| H-8 | Every bidder is notified of each answer (email for token-only bidders, plus the notification centre, PRD-12). Answers become part of the RFP package. | Must |
| H-9 | After "questions close", asking is disabled and says so. | Must |

## 4. Acceptance criteria

1. An RFP and a comparison each have a shareable URL that opens directly for an authorised viewer.
2. A question from bidder A, once answered, is visible to bidders A, B and C, without A's name.
3. Old `/plan/procurement` links keep working.

## 5. Decisions needed

- Can the issuer answer privately, to the asker only? Recommendation: no. Public answers are the fairness rule. Confirm with to-be/06.
