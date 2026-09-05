# ADR-0011 — Band B "Create the build and invite": operating model, draft status, and invite vocabulary

- **Status:** Accepted
- **Date:** 2026-09-05
- **Deciders:** Full-Stack Architect (design approved by founder via the LINA-164 confirmation, 2026-09-05)
- **Context issue:** LINA-164 — Build creation flow (parent LINA-162, Band B).

## Context

Band B ("Create the build and invite") lets an owner (Entry A) or a GC (Entry B)
create a build, choose an **operating model** (Turnkey / Direct-to-specialty /
Hybrid), and invite the first counterparty. The functional spec
(`docs/product/build-creation-flow-spec.md`) and analytics contract
(`docs/product/build-creation-analytics-spec.md`) were marked delivered on
LINA-162/LINA-163 but **never merged to the repo** — a broken "done" flagged on
LINA-164. This design is therefore anchored to the surviving source of truth: the
pen file on `main` (`cowork/pen/linkNMS-flows.pen`, "Band B") plus the shipped
identity/auth foundation (LINA-123 auth bridge, LINA-125 invitations, LINA-154
GET /me).

**Headline finding:** ~70% of Band B is already built. The `identity` service
already implements the create-record-then-invite spine — `identity.project`
(0002), the single-use SHA-256 `identity.invitation` (0002/0005), the
`membership` ACL (0002), and the `createProject → inviteCounterparty →
acceptInvitation` flow with its cross-schema ledger seam. Band B is **extend, not
rebuild**.

## Decision

1. **The build IS the project — no new Build table.** Add two projection columns
   to `identity.project` (migration 0009):
   - `operating_model text` — **nullable**; one of `turnkey | direct | hybrid`
     when set. NULL is a first-class "not chosen yet" state for a draft and for
     every pre-Band-B project. The wizard enforces "present before commit" at the
     service layer; the DB keeps NULL legal so legacy rows and drafts stay valid.
   - `status text NOT NULL DEFAULT 'active'` — `draft | active`. `DEFAULT
     'active'` back-fills every existing (fully-formed, one-shot) project
     correctly and keeps the legacy `createProject` path unchanged; the new
     draft-first insert is the **only** writer that sets `'draft'`.

2. **Draft-first.** The build row exists from step 1 (name); the operating model
   is set in step 2; the build flips `draft → active` when the first invite
   commits it. This is why `status` and the column-scoped UPDATE grant exist.

3. **Reuse the hashed single-use `identity.invitation` token — NOT Clerk
   org-invitations.** The invite→accept path is a project-scoped membership +
   ledger event; splitting it across Clerk would re-introduce the "invite
   vanished" gap this table was built to kill. Clerk stays the identity provider
   (answers "who are you?" and hosts inline sign-up on the accept link); the
   project-membership grant stays in `identity`.

4. **Widen the R0 role vocabulary to the launch set (§7 minimum).** Relax the
   `identity.invitation` role CHECK from the single value `counterparty` to
   `{counterparty, subcontractor}` and the `identity.membership` role CHECK to
   `{owner, counterparty, subcontractor}`. GC **stays** `counterparty` (no
   rename); specialty subs map to `subcontractor` (per-resource scoped via
   ADR-0010's dormant predicate). Authz plane stays in sync via the Clerk webhook
   / JIT provisioning — no new sync code.

5. **Per-role pending index now (OQ-3).** Replace the per-project one-pending
   partial unique index with `(project_id, role) WHERE status = 'pending'`. V1
   still invites **one** counterparty per wizard pass; shipping the per-role index
   now makes Hybrid multi-invite a purely additive V2 change, not a migration
   under load. Membership's `UNIQUE(project_id, role)` remains the hard backstop.

6. **Column-scoped UPDATE grant (least privilege).** `identity_app` gets
   `UPDATE (operating_model, status)` on `identity.project` — never a blanket
   UPDATE. The request path can drive the wizard but can **never** rewrite
   `baseline_budget_cents` or `owner_party_id`, whose changes must only ever be
   expressed as ledger events, not silent projection edits (ADR-0002 intent).

## Open questions resolved (founder-approved)

- **OQ-1 invite re-send:** defer a dedicated re-send CTA to a fast follow;
  copy-link on M5 is enough for V1 (the token persists).
- **OQ-2 existing-user invite:** email-always for V1 (uniform, auditable);
  in-app notification is a V2 enhancement.
- **OQ-3 Hybrid multi-invite:** one invite per wizard pass in V1, with the
  per-role pending index shipped now so V2 is additive.

## Consequences

- **Migration 0009 is additive and behaviour-neutral.** The DB admits
  subcontractor invites, but the application still invites only `counterparty`
  (the `inviteCounterparty` guard is relaxed in the step-2 wiring PR), so 0009 can
  merge ahead of the UI without changing any live flow. Verified locally against a
  full 0001→0009 apply: old auto-named CHECKs drop cleanly, the per-role index
  enforces one-pending-per-role, and `identity_app` is denied UPDATE on
  `baseline_budget_cents`.
- **Analytics (surface `build_creation`, 6 events) is NOT wired here.** The
  `SURFACE`/`ROLE` enums are owned by LINA-163, whose contract is still unmerged;
  emission sites are wired once that lands. This ADR does not fork the enum.

## Build order (once unblocked)

1. **Migration 0009 + this ADR** — schema, no UI, no behaviour change *(this PR)*.
2. `PATCH …/operating-model` + draft→active commit + relax the `inviteCounterparty`
   role guard + service tests.
3. Wire analytics once LINA-163's contract lands.
4. M1–M6 mobile screens (after LINA-156 palette migration merges), then D1–D6.

## Follow-ups / risks

- **Restore the two missing PM spec docs** (`build-creation-flow-spec.md`,
  `build-creation-analytics-spec.md`) — screen-level ACs (AC-B1..B9) and the exact
  6 event names still live only in the lost workspace. Owner: PM/LINA-162.
- **LINA-156** (portal `:root` palette migration) must merge before any Band B
  screen is merged (LINA-162 handoff).
