---
role: Quality Inspection
variant: Informal inspection
status: unvalidated hypothesis
---

# Informal inspection

## Who they are

With no formally contracted inspection, it's the [owner](../owner/)
themselves, or their
[representative](../owner/03-couple-shared-decision.md), doing amateur
inspections — common on smaller builds where hiring an independent
inspector doesn't make financial sense.

## Motivations

The same as formal inspection (ensuring quality), but without the technical
training to back it up.

## Pain points

- Has no real authority to "block" anything — entirely dependent on the
  contractor's goodwill for a non-conformity to be taken seriously.

## Where this differs from other variants of the same role

Unlike the
[formal, independent inspector](./01-formal-independent-inspector.md), this
variant's power is social, not contractual — the tool cannot assume a
non-conformity recorded by them carries the same weight.

## Implications for features

- **In favor of**: the same non-conformity recording mechanism serves both
  variants — the difference is in who typically uses it, not in the data
  structure (reinforces the note already written in
  [personas.md](../../personas.md) about Quality Inspection and HSE sharing
  a model). Not worth building two separate flows because of this variant
  — just recognize that it exists, and is probably the more common case on
  small builds, not the exception.
