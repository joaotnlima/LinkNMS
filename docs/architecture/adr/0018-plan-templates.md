# ADR-0018 — Plan templates: editable system default + saveable user/org default

- Status: Accepted (2026-09-10 — both product decisions made, see §Decisions made)
- Date: 2026-09-10
- Deciders: Full-Stack Architect (owner); Founder/Product decided the two forks
- Issue: LINA-232 "Plan templates: editable system default + saveable user/org default skeleton"
- Parent: LINA-231 (clear `schedule.stage`)
- Anchors: ADR-0017 (direct plan authoring), ADR-0005 (schedule/plan documents),
  ADR-0004 (permission model), ADR-0006 §1 (schema isolation), ADR-0002 §4/§5
  (tamper-evidence), slice-direct-plan-authoring-contract.md

## Context

The founder's ask on LINA-231: *"the skeleton should scaffold, not a frozen
table … have a table that serves as a user default or even system default
skeleton, but always allow changes … the user should be able to define its own
structure and set it as default for other projects."*

**What already exists (so we build the gap, not what exists):**

- The plan skeleton is **already a scaffold, not an enforced table.** It is the
  FE constant `PLAN_SKELETON` in `app/src/lib/plan-authoring.ts` (3-phase /
  21-task residential WBS, names only). Opening the plan builder pre-fills it via
  `seedSkeleton()`; the author renames/reorders/adds/removes freely and saves a
  private draft (LINA-230, migration 0005). The schedule service *"has no
  skeleton of its own — it validates and writes whatever is sent."*
- `schedule.stage` rows are therefore **instances** of a plan, never a template.
  The only thing that *enforces* is the baseline **freeze guard**
  (`stage_freeze_guard` / `_delete_guard`), which bites only on a **terminal**
  version (accepted/superseded/withdrawn/rejected). A `draft` and an open
  `proposed` version are fully editable. **That freeze is the audit promise and
  is out of scope here — it does not loosen.**

**The two real gaps:**

1. The default skeleton is hard-coded in one FE constant — not a real
   **system-default template** anyone can see, and not owner/org editable.
2. There is **no user/org "my default"** — a user cannot save the structure they
   built and have the next project scaffold from it.

## Decision

A plan template is a **names-only scaffold with no audit weight.** It is not a
plan, not a version, and never links to a project's stages — scaffolding
**copies**, it does not reference. This keeps templates entirely outside the
tamper-evident record (ADR-0002): nothing a template does can move a budget,
stamp authorship, or alter a frozen baseline. Editing a template is a mutable
CRUD write, deliberately unlike the append-only plan lifecycle.

### 1. New table `schedule.plan_template` (owner-scoped)

```
schedule.plan_template
  id            uuid   pk
  owner_scope   text   not null  check in ('system','org','user')
  owner_id      uuid   null       -- null iff owner_scope='system'
  name          text   not null
  is_default    boolean not null default false
  body          jsonb  not null   -- names-only phase/task shape (== PLAN_SKELETON)
  created_at    timestamptz not null default now()
  updated_at    timestamptz not null default now()

  check ((owner_scope = 'system') = (owner_id is null))
  -- one default per owner: partial unique index
  unique index on (owner_scope, owner_id) where is_default
```

`body` is the same names-only shape `PLAN_SKELETON` already defines:
`[{ name, tasks: [name, …] }]` — two levels, no dates, no owners, no ids. It is
validated on write with the same two-level rule the authoring contract uses; a
template that tried to carry dates/owners is rejected at the edge.

### 2. Seed one `system` default from today's `PLAN_SKELETON`

A single seeded row (`owner_scope='system'`, `owner_id=NULL`, `is_default=true`)
becomes the **single source of truth** for the default shape. `PLAN_SKELETON`
in the FE is retired to a **last-resort fallback only** (used if the resolve
endpoint is unreachable), with a test asserting the two stay identical until the
FE constant is deleted.

### 3. `seedSkeleton()` resolves through a scope ladder

A new read endpoint returns the applicable default body; `seedSkeleton()`
resolves **user default → system default** (first hit wins) in v1 — org is
deferred per §Decisions made, so it is skipped in the ladder though the schema
carries it. The
resolve is a pure read — it copies `body` into a fresh editor draft with new
client keys, exactly as `seedSkeleton()` does today. No project, no stage, no
version is touched by resolving.

### 4. "Save as my default" writes the caller's template from the current draft

A control in the plan builder upserts the caller's `user` (or `org`) default
template from the current editor draft (names only; dates/owners stripped). It
never touches an existing project's stages — a template is a copy target, not a
link. Upsert flips `is_default` under the partial unique index (one default per
owner). The `system` row is **not** user-writable in v1 (see open decision on
who may edit it).

### 5. What does NOT change

- The freeze model and the stage audit trail — untouched.
- The plan lifecycle (draft → proposed → accepted/superseded) — untouched.
- The schedule service stays the sole owner of the `schedule` schema (ADR-0006).
  Templates live in `schedule` because they are plan-shaped, but carry **no**
  ledger seam — they are outside the audit record by design.

## Decisions made (Founder/Product, 2026-09-10)

Both forks were answered on the LINA-232 decision card (interaction answered
2026-09-10T14:46). The founder's words: *"fallback to the 1 standard phase we
currently have. let the user create and set its own default if needed"* +
library = **single**.

1. **Default scope — per-user.** A new build scaffolds from the caller's own
   saved default when they have one, and otherwise from the seeded `system`
   default (today's standard skeleton). "Save as my default" writes a `user`
   template. The founder chose per-user over per-org ("let the user create and
   set its own default"); **org scope is deferred** — the column and enum value
   stay in the schema (no rework to enable later) but v1 neither writes nor
   consults `org`.

2. **Single "my default" per user — no named library in v1.** The caller has
   exactly one default. The `plan_template` table still permits multiple rows
   per owner, so a named library is a later additive slice with no migration
   rework (the partial unique index already allows many non-default rows).

**Resulting v1 resolution ladder (supersedes §3's three-hop ladder):**
`user default → system default`. Org is skipped in v1 (deferred), so the ladder
is two hops, not three. The `system` row remains the single source of truth for
the standard shape and is not user-writable in v1.

## Consequences

- **Effort:** ~1 BE slice (table + seed + resolve/upsert endpoints + validation)
  + 1 FE slice ("Save as my default" + resolve wiring in `seedSkeleton()`; a
  template picker only if the library decision goes that way).
- **Tech debt paid down:** the default plan shape stops being a compiled-in FE
  constant and becomes data anyone can inspect and (for their scope) edit.
- **Tech debt noted:** until the FE constant is deleted, two copies of the
  default shape exist (FE fallback + seeded row), guarded by an equality test.
- **Risk:** low. Templates are outside the audit record; the worst failure is a
  wrong scaffold, which the author edits freely before committing — the freeze
  guard and ledger are never in the path.

## Sequencing

Sequencing is Product/CEO's call. The two decisions are now made (§Decisions
made), so this ADR is Accepted and the build splits into two children:
**BE** (migration: `schedule.plan_template` + seed system default from
`PLAN_SKELETON`; resolve + upsert endpoints; two-level body validation) and
**FE** ("Save as my default" control + `seedSkeleton()` resolves via the new
endpoint, `PLAN_SKELETON` demoted to unreachable-endpoint fallback). v1 writes
and consults the `user` scope only.
