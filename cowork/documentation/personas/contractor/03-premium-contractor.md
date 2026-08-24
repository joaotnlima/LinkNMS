---
role: Contractor / General Contractor
variant: The premium contractor / architect-designed build
status: unvalidated hypothesis
---

# The premium contractor / architect-designed build

## Who they are

Builds high-end homes, often architect-authored designs, with a present
and demanding client. Works side by side with the
[architect](../architect/) throughout the entire build, not just during
the design phase. Price isn't the main competitive variable — finish
quality and fidelity to the design are.

## Motivations

To deliver exactly what was designed, with a client who will notice
details other clients wouldn't. The relationship with the architect is as
important as the relationship with the client.

## Pain points

- Frequent specification changes (the client wants a better finish
  midway through the build) that need to be clearly recorded — whose
  decision it was, when, and what the budget impact is.
- Coordinating approvals between client and architect at the same time —
  sometimes they disagree with each other, and the contractor is caught
  in the middle.
- Reference documentation (drawings, material samples, specifications)
  scattered across email and meetings, hard to maintain as a single
  source of truth.

## Behaviors

- Regular, formal site meetings, often with the architect present.
- Invests time in documenting things well — not averse to forms, unlike
  the [traditional master builder](./01-traditional-master-builder.md).
- Sensitive to how communication with the client is presented —
  professional image matters at this tier.

## Where this differs from other variants of the same role

Unlike all other variants, specification changes (not just budget
changes) are the center of the client relationship, not an occasional
exception. And unlike the
[traditional master builder](./01-traditional-master-builder.md), this
variant wants *more* structure in the tool, not less.

## Implications for features

- **In favor of**: `ChangeOrder` (roadmap Tier 1) explicitly linked to
  specification changes, not just value changes — "the client requested
  a different range of taps, +€800, approved by X and Y [architect]" is
  this variant's central use case, not an extra.
- **In favor of**: presentation quality of documents/photos shared with
  the client — this variant cares about image as much as function.
- **In favor of**: two-voice approval (client + architect) on a single
  `ChangeOrder` — connects to the open question already recorded in
  [personas.md](../../personas.md) about multiple approvers.
