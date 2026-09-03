# ADR-0009 — Sequence the portal `globals.css :root` migration onto the pen palette

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** Full-Stack Architect
- **Context issue:** LINA-155 (raised from LINA-133). Related: LINA-80, LINA-86,
  LINA-87, LINA-92, LINA-100, LINA-132, LINA-133.

## Context

Two palettes are live in `app/` at once:

| | Owner | Builder | Paper | Ink | Font |
|---|---|---|---|---|---|
| `globals.css :root` (LINA-27) | `#2A78D6` | `#EB6834` | `#FCFCFB` | `#0B0B0B` | system-ui |
| Pen / onboarding brief | `#3E5C8A` | `#B4633B` | `#FBFAF7` | `#16181D` | Inter |

Two onboarding tickets declined to re-token `:root` from an onboarding ticket —
re-painting the four pillars and every RAG state was out of their scope — and
scoped the pen palette locally instead:

- `app/src/app/onboarding/setup/onboarding-setup.css` — scoped to `.ob` (LINA-132, **merged**)
- `app/src/components/empty-portal.css` — scoped to `.onb` (LINA-133, **PR #48, in flight**)

Each block carries a comment: delete it once `:root` moves. LINA-155 asks for
the sequencing call that lets that happen.

### The two facts that change the answer

Investigating the actual tree (not the ticket's framing) surfaced two things:

1. **The token source of truth already carries the pen palette.**
   `design-system/tokens.json` **on `main`** is `--owner: #3e5c8a`,
   `--builder: #b4633b`, `--plan-actual-fg: #8a4522`, with the full `--plan-*`
   family. It was re-based by **LINA-86** and the landing side (LINA-100) is
   merged. The stale artefact is *only* the portal's hand-mirrored
   `globals.css :root`, which still hard-codes the retired LINA-27 hexes.
   `app/src/app/tokens.css` (the generated portal token file) **does not exist on
   `main` at all.**

2. **The migration was already built — and marked done — but never landed.**
   Branch `lina-92-portal-palette-migration` (LINA-92, issue status *done*)
   rewrites `globals.css` to `@import "./tokens.css"`, adds the generated
   `tokens.css` (both colour schemes), wires `npm run contrast` as a gate, and
   preserves LINA-80's party-vs-state split (`--owner`/`--builder` = who is
   speaking; `--plan-*` = state of a commitment). The branch is **40 commits
   behind `main` and unmerged** — so the divergence persists on `main` purely
   because LINA-92 never shipped.

This is therefore a **landing problem, not a design decision.** "Revert
onboarding to `:root`" would mean reverting `main`'s own token source of truth
back to the retired LINA-27 hexes — nonsensical.

## Decision

**1. `:root` migrates to the pen palette. It does not revert.**

The portal adopts the generated token pipeline that already governs the source
of truth and the landing site:

- `globals.css :root` stops hand-mirroring hexes and consumes
  `app/src/app/tokens.css`, generated from `design-system/tokens.json` by
  `npm run tokens` and gated by `npm run contrast`. This is the mechanism that
  keeps the portal from drifting a re-base behind again — the failure mode that
  created this split.
- `--owner`/`--builder` stay **party** names and `--plan-*` stay **commitment
  state** names, per **LINA-80 / ADR-lineage** and as implemented on the LINA-92
  branch. Migrating `:root` is *not* an alias or a rename of those families; it
  is finishing the LINA-86 re-base in the portal, the one surface that never
  caught up.

**2. The migration is not a hand-edit of `:root` hexes.** It goes through
`tokens.json → build-tokens.mjs → tokens.css`, with the contrast gate in CI. A
hand-patched `:root` is explicitly rejected — it reintroduces exactly the drift
this ADR closes.

**3. Whoever lands it deletes both scoped blocks** (`.ob`, `.onb`) and re-points
the onboarding setup and empty-portal surfaces at the migrated tokens, and
confirms Inter loads globally (via the portal layout) so EmptyPortal's local
`next/font` scoping can be removed.

## Sequence

Land order, chosen to keep a thin near-done slice unblocked and do the cleanup
in a single pass:

1. **LINA-133 (PR #48) merges as-is, keeping its scoped `.onb` block.** It is a
   thin, near-complete slice; do not block it on the migration. (LINA-132's `.ob`
   is already on `main` under the same convention. Scoped blocks are inert on the
   record surfaces, so carrying them for one more merge is harmless.)
2. **Re-cut the migration fresh from current `main`** — do **not** rebase the
   40-commit-stale `lina-92` branch; its `tokens.json` is behind `main`'s.
   `main`'s `tokens.json` is the source of truth. Regenerate
   `app/src/app/tokens.css` from it (`npm run tokens`), rewrite `globals.css :root`
   to `@import` it, port the LINA-92 `layout.tsx` change that loads Inter globally.
3. **In that same change, delete both scoped blocks** and re-point setup +
   empty-portal at the migrated tokens.
4. **`npm run contrast` is the AA gate** and runs in CI on that change.

## Contrast / AA — already resolved by the pipeline

LINA-155 flags `#B4633B` as not a drop-in for `#EB6834`. The `tokens.json`
contrast audit already measured this and shipped the fix:

- `--builder`/`--plan-actual` `#b4633b` fails AA as small text (4.20:1 on paper,
  4.39:1 white-on-fill). The audit introduces `--builder-fg` / `--plan-actual-fg`
  `#8a4522` (6.81:1 / 7.11:1 PASS) for type and filled controls — the same intent
  as LINA-133's `#8A4423` darkened ink. `#b4633b` is retained only as a
  **fill / non-text** tone (bar/edge, ≥3.0:1).
- The four pillars and every RAG state (`success #2f7d5b`, `warning #8a6a2b`,
  `danger #9b3b2f`) are audited PASS as both text on paper and as the 4px pillar
  edge, in **both** schemes. FR9 (colour never the only signal — label + icon)
  is unchanged.

No new colour decisions are required at land time; the gate enforces the above.

## Owner

- **Implementation owner:** Frontend Developer (raised LINA-155; owns the
  onboarding surfaces and the portal CSS). Tracked as the LINA-155 implementation
  follow-up, **blocked on PR #48 merging.**
- **Review + merge:** Full-Stack Architect.

## Consequences

- **Positive:** one palette in the portal; the drift class that caused this split
  is closed by the generated pipeline + CI contrast gate; onboarding and record
  surfaces finally share tokens; LINA-80's party/state separation is preserved.
- **Negative / debt:** the divergence persists on `main` for one more merge
  (LINA-133 lands with `.onb`). Bounded by filing the migration follow-up now,
  blocked on #48, rather than leaving it floating. The stale `lina-92` branch is
  retired in favour of a fresh cut — its design work (tokens.css shape, contrast
  audit) is reused, not its diff.
- **Revisit when:** a token is added to `tokens.json` — regenerate, never
  hand-add to `globals.css`.
