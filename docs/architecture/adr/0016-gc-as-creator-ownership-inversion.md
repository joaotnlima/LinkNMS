# ADR-0016 — GC-as-creator: ownership inversion in build creation

- **Status:** Accepted
- **Date:** 2026-09-09
- **Deciders:** Full-Stack Architect
- **Context issue:** LINA-221 — New-build wizard "Who are you on this build?"
  role screen (owner vs GC). Parent LINA-219 (Band B create-build), building on
  ADR-0011 (build-creation operating model).

## Context

The republished New-build pen opens with a pre-wizard screen: *"Who are you on
this build?"* — **General contractor** or **Owner (homeowner)**. LINA-219 shipped
the wizard chrome and the Basics/Model/Invite screens but deferred this screen
because it is not fidelity — it is a **backend/RBAC inversion**. Until it lands
the flow starts at Basics and hard-codes the creator as the owner (the
build-creation GAP this ADR closes).

Today (`services/identity`, ADR-0011) build creation is **owner-first and
owner-only**:

- `createProject` always writes the creator as the `owner` membership and stamps
  `identity.project.owner_party_id = creator` (a `NOT NULL` column, migration
  0002).
- `SET_OPERATING_MODEL` and `INVITE_COUNTERPARTY` are **owner-only** capabilities
  (ADR-0004 table).
- The first invite mints an `identity.invitation` for role `counterparty` — the
  owner invites the GC. `invitation.role` is CHECK-constrained to
  `{counterparty, subcontractor}` (0009); `membership.role` to
  `{owner, counterparty, subcontractor}`.

When a **GC** creates the build the whole spine inverts: the creator is the
`counterparty`, the *homeowner* is the party who gets invited, and the audit
trail must still name a real owner — but at genesis there is **no owner party
yet**. This ADR decides how the record represents that truthfully without
weakening the audit trail or the least-privilege writes ADR-0002/0011 established.

## Decision

### 1. `owner_party_id` is the homeowner, and is NULLABLE until they join

`owner_party_id` keeps its meaning — *the homeowner principal of the build* — and
migration 0015 relaxes it to `NULL`-able. For an owner-created build it is stamped
at genesis exactly as before. For a **GC-created build it is `NULL` at genesis**
and stamped **once**, when the invited owner accepts, in the same unit of work as
their `owner` membership insert and an `owner_joined` ledger event.

This is the honest audit model: the record says *"created by GC X on date D;
owner joined as party Y on date D+n"* rather than pretending the GC was ever the
owner. `owner_party_id` never lies and is never re-pointed away from a real owner
(see §4). Rejected alternative: keep `owner_party_id` `NOT NULL` and point it at
the GC creator as a "record custodian" — that overloads the column with two
different meanings and corrupts the one field the product sells as authoritative.

Authorization is unaffected: `can(...)` decides on **membership role**
(`roleOf`), never on `owner_party_id`, so a `NULL` owner is not an authz hole —
it is simply a build with no homeowner member yet.

### 2. `createProject` takes an explicit `creatorRole ∈ {owner, counterparty}`

Default `owner` — the legacy one-shot path and every pre-LINA-221 caller are
unchanged. The role screen sends `counterparty` for a GC-created build. Effect:

| `creatorRole` | creator membership | `owner_party_id` at genesis | first invite role |
|---------------|--------------------|-----------------------------|-------------------|
| `owner` (default) | `owner` | creator | `counterparty` (GC) |
| `counterparty` | `counterparty` | `NULL` | `owner` (homeowner) |

`creatorRole` is validated server-side (never trusted as a membership claim) and
recorded in the `project_created` genesis payload (`creatorRole`,
`creatorPartyId`) so the immutable event, not just the projection, records who
founded the build and as what.

### 3. The build creator drives their own draft — a "draft-driver" right, NOT a widened role

The wizard's mid-flight steps (`SET_OPERATING_MODEL` and the committing first
invite) must work for a GC creator who joins as `counterparty` — but the
capability table (ADR-0004) is **deliberately NOT widened**, because granting
`counterparty` those actions globally would over-grant on *active* builds (a
joined GC could invite on someone else's turnkey build). Instead the right is a
property of **"sole member of a draft"**:

> A draft build has exactly ONE member — its creator. The only other way to gain
> membership is accepting an invitation, and that same act commits the build to
> `active`. So *"a member of a draft"* uniquely identifies its creator.

Concretely:

- `SET_OPERATING_MODEL` and the first invite authorize via a `draft-driver` gate:
  *authenticated + a member of the (draft) project* — regardless of role. This is
  the sole authority path on a draft.
- Once the build is **active**, invites revert to **owner-only** via the pure
  `can()` decision (unchanged ADR-0004 rule). `SET_OPERATING_MODEL` 409s on any
  non-draft build, so it has no active-build surface at all.
- The invite is further bounded by `UNIQUE(project_id, role)` + the
  one-pending-per-role index + the pre-mint "already has a `{role}`" guard, so the
  driver can only ever invite the **one missing** counter-role — the `owner`, on a
  GC-founded draft.

The membership lookup runs *before* the project fetch, so a non-member is `403`
before any `404` (existence is never leaked — same posture as the shared
authorizer). The invariant "exactly one owner, one primary counterparty per
build" (V1) is what keeps the draft-driver right tight; Hybrid multi-invite (V2)
will revisit who may invite whom against the operating model, per ADR-0011 OQ-3.

### 4. Widen `invitation.role` to admit `owner`; stamp is one-way (NULL→value)

Migration 0015 relaxes the `invitation.role` CHECK to
`{owner, counterparty, subcontractor}` so a GC can invite the homeowner.
`membership.role` already admits `owner` (0009). The invitable role on a build is
computed as **the operating-model role set, plus `owner` when the build has no
owner member yet**:

```
allowedRoles = OPERATING_MODEL_ROLES[operatingModel] ?? ['counterparty']
if (no owner membership exists) allowedRoles += 'owner'
```

The owner stamp is protected two ways so ADR-0002's "budget/ownership move only
as ledger events, never silent projection edits" invariant survives:

- The `owner_party_id` UPDATE is **column-scoped** (0015 grants
  `UPDATE (owner_party_id)` to `identity_app`, never a blanket UPDATE) and
  guarded `WHERE owner_party_id IS NULL` — a build's owner can be **set once** and
  never re-pointed. Re-pointing an existing owner is impossible at the SQL layer.
- The stamp only ever happens inside the accept transaction, alongside the
  `owner` membership insert and the `owner_joined` event — one unit of work, or
  none.

### 5. Analytics reflects the inverting session

The `project_created` analytics event carries `creatorRole`. The existing
`gc_invited` / `gc_joined` events are GC-session semantics keyed on the
`counterparty` role and stay as-is for owner-created builds; a **GC-created**
build's invite is of the `owner` role, so it is **not** reported through those
two events (which would mislabel the homeowner as "the GC"). Per ADR-0011, the
`build_creation` surface + `ROLE` enum that would name these events cleanly are
owned by LINA-163 and still unmerged — this ADR does **not** fork that enum. The
inversion is captured now on the durable ledger (`creatorRole` on genesis,
`owner_joined` event); the product-analytics naming is wired when LINA-163 lands.

## Consequences

- **Migration 0015 is additive and behaviour-neutral to legacy flows.** Every
  existing row already has a non-NULL `owner_party_id`; relaxing the constraint
  changes nothing for them. The widened `invitation.role` CHECK and the new
  column-scoped grant admit the GC path but no live caller exercises it until the
  role screen and the `creatorRole` wiring merge. Legacy `createProject` (no
  `creatorRole`) stays byte-identical.
- **The role screen is the only new UI.** Owner-default; `counterparty` inverts.
  It renders in the existing `WizardChrome` (LINA-219) as pen screen 1. FE is a
  separate child issue (below) against the contract this ADR fixes.
- **New ledger event type `owner_joined`.** It mirrors `member_joined` but marks
  the moment the homeowner principal is bound to a GC-founded record — a
  first-class audit fact ("who became owner, when").
- **`owner_party_id` may be NULL in projections** (`getProject`, portfolio card).
  Readers already tolerate a null-ish attribution (the card renders "Unknown
  party" for a member with no joined `display_name`); a GC draft simply has no
  owner member to render until the homeowner accepts.

## Build order

1. **Migration 0015 + this ADR** — `owner_party_id` NULLable, widen
   `invitation.role`, column-scoped `UPDATE (owner_party_id)` grant *(this PR)*.
2. `createProject` `creatorRole`; invite `allowedRoles` + owner-invite; accept
   path owner stamp + `owner_joined`; the `draft-driver` authz gate; store
   `stampOwnerParty`; HTTP/OpenAPI `creatorRole`; service + adversarial authz
   tests *(this PR)*.
3. **FE role screen route** — pen screen 1, owner-default, `WizardChrome`
   (delegated child, Frontend Dev), against the contract fixed here.

## Follow-ups / risks

- **Hybrid multi-invite (V2, ADR-0011 OQ-3)** will need a richer "who may invite
  which role" rule than the one-missing-counter-role invariant this ADR leans on.
  Flagged, not opened.
- **LINA-163 `build_creation` analytics surface** still unmerged; the GC-created
  invite/join events are named cleanly once it lands (§5).
