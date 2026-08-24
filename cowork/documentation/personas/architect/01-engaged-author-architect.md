---
role: Architect / Designer
variant: The author architect, continuously engaged
status: unvalidated hypothesis
---

# The Author Architect, Continuously Engaged

## Who they are

Author of the project, present throughout the build, typically tied to
the [premium contractor](../contractor/03-premium-contractor.md) — an
author-driven build where fidelity to the design matters as much as the
timeline.

## Motivations

That the build matches the project, and being consulted before any
deviation, not informed after the fact.

## Pain points

- Discovering a specification change that's already been executed,
  without having been consulted beforehand.

## Behaviors

- Regular visits, active review of progress and documents.

## Where this differs from other variants of the same role

Unlike the
[permitting-only architect](./02-permitting-only-architect.md), he wants
to be consulted before decisions, not just informed after they've been
made.

## Implications for features

- **In favor of**: `ChangeOrder`s that involve a design change need to be
  proposable *before* execution, with the architect as a required
  approver, not just notified — this links directly to the
  [premium contractor](../contractor/03-premium-contractor.md) persona.
