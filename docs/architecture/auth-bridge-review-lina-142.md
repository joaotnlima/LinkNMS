# Auth Bridge Pattern — §8 Open Items: Architect Review (LINA-142)

- **Status:** Ratified — approved for merge (code already on `main`)
- **Date:** 2026-09-03
- **Reviewer:** Full-Stack Architect
- **Review issue:** LINA-142 (0A-review)
- **Under review:** LINA-123 Auth Migration 0A — Clerk → Neon RBAC bridge
  (LINA-140 schema, LINA-143 `can()` + sync, LINA-136 Clerk wiring, LINA-137
  profile/role grant)
- **Builds on:** ADR-0004 (permission model), ADR-0006 (schema isolation),
  ADR-0007 (magic-link sign-in), ADR-0008 (seats)

## Purpose

The Auth Bridge Pattern §8 listed four open items that had to be settled by the
Architect **before** the 0A auth stack merged. The implementation cites this
review as `Architect LINA-142 §8.1–§8.4`; this document is the artifact those
citations resolve to. Each item below records the decision, the rationale, and
the merge-gate condition (met / outstanding).

**Verification for this review** — read on `main` @ `a9266b8`:
`services/auth/migrations/{0001,0002,0003}`, `services/auth/{can,require-auth,
clerk,sync,profile,webhook,svix}.mjs`, `apps/api/server.js`,
`services/identity/session.mjs`. `services/auth` test suite: **32/32 pass**.

---

## §8.1 — Permission matrix per role (owner / gc / subcontractor × verbs)

**Decision: RATIFIED.** The matrix is seeded in
`services/auth/migrations/0002_authz_seed.sql` over a 17-verb, dot-namespaced
catalogue and mirrored as a frozen enum in `services/auth/can.mjs` (`PERMISSION`).

| Verb | owner | gc | subcontractor |
|------|:---:|:---:|:---:|
| project.create | ✓ | | |
| project.read | ✓ | ✓ | ✓ *(scoped — see finding F1)* |
| project.update | ✓ | | |
| project.delete | ✓ | | |
| project.invite / member.invite | ✓ | | |
| decision.create | ✓ | ✓ | |
| decision.read | ✓ | ✓ | |
| change_order.create | ✓ | ✓ | |
| change_order.read | ✓ | ✓ | ✓ |
| change_order.decide | ✓† | ✓† | |
| budget.read | ✓ | ✓ | ✓ |
| schedule.read | ✓ | ✓ | ✓ |
| schedule.update | ✓ | ✓ | |
| task.assign | ✓ | ✓ | ✓ |
| progress.report | | ✓ | ✓ *(scoped — see finding F1)* |
| plan.upload | | ✓ | |

**Deny-by-default holds** — a verb a role never grants is forbidden by
construction (`can.mjs` step 4). Verified by the `can()` unit + adversarial
suite.

**† Load-bearing merge gate — the two-sided change-order rule (MET).**
`change_order.decide` is seeded as the **static half only** ("may this role ever
decide a CO?"). The runtime rule — *a CO may be decided by anyone EXCEPT its own
proposer, owner included* (ADR-0004 FR4) — is **not** expressible as a static
row and is enforced in three places:

1. `can.mjs` L135–142 — fails **closed** when the proposer is unknown, denies
   when `actor.userId === resource.proposedBy`, even with a static grant and no
   ACL.
2. The legacy DB CHECK `decided_by <> proposed_by` (defence in depth).
3. `can.test.mjs` — a mandatory adversarial block proving the proposer is denied.

This was my stated gate: *LINA-143's `can()` is rejected at merge without this
predicate and its adversarial test.* **Condition met.**

**Evaluation order is correct** (`can.mjs`): resource-ACL deny → resource-ACL
allow → role grant → deny. Deny wins; verified by test.

**Finding F1 (non-blocking, tech debt).** Subcontractor `project.read` and
`progress.report` are seeded as **blanket** role grants but annotated "SCOPED via
resource_acls / to assigned stages". `can()` has no per-instance predicate for
these verbs, so scoping only takes effect if a per-resource **deny** ACL exists —
i.e. today a subcontractor can read *any* project **in an org they are a member
of**. **Acceptable for v1** because authorization is org-membership-scoped and a
sub only holds membership in the org/project they were invited to, so the blast
radius is that one project. When multiple concurrent projects live under one org,
this must become a real scoping predicate (assigned-stage / resource ACL), same
shape as the `change_order.decide` runtime rule. Tracked as follow-up; **not a
merge blocker.**

---

## §8.2 — Session transport (Bearer token vs cookie)

**Decision: RATIFIED — Bearer token for the Clerk/API plane.**

The new API path (`apps/api/server.js` `requireAuth`, `services/auth/
require-auth.mjs`) reads a Clerk session JWT from `Authorization: Bearer …` and
verifies it via `@clerk/backend` (`services/auth/clerk.mjs`). The actor is
derived **only** from the verified token, never the request body.

Rationale:

- The portal is a separate origin from the API service; a **Bearer token
  explicitly attached by the client** sidesteps the CSRF surface that an ambient
  cross-origin cookie would create — no cookie is auto-sent on forged
  cross-site requests.
- Clerk is the issuer and already manages the browser session; forwarding its
  short-lived JWT to our API is the SDK's intended integration and keeps us out
  of hand-rolled session crypto (§8 "no shortcuts").
- `authorization` and `cookie` are redacted from logs (`server.js` L36).

**Legacy note.** `services/identity/session.mjs` still defines the self-managed
magic-link session as an httpOnly HMAC cookie (`lnms_session`, ADR-0007). That is
the **retiring** identity plane, not the Clerk bridge. Its retirement is a
separate, Architect-gated migration (see §8.4); until then the two transports
coexist and do not interact — the Clerk API plane never reads `lnms_session`.

---

## §8.3 — One-role-per-user-per-org constraint (v1 acceptability)

**Decision: RATIFIED for v1, recorded as deliberate debt.**
`authz.memberships` carries `UNIQUE (user_id, org_id)` — one role per user per
org. Acceptable because the R0 party model (ADR-0004) is one owner + one GC (+
subs) per project and no persona legitimately needs two roles in the same org
at once. The table shape already generalises: relaxing to multi-role is dropping
the unique constraint and having `resolveRolePermissions` union across
memberships — **a data change, not a model change**. No repaint later.
`role_id` uses `ON DELETE RESTRICT` so a role in use cannot be deleted out from
under a membership.

---

## §8.4 — Schema namespace (identity vs authz)

**Decision: RATIFIED — new `authz` schema, `identity` untouched.**
The Clerk-mirrored `users`/`orgs` and the RBAC catalogue live under a **new
`authz` schema** (`0001_authz_rbac.sql`), not overloaded onto the live
`identity` schema. Rationale:

- `identity` is live: its migrations back the ledger's identity grant
  (`services/ledger/migrations/0003_ledger_identity_grant.sql`). Mutating it
  in place with new-shape RBAC tables would be a big-bang change to a namespace
  the audit ledger depends on — unacceptable against the ADR-0002 integrity duty.
- Forward-only, new objects only; **no cross-schema FK** (`resource_id` and org
  ids are bare uuids), matching the ADR-0006 §1 split-DB seam.
- Least privilege: `authz_app` gets SELECT/INSERT/UPDATE on
  `users`/`orgs`/`memberships` and **SELECT-only** on the role/permission
  catalogue, so a request-path bug cannot grant itself a permission. **No DELETE
  anywhere** — revocation is `status='disabled'` or an ACL deny, never a row
  destroy (ADR-0002).

The legacy `identity` tables are **not** touched here; retiring them (the
original LINA-37 scope) is a separate migration gated on cutover being proven.

---

## Disposition

**APPROVED.** All four §8 open items are ratified; the one merge gate (the
two-sided `change_order.decide` predicate, §8.1) is met and adversarially
tested. Code is already on `main` (`a9266b8`), `services/auth` suite green
(32/32).

**Follow-up (non-blocking):**

- **F1** — real per-resource scoping for subcontractor `project.read` /
  `progress.report` before multiple projects share one org.
- **Identity retirement** — schedule the gated migration to retire the legacy
  `identity` magic-link plane (§8.2 / §8.4) once Clerk cutover is proven in prod.

Both are tech debt to file as their own issues, not conditions on this merge.
