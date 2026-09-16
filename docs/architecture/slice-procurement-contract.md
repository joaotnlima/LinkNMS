# Slice contract — Procurement (RFP composer + proposals inbox)

**FE:** LINA-283 (`app/src/components/ProcurementSection.tsx`, `app/src/lib/procurement.ts`)
**BE:** LINA-279 (RFP create/send/token submission), LINA-280 (constructor selection)
**Shell:** LINA-281 (`/plan` accordion) mounts this section
**Design:** ADR-0023 §2 (schema), §4 (routes), §5 (token auth), §6 (UI surface map)

This is the FE's half, written first. The client calls exactly the routes below;
the shapes are restated in `app/src/lib/procurement.ts` so a drift in the
schedule service's projection lands as a TypeScript error rather than as
`undefined` under a contractor's bid.

---

## §0 The rules both halves keep

1. **The actor is never in the body.** Every route is project-scoped and the
   acting party is the session, stamped server-side. A client that could name the
   selector could hand the build to a constructor nobody chose.
2. **Money is integer cents.** `budget_min_cents` / `budget_max_cents` are
   bigint (ADR-0023 §2). The FE formats, never computes — a proposal's range is
   quoted, never arithmetic'd.
3. **A sent RFP is frozen.** `status` is the authority on what the composer may
   still change. Recipients are added/removed while `draft` only; the send is the
   one-way door.
4. **Proposals are never dropped.** Selecting a constructor does not delete,
   archive or hide the losing proposals. `GET` keeps returning all of them
   forever — "who else bid, and for how much" is the lookup this product is for.
5. **No client-side expiry.** Token validity is derived server-side from the
   phase status (ADR-0023 §5, Option A). The FE never computes "expired".

---

## §1 Routes

All under the existing `/api/v1` gateway, project-scoped. Colon-suffixed actions
follow the house convention already in use (`plan-versions:author`).

| # | Method + path | Returns |
|---|---|---|
| 1 | `GET /api/v1/projects/{id}/procurement` | `ProcurementView` |
| 2 | `PUT /api/v1/projects/{id}/procurement/rfp` | `{ rfp: RfpView }` |
| 3 | `POST /api/v1/projects/{id}/procurement/rfp/attachments` (multipart, one `file` part) | `{ attachment: FileRef }` |
| 4 | `POST /api/v1/projects/{id}/procurement/rfp/recipients` `{ emails: string[] }` | `{ recipients: RecipientView[] }` — the FULL list after the add |
| 5 | `DELETE /api/v1/projects/{id}/procurement/rfp/recipients/{recipientId}` | 204 |
| 6 | `POST /api/v1/projects/{id}/procurement/rfp:send` | `ProcurementView` |
| 7 | `POST /api/v1/projects/{id}/procurement/proposals/{proposalId}:select` | `ProcurementView` |
| 8 | `POST /api/v1/projects/{id}/procurement:skip` | `ProcurementView` |

Notes the FE depends on:

- **(2) is an upsert, not a create.** "Start an RFP" and "keep typing" are the
  same intent; a separate create would leave a half-made row behind every time
  someone opened the composer and changed their mind.
- **(4) returns the whole list**, not just the added rows — the composer replaces
  its list with the server's answer rather than merging, so a server-side
  de-duplication is visible immediately.
- **(6), (7), (8) return the whole `ProcurementView`.** Each one changes more
  than it names (a send mints recipients' tokens and flips `rfp.status`; a select
  activates execution and closes procurement), and a partial response would leave
  the section painting a state that no longer exists.

---

## §2 Shapes

```ts
type PhaseStatus = 'pending' | 'active' | 'signed_off' | 'archived';
type RfpStatus = 'draft' | 'sent' | 'closed';
type RecipientStatus = 'invited' | 'viewed' | 'submitted' | 'declined';

interface FileRef { key; filename; size; contentType; url }   // R2, ADR-0021

interface ProcurementView {
  phase: { id; kind: 'procurement'; name; status: PhaseStatus; sequence };
  rfp: {
    id; phaseId; description; attachments: FileRef[];
    specialties: string[];                      // ← see §3, contract gap
    status: RfpStatus; updatedAt;
  } | null;                                     // null = nothing started yet
  recipients: { id; email; status: RecipientStatus }[];
  proposals: {
    id; rfpRecipientId; companyName; websiteUrl: string | null;
    portfolioImages: FileRef[];
    budgetMinCents: number; budgetMaxCents: number;
    timelineDays: number; comment: string | null; submittedAt;
  }[];
  selectedProposalId: string | null;            // ← see §3, contract gap
}
```

## §3 Two gaps in ADR-0023 §2 the FE needs closed

1. **`rfp.specialties text[] NOT NULL DEFAULT '{}'`** — LINA-283's brief asks for
   specialty tags on the composer and the ADR's `schedule.rfp` has no column for
   them. The FE types the field as required rather than optional on purpose: a
   tag editor that silently drops what was typed is worse than no tag editor.
2. **`selectedProposalId`** — ADR-0023 §2 records the selection nowhere on the
   procurement side; LINA-280 writes it into `plan_change_log` and activates the
   execution phase. The inbox has to be able to say *which* bid won, permanently,
   so it needs either a `schedule.rfp_proposal.selected_at` column or a
   `selected_proposal_id` on `rfp` — BE's choice, projected into the view as
   `selectedProposalId`.

## §4 Error codes the FE turns into sentences

`not_found`, `not_member`, `unauthenticated`, `phase_not_active`,
`rfp_already_sent`, `rfp_empty`, `no_recipients`, `duplicate_recipient`,
`attachment_too_large`, `unsupported_content_type`, `already_selected`.

Anything else falls back to the server's own `error.message` rather than to a
guess. The server is the authority on *what* happened; the wording a party reads
is the FE's job.

## §5 What the FE guarantees before it calls

`sendBlockedReason()` (unit-tested) refuses the send locally for exactly the
three reasons the server refuses on — no RFP, empty brief, no recipients, or
already sent. This is a UX courtesy; the server guard is the source of truth.

`canSkipToExecution()` withdraws the skip once an RFP is `sent`: skipping after
tokens are live would kill outstanding invitations with no warning, so from that
point the only way forward is selecting a proposal.
