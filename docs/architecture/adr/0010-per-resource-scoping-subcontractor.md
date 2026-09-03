# ADR-0010 — Per-resource scoping for subcontractor `project.read` / `progress.report`

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** Full-Stack Architect
- **Context issue:** LINA-148 (F1) — from the LINA-142 Auth Bridge review, §8.1.

## Context

The Architect review of the Auth Bridge permission matrix
(`docs/architecture/auth-bridge-review-lina-142.md` §8.1, finding **F1**) flagged
that the subcontractor's `project.read` and `progress.report` verbs are seeded in
`services/auth/migrations/0002_authz_seed.sql` as **blanket role grants** but
annotated *"scoped"*. The pure authorizer `can()` had **no per-instance
predicate** for these verbs, so scoping only took effect if a per-resource
**deny** ACL existed. In practice a subcontractor could `project.read` *any*
project in an org they belong to.

This was ratified as **acceptable for v1**: a subcontractor holds membership in
exactly the one org/project they were invited to, so the blast radius is that one
project. F1 is explicit that this **must become a real scoping predicate before
multiple concurrent projects share one org** — otherwise a sub invited to
project A could read project B under the same org.

## Decision

**Add a per-resource scoping predicate to `can()`, shaped like the two-sided
`change_order.decide` rule, that is DORMANT in v1 and activates when the resolver
supplies an assignment scope.**

1. **The predicate (`services/auth/can.mjs`).** A role-keyed table
   `SCOPED_ROLE_VERBS` marks the verbs a role holds only *within its assignment*
   (v1: `subcontractor → { project.read, progress.report }`). After the role
   grant passes, if the acting role scopes the verb, `can()` requires the
   resource id to be in `assignedResourceIds`:
   - `assignedResourceIds === undefined` → **no assignment source (v1)** → the
     blanket grant stands. This is the documented, ratified v1 behavior.
   - `assignedResourceIds` is an array → **enforce**: the resource must be in the
     set, else deny. A missing resource id denies (**fail-closed**), and an empty
     set denies all scoped reads (assigned to nothing). This mirrors the
     fail-closed posture of the `change_order.decide` predicate.
   - An explicit resource-ACL **allow** (evaluation step 2) still short-circuits
     *before* the predicate — that is the ACL-based assignment mechanism F1 names
     ("assigned-stage / resource ACL").

2. **The resolver seam (`services/auth/require-auth.mjs`).** `authorize()`
   duck-types an optional `store.getAssignedResourceIds(userId, resourceType,
   orgId)` hook and passes its result to `can()`. In v1 no store implements it,
   so the value is `undefined` and the predicate is a genuine no-op. No behavior
   change ships in this ADR.

3. **The seed stays a blanket grant.** The role→permission rows are unchanged;
   scoping is a runtime narrowing of a role capability, not a different grant.
   The comments now point at the `can()` predicate and this ADR.

### Why not enforce now

Enforcing today would regress v1: nothing writes the assignment ACLs / assignment
rows, so subcontractor `project.read` would deny everything. F1 is future-gated;
this ADR lands the *guard, adversarially tested* ahead of the trigger so
activation is a small, safe change rather than a from-scratch build under
pressure.

## The flip (activation checklist)

Activate **before** multiple concurrent projects share one org:

1. Land the **assignment source of truth** — which subcontractor is assigned to
   which project(s)/stage(s). Simplest is per-resource `authz.resource_acls`
   **allow** rows (project ← `project.read`, stage ← `progress.report`) written
   when a sub is invited/assigned to a project; the ACL-allow path already grants
   these with no predicate change. A dedicated `authz.assignments` table is the
   alternative if stage-granularity outgrows the ACL row.
2. Implement `store.getAssignedResourceIds(userId, resourceType, orgId)` to
   return the assigned id set for that resource type. The predicate activates the
   moment it returns an array.
3. Ensure the **invite/assignment write path** creates the assignment as part of
   onboarding a sub to a project (the same transaction that grants membership).
4. Extend the resolver tests to cover the enforced regime end-to-end (the pure
   `can()` predicate is already adversarially covered in `can.test.mjs`).

## Consequences

- **Now:** guard-in-code, no behavior change; `can.test.mjs` proves both the v1
  no-op and the enforced regime (assigned allow, unassigned deny, empty-scope
  deny-all, fail-closed on missing id, other roles/verbs unaffected).
- **Later:** multi-project-per-org becomes safe with a localized change (a store
  method + an assignment write path), not a re-architecture.
- **Tech debt:** the assignment write path and the resolver-level enforcement
  test are tracked as the activation follow-up; until then the predicate is
  intentionally dormant.

## References

- `docs/architecture/auth-bridge-review-lina-142.md` §8.1 F1
- ADR-0004 (multi-party permission model), ADR-0006 §1 (split-DB seam)
- `services/auth/can.mjs`, `services/auth/can.test.mjs`,
  `services/auth/require-auth.mjs`
