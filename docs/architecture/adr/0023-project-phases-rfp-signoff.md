# ADR-0023 — Project Phases, RFP & Execution Sign-Off

**Status:** Draft — revised for PRD v2 (founder-approved direction; awaiting child-issue decomposition)  
**Author:** Full-Stack Architect  
**Date:** 2026-09-12 (rev. 2026-09-13 for PRD v2)  
**Issue:** LINA-275

> **Revision note (2026-09-13, PRD v2):** Founder approved the PRD direction with
> six clarifications. This revision folds them in: (1) single `/plan` page instead
> of per-phase routes; (2) accordion instead of phase tabs; (3) **dynamic** token
> expiry tied to Execution activation (Option A — no stored timestamp); (4) new
> `schedule.plan_change_log` audit table; (5) clay/amber visual state for pending
> change-order items; (6) recommendation on where the "already have a contractor?"
> question lives. Superseded passages are marked **[PRD v2]**.

---

## Context

LinkNMS plans today are either `draft` or `proposed` (ADR-0011, LINA-230).
There is no concept of a project *phase* (pre-construction procurement vs.
execution), no mechanism for an owner to formally sign off that a plan is
locked for execution, and no way to solicit competitive bids from
sub-contractors (RFP).

LINA-274 introduces three interlocking capabilities:

1. **Project phases** — a lightweight sequencing layer on top of the project
   record that distinguishes the procurement phase from the execution phase
   (and leaves room for pre-design, close-out, etc.).
2. **RFP** — the procurement phase lets the owner/GC broadcast a request for
   proposals to external contractors via a tokenised, unauthenticated web form.
3. **Execution sign-off** — the owner can formally lock the execution plan,
   after which task/stage edits are blocked and the change-order flow (ADR-0014)
   becomes the only mutation path.

---

## Decision

### 1. Service ownership

New tables live in the **`schedule` schema** (services/schedule), not identity,
because they are plan-lifecycle concerns. The RFP's external-recipient loop
touches email but has no dependency on Clerk-managed parties — we model
recipients as their own lightweight entity with a hashed token, mirroring the
`identity.invitation` pattern.

A new **`procurement` schema** is deliberately NOT introduced — the surface is
thin enough that adding to `schedule` keeps the migration footprint small and
avoids a new least-privilege role dance.

### 2. DB Schema

**Migration numbers:**
- `schedule`: next is `0012_project_phases_rfp_signoff.sql`
- `identity`: no changes required

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ schedule.project_phase                                                       │
├──────────────────────────────────────────────────────────────────────────────┤
│ id                uuid  PK  default gen_random_uuid()                        │
│ project_id        uuid  NOT NULL  ← identity.project.id (bare ref)          │
│ kind              text  NOT NULL  CHECK IN ('pre_design','procurement',       │
│                                             'execution','close_out')         │
│ name              text  NOT NULL  ← display name; defaults from kind         │
│ status            text  NOT NULL  DEFAULT 'pending'                          │
│                         CHECK IN ('pending','active','signed_off','archived')│
│ sequence          int   NOT NULL  ← ordering; 0-indexed, gaps allowed        │
│ responsible_party_ids  uuid[]  NOT NULL DEFAULT '{}'                         │
│ created_at        timestamptz  NOT NULL  DEFAULT now()                       │
│ updated_at        timestamptz  NOT NULL  DEFAULT now()                       │
│                                                                              │
│ UNIQUE (project_id, kind)   -- one row per phase kind per project            │
│ UNIQUE (project_id, sequence)                                                │
│ INDEX  (project_id, sequence)                                                │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│ schedule.phase_sign_off_request                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│ id                 uuid  PK  default gen_random_uuid()                       │
│ phase_id           uuid  NOT NULL  REFERENCES schedule.project_phase(id)    │
│ requested_by       uuid  NOT NULL  ← identity.party.id (bare ref)           │
│ requested_at       timestamptz  NOT NULL  DEFAULT now()                     │
│ status             text  NOT NULL  DEFAULT 'pending'                         │
│                          CHECK IN ('pending','approved','rejected')          │
│ resolved_at        timestamptz                                               │
│ resolution_comment text                                                      │
│                                                                              │
│ -- Only one pending request per phase at a time                              │
│ UNIQUE (phase_id) WHERE status = 'pending'  (partial index via CHECK)       │
│ INDEX (phase_id, status)                                                     │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│ schedule.rfp                                                                 │
├──────────────────────────────────────────────────────────────────────────────┤
│ id           uuid  PK  default gen_random_uuid()                             │
│ phase_id     uuid  NOT NULL  REFERENCES schedule.project_phase(id)          │
│ description  text  NOT NULL                                                  │
│ attachments  jsonb NOT NULL DEFAULT '[]'                                     │
│              ← [{key, filename, size, content_type, url}] — R2 refs         │
│ status       text  NOT NULL DEFAULT 'draft'                                  │
│              CHECK IN ('draft','sent','closed')                              │
│ created_at   timestamptz  NOT NULL  DEFAULT now()                           │
│ updated_at   timestamptz  NOT NULL  DEFAULT now()                           │
│                                                                              │
│ -- One active RFP per procurement phase (v1 constraint, relax in v2)        │
│ UNIQUE (phase_id) WHERE status != 'closed'                                  │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│ schedule.rfp_recipient                                                       │
├──────────────────────────────────────────────────────────────────────────────┤
│ id               uuid  PK  default gen_random_uuid()                         │
│ rfp_id           uuid  NOT NULL  REFERENCES schedule.rfp(id)                │
│ email            text  NOT NULL                                              │
│ token_hash       text  NOT NULL  UNIQUE  ← SHA-256, same as invitation      │
│ status           text  NOT NULL  DEFAULT 'invited'                           │
│                       CHECK IN ('invited','viewed','submitted','declined')   │
│                                                                              │
│ UNIQUE (rfp_id, email)                                                       │
│ INDEX  (rfp_id, status)                                                      │
└──────────────────────────────────────────────────────────────────────────────┘
   [PRD v2] token_expires_at REMOVED — expiry is now dynamic (Option A). A token
   is valid iff its RFP's procurement phase is still active. See §5.

┌──────────────────────────────────────────────────────────────────────────────┐
│ schedule.plan_change_log   [PRD v2 — new]                                    │
├──────────────────────────────────────────────────────────────────────────────┤
│ id             uuid  PK  DEFAULT gen_random_uuid()                           │
│ phase_id       uuid  NOT NULL  REFERENCES schedule.project_phase(id)        │
│ entity_type    text  NOT NULL  CHECK IN ('task','stage','dependency')       │
│ entity_id      uuid  NOT NULL                                                │
│ field_name     text  NOT NULL                                               │
│ old_value      jsonb                                                         │
│ new_value      jsonb                                                         │
│ actor_party_id uuid          ← identity.party.id (bare ref); NULL = system  │
│ occurred_at    timestamptz  NOT NULL  DEFAULT now()                         │
│                                                                              │
│ INDEX (phase_id, occurred_at)                                               │
│ INDEX (entity_type, entity_id)                                              │
└──────────────────────────────────────────────────────────────────────────────┘
   Captures the PRE-sign-off audit trail (who moved a task date, renamed a
   stage, added a dependency, etc.) while the plan is still freely editable.
   Append-only, never updated in place. **Writes STOP once the phase reaches
   `signed_off`** — from that point the change-order ledger (ADR-0014) is the
   sole record of mutation. This keeps the two audit surfaces non-overlapping:
   plan_change_log = draft/active edits, change_order = post-lock edits.

┌──────────────────────────────────────────────────────────────────────────────┐
│ schedule.rfp_proposal                                                        │
├──────────────────────────────────────────────────────────────────────────────┤
│ id                   uuid  PK  default gen_random_uuid()                     │
│ rfp_recipient_id     uuid  NOT NULL  REFERENCES schedule.rfp_recipient(id)  │
│ company_name         text  NOT NULL                                          │
│ website_url          text                                                    │
│ portfolio_images     jsonb NOT NULL DEFAULT '[]'  ← same R2 ref shape       │
│ budget_min_cents     bigint  NOT NULL  CHECK (budget_min_cents >= 0)        │
│ budget_max_cents     bigint  NOT NULL  CHECK (budget_max_cents >= budget_min_cents) │
│ timeline_days        int   NOT NULL  CHECK (timeline_days > 0)              │
│ comment              text                                                    │
│ submitted_at         timestamptz  NOT NULL  DEFAULT now()                   │
│                                                                              │
│ UNIQUE (rfp_recipient_id)  ← one proposal per recipient                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Append-only / tamper-evident note:** `phase_sign_off_request` rows are
never deleted or status-updated in place — a rejection inserts a new row with
`status='rejected'` (same pattern as ledger events). A `signed_off` phase
status is a one-way transition enforced by a DB trigger.

---

### 3. Phase auto-creation

Phase 0 (`procurement`) and Phase 1 (`execution`) are created automatically
**on project creation** inside the existing `:create` transaction
(services/identity or the API gateway that creates the ledger event). This
avoids any "no phases" migration concern — all new projects get phases
out-of-the-box.

**Existing projects** (no phases yet): a lazy-init guard in the `GET /phases`
handler creates the two default phases on first read, within a transaction
with a row-level lock on the project row (same pattern the plan `:author`
uses for version_no). This is safe and invisible to the UI.

**[PRD v2] "Do you already have a signed contractor?" — placement.**

**Recommendation: Option A (project-creation wizard step), with Option B as the
fallback for pre-existing phase-less projects.** Rationale: the answer decides
*which* phase starts `active` at creation time —

- **No** → `procurement` phase is `active`, `execution` is `pending`. The owner
  runs an RFP first, then activates execution when a constructor is selected.
- **Yes** → `procurement` is created but immediately `archived` (or `pending`
  and skipped), and `execution` starts `active`. No RFP loop.

Because this is a *seed-time* decision that shapes the initial phase state, it
belongs at creation, not as a lazy first-visit prompt where we'd have to guess a
default and then reconcile. Answering at creation means the `:create`
transaction seeds the correct active phase deterministically.

- **Route/component:** the existing `/projects/new` wizard (LINA-227). Add the
  question to the pre-Basics **"Your role" step** (`app/src/app/projects/new/`
  — the role screen at `/projects/new`, before `/projects/new/basics`). It's a
  natural fit: the role screen already asks *who the creator is*; "do you have a
  contractor yet?" is the same class of setup question and feeds `creatorRole` /
  draft-driver logic already established in LINA-221/227.
- **Wire value:** carry a boolean `hasSignedContractor` into the create payload;
  the phase-seed logic in the `:create` transaction reads it.
- **Option B fallback:** for legacy projects that hit the lazy-init guard with no
  phases, default to `procurement` active (safest — assumes no contractor) and
  surface a one-time first-visit banner on `/projects/[id]/plan` offering "I
  already have a contractor — skip to execution." This reuses the same phase
  transition (`activate execution`, `archive procurement`) as the constructor-
  selected path, so no extra code.

---

### 4. Route Map

**[PRD v2] Single `/plan` page.** The per-phase route split
(`/plan/procurement`, `/plan/execution`, `/plan/procurement/rfp/*`,
`/plan/execution/build`) is **removed**. Both phases live on one page as
accordion sections (see §6). The RFP composer, proposals inbox, and sign-off
controls render *inside* the accordion sections, not on dedicated routes.

```
Current                           Proposed (add/change) — PRD v2
─────────────────────────────     ──────────────────────────────────────────
/projects/[id]                    unchanged (record home)
/projects/[id]/plan               unchanged URL — now a single page with both
                                  phases as accordion sections (Procurement +
                                  Execution). RFP composer / proposals inbox /
                                  sign-off all render within it.
/projects/[id]/plan/build         → 307 redirect to /projects/[id]/plan
/projects/[id]/plan/import        → 307 redirect to /projects/[id]/plan
/projects/[id]/plan/tasks/[key]   unchanged (task drawer deep-link)

Token-scoped (no Clerk auth, single-purpose) — unchanged:
                                  + /rfp/[token]           (proposal form)
                                  + /rfp/[token]/submitted (confirmation)
```

**Redirect rationale:** `/plan/build` and `/plan/import` were internal entry
points, never externally bookmarked. Folding them into `/plan` (build/import
become in-page actions on the Execution accordion) removes navigation churn; the
307 redirects preserve any existing in-app links during the transition.

**REMOVED routes** (were in rev. 1, do not implement): `/plan/procurement`,
`/plan/execution`, `/plan/procurement/rfp/new`, `/plan/procurement/rfp/[rfpId]`,
`/plan/procurement/rfp/[rfpId]/proposals`, `/plan/execution/build`,
`/plan/execution/import`, `/plan/execution/tasks/[key]`.

---

### 5. Auth Model for Token Guests

RFP recipients are unauthenticated — they receive a link, not a Clerk invite.
Token flow mirrors `identity.invitation`:

**[PRD v2] Dynamic token expiry — Option A (chosen).** Instead of storing a
fixed `token_expires_at`, a token is valid **iff its RFP's procurement phase is
still `active`**. When the Execution phase activates (a constructor is selected),
every RFP token for that project goes dead automatically — no timestamp to store,
no forgotten `UPDATE`, no clock skew. The validity check is a single join.

Why Option A over B: Option B (nullable `token_expires_at`, set inside the
select-constructor transaction) reintroduces a denormalized field that must be
kept in sync, and a token could linger valid if that write is ever missed. Option
A makes `project_phase.status` the single source of truth — the same value that
already gates plan editing. One less column, one less failure mode.

```
send()
  → generate 32-byte random token
  → store SHA-256(token) in rfp_recipient.token_hash
  → email raw token in link: /rfp/{token}
  (no expiry stored — validity is derived, see below)

/rfp/[token] handler
  → SHA-256 the path segment
  → SELECT r.*, ph.status AS phase_status
      FROM rfp_recipient r
      JOIN rfp   ON rfp.id = r.rfp_id
      JOIN project_phase ph ON ph.id = rfp.phase_id
     WHERE r.token_hash = $1
  → REJECT if phase_status != 'active'   ← dynamic expiry
      (procurement closed → constructor already chosen → RFP window over)
  → REJECT if r.status = 'submitted'     ← single-use for submission
  → set a short-lived signed cookie (httpOnly, sameSite=strict, 1-hour TTL)
    scoped to /rfp/[token]/* so multi-tab stays authenticated
  → respond with the RFP detail + proposal form

POST /rfp/[token]/proposals
  → verify same cookie + re-check token_hash AND phase still active
  → INSERT rfp_proposal, UPDATE rfp_recipient.status = 'submitted'
```

No Clerk session is created. The token is single-use for submission (the same
cookie lets the `/rfp/[token]/submitted` confirmation page render). Selecting a
constructor / activating Execution is the one action that invalidates all
outstanding RFP tokens for the project — document this on the select-constructor
handler so the coupling is obvious.

---

### 6. UI Surface Map

**[PRD v2] Accordion, not tabs.** The phase switcher tabs are replaced by
**collapsible accordion sections** on the single `/projects/[id]/plan` page. Both
phases render as stacked sections; the FE decides which is expanded by default
based on phase status (active phase open, others collapsed). A collapsed /
signed-off section shows a status badge and stays expandable for read-only
history review. **This is an FE-only change — no schema impact.**

```
/projects/[id]/plan   (single page — accordion of phase sections)
┌──────────────────────────────────────────────────────────────────┐
│  Plan — [Project Name]                                            │
│                                                                  │
│  ▼ Procurement                          [badge: Active / Archived]│
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  [+ Create RFP]   or   [View RFP]                        │   │
│  │  RFP composer (inline): description, R2 attachments,     │   │
│  │    recipient emails, [Save Draft] [Send to Recipients]   │   │
│  │  Proposals inbox (table):                                │   │
│  │    Company | Budget range | Timeline | Submitted at      │   │
│  │    → expandable row: website, portfolio images, comment  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ▼ Execution              [badge: Draft / Proposed / SIGNED OFF] │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                                   [Request Sign-Off] ←active│   │
│  │  [existing unified PlanGrid + Gantt, LINA-248]           │   │
│  │  (read-only overlay when phase.status = 'signed_off')    │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘

Collapsed / signed-off section:
  ▶ Procurement   [Archived]      ← click to expand read-only history
  ▶ Execution     [SIGNED OFF]    ← click to expand read-only plan

Sign-Off Request modal (net-new)
  - "You are requesting that [Owner name] sign off on this plan."
  - "Once signed off, all changes must go through a change order."
  - [Cancel] [Request Sign-Off]

Signed-off read-only overlay (inside Execution section)
  - Plan grid cells non-editable (pointer-events:none + aria-disabled)
  - "This plan is signed off. To make changes, raise a change order." banner
  - [Raise Change Order] → /change-orders/new (existing flow, ADR-0014)

Token-scoped proposal form (net-new, no Clerk auth) — unchanged
/rfp/[token]
  - RFP description + attachments (read-only)
  - Company name, website, portfolio images upload (R2)
  - Budget (min / max), timeline days, comment  →  [Submit Proposal]
```

Net-new components: the accordion shell, RFP composer, proposals inbox, sign-off
modal/banner, and the token-scoped form. The only modification to an *existing*
screen is the plan grid: a `locked` flag from the phase query makes it read-only
and injects the change-order banner (see §8).

**[PRD v2] Clay / amber visual state — new treatment, flagged for FE.** Once a
plan is `signed_off`, items that have a *pending change order* against them must
render in a **distinct warm amber / "clay"** state in the locked plan grid — so
the owner can tell at a glance which locked rows have a change in flight vs. which
are stable. **This is a NET-NEW visual treatment; it is not in the current token
palette.** FE action items:
- Add a semantic token (e.g. `--status-pending-change` / clay-amber) to
  `tokens.json` (single source, incl. dark + contrast gate — LINA-156), rather
  than a hard-coded hex. Must pass the existing contrast gate in both themes.
- Apply it to grid rows/cells whose task or stage has an open change order
  (join plan rows to open `change_order` records, ADR-0014).
- Not just a background: pair the color with a small "Change pending" chip/icon
  so it's not color-only (a11y — the read-only grid is already `aria-disabled`).

---

### 7. Email Infrastructure

**Existing:** `services/email/sender.mjs` uses Resend (ADR-0007 §5). No new
provider is needed.

**New templates (React Email or plain text):**

| Template | Subject | Trigger |
|---|---|---|
| `rfp-invitation` | "You're invited to submit a proposal for [Project Name]" | `rfp.send()` per recipient |
| `sign-off-request` | "[GC Name] is requesting your sign-off on the execution plan" | `phase_sign_off_request` INSERT |
| `sign-off-approved` | "Execution plan signed off — [Project Name]" | `phase_sign_off_request.status = 'approved'` |
| `sign-off-rejected` | "Sign-off request rejected — [Project Name]" | `phase_sign_off_request.status = 'rejected'` |

Templates live at `services/email/templates/`. The sender helper already
accepts a `to`, `subject`, and `html` argument — we pass rendered template
HTML directly (same pattern as the magic-link email).

---

### 8. Change Order Guard (post-sign-off)

**Server-side guard (primary):**

In `services/schedule`, every mutation handler that touches `stage` or `plan`
rows adds a phase-status check before executing:

```js
const phase = await getExecutionPhase(projectId);
if (phase?.status === 'signed_off') {
  throw new ApiError(409, 'PLAN_LOCKED', 'Plan is signed off. Use a change order.');
}
```

This applies to `:author`, `:propose`, `stage PATCH`, `stage DELETE`.

**[PRD v2] Pre-sign-off audit via `plan_change_log`.** *Before* a phase is
`signed_off` (i.e. while these same mutation handlers are still allowed), each
task/stage/dependency field change appends a `plan_change_log` row
(`entity_type`, `entity_id`, `field_name`, `old_value`, `new_value`,
`actor_party_id`). The two audit surfaces are cleanly split by the sign-off
boundary: `plan_change_log` records draft/active edits; the change-order ledger
(ADR-0014) records everything after lock. The guard above is exactly the point
where writes flip from one surface to the other.

**Client-side guard (UX):**

The PlanGrid and task-drawer components receive a `locked` prop derived from
the phase status. When `locked`:
- Drag handles are hidden
- Inline edit cells show a lock icon and are non-interactive
- CTA buttons in the task drawer are replaced with "Raise Change Order →"

The server guard is the source of truth; the client guard is a UX courtesy.

---

### 9. ER Diagram (ASCII)

```
identity.project ──┐
                   │ (bare ref, no FK)
                   ▼
      schedule.project_phase ──────────────┬──────────────┬─────────┐
             │                             │              │         │
             │ 1:N                         │ 1:N          │ 1:N     │ 1:N
             ▼                             ▼              ▼         ▼
  schedule.phase_sign_off_request   schedule.rfp   plan_change_log  (execution
                                          │          [PRD v2]        plan rows)
                                          │ 1:N
                                          ▼
                                schedule.rfp_recipient
                                          │
                                          │ 1:1
                                          ▼
                                schedule.rfp_proposal
```

---

### 10. Phase state machine

```
         ┌──────────┐
         │  pending │ ← created on project creation, not yet activated
         └────┬─────┘
              │ activate()
              ▼
         ┌──────────┐
         │  active  │ ← plan can be edited; sign-off can be requested
         └────┬─────┘
              │ sign_off approved
              ▼
         ┌────────────┐
         │ signed_off │ ← immutable; all edits via change order (ADR-0014)
         └────────────┘

State `archived` reserved for future (e.g., procurement phase after execution begins).
```

---

## Open Questions (map to PRD Q1–Q5)

| Q | Question | Design impact |
|---|---|---|
| Q1 | Can the owner themselves request sign-off, or only GC? | Determines `requested_by` validation rule |
| Q2 | Is multi-round RFP (revise + re-send) in scope? | Affects `rfp.status` FSM and `UNIQUE(phase_id) WHERE status != 'closed'` |
| Q3 | Do sub-contractors get Clerk accounts after accepting a proposal? | Determines if `rfp_proposal` needs a `party_id` FK added post-acceptance |
| Q4 | Close-out phase in scope for v1? | Affects initial `kind` CHECK constraint |
| Q5 | Sign-off notification: owner in-app vs email-only? | Affects notification infrastructure scope |

None of Q1–Q5 block schema or route design — all have narrowing answers. The
implementation child issues will carry the founder-approved answers as
constraints.

---

## Implementation decomposition (post-PRD approval)

| Child issue | Owner | Dependency |
|---|---|---|
| BE: migration 0012 (phases + RFP + sign-off + **plan_change_log**) + phase CRUD API + wizard seed (`hasSignedContractor`) | BE dev | — |
| BE: RFP + recipient + proposal APIs + **dynamic** token auth (phase-join, no `token_expires_at`) | BE dev | migration 0012 |
| BE: sign-off request API + change-order guard + **plan_change_log writes** | BE dev | migration 0012 |
| BE: email templates + send triggers | BE dev | RFP + sign-off APIs |
| FE: single `/plan` page **accordion shell** + execution locked state + **clay/amber pending-change token** | FE dev | phase API + tokens.json |
| FE: sign-off request modal + banner | FE dev | sign-off API |
| FE: procurement accordion section — RFP composer + proposals inbox (in-page, no sub-routes) | FE dev | RFP API |
| FE: token-scoped proposal form (`/rfp/[token]`) | FE dev | token auth API |
| FE: `/projects/new` "Your role" step — add "already have a contractor?" question | FE dev | wizard seed API |
| FE: `/plan/build` + `/plan/import` → 307 redirect to `/plan` | FE dev | accordion shell |
| QA: e2e sign-off + change-order guard + dynamic-token expiry | QA | all above |

**All PRs target `dev` first (ADR-0022).**

**Migration note:** the current migration head is `schedule/0011`; PRD v2 keeps
everything in **one** migration `schedule/0012_project_phases_rfp_signoff.sql`
(now including `plan_change_log` and *omitting* `rfp_recipient.token_expires_at`).

---

## Addendum A — LINA-277 / LINA-278 implementation decisions

Shipped together (migration 0012 + phase lifecycle API) because the one-way
`signed_off` transition and the immutable audit surfaces are one tightly-coupled
slice over the `schedule` schema. Four decisions refine §2/§3/§8 as built:

1. **Sign-off resolution is IN PLACE, not append-only — fixed forward in
   migration 0013.** Migration 0012 (LINA-277, #129) shipped
   `phase_sign_off_request` with an append-only grant (`SELECT+INSERT`) and an
   "append-only ledger, rejection = new row" comment. But the table it created is
   built for in-place resolution: the `resolved_at`/`resolution_comment` columns,
   the `resolved_iff_not_pending` CHECK, and the partial
   `UNIQUE (phase_id) WHERE status='pending'` index all describe resolving the
   addressed request row — and the endpoint contract
   (`/sign-off/:requestId/approve|reject`) is request-addressed. With INSERT-only,
   a pending row can never be resolved and a second terminal row leaves it stuck
   pending, permanently blocking the one-pending index. Because 0012 is already
   applied (byte-frozen by the prod schema-gate), the fix is **forward-only:
   migration 0013 `GRANT UPDATE ON phase_sign_off_request`**, enabling approve/
   reject to stamp `status + resolved_at + resolution_comment` on the pending row.
   **Tamper-evidence for the sign-off DECISION lives in the one-way
   `project_phase` trigger + the immutable `plan_change_log` + the change-order
   ledger — not in the workflow request row,** which is a mutable-lifecycle record
   like `rfp`/`rfp_recipient` (both of which already grant UPDATE in 0012).

2. **Sign-off authorization (interim, pending PRD Q1).** Q1 (owner-only vs GC
   request) is unanswered, so v1 requires project **membership** to request, and
   bars the **requester from approving their own request** (`cannot_self_approve`)
   — a plan is signed off *by the other party*, never self-approved. This
   integrity floor holds regardless of how Q1 lands; the finer GC-requests /
   owner-approves rule narrows it later without schema change.

3. **Phase seed-at-create is gateway-orchestrated, not Identity-owned.** Project
   creation is Identity's (it owns the project row); the phase tables live in
   `schedule`. Rather than have Identity write another service's schema (an
   ADR-0006 §1 boundary break), the gateway container seeds phases *after*
   `createProject` returns, reading `hasSignedContractor` from the create body.
   Seeding is best-effort + idempotent (`ON CONFLICT (project_id,kind) DO
   NOTHING`); a missed seed is recovered by lazy-init on the first `GET /phases`,
   so a phase failure never fails the already-committed project creation.

4. **Change-order guard + `plan_change_log` writes are a follow-up child.** This
   slice ships the audit-critical primitive — the one-way `signed_off` transition
   (DB trigger + service) and `assertPlanEditable(projectId)`, the guard the plan
   mutation handlers call. Wiring that guard into `:author`/`:propose`/stage
   PATCH/DELETE and writing pre-sign-off `plan_change_log` field diffs is a
   separate BE child (the migration table + the guard primitive already exist, so
   it is a wiring task, not new schema). Until it lands, the `signed_off` phase is
   immutable but the plan-edit *lock* is not yet enforced at the mutation
   handlers.

**RFP recipient/proposal token APIs and email** remain separate downstream
children (their tables ship in 0012; no endpoints in this slice).
