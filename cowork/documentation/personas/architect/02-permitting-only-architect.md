---
role: Architect / Designer
variant: The permitting-only architect
status: unvalidated hypothesis
---

# The Permitting-Only Architect

## Who they are

Produced the project for municipal approval, with no contract to follow
the build. Comes in occasionally, usually because he was called about a
compliance question against the approved project.

## Motivations

Resolving the specific issue he was called about, without getting
involved in the rest.

## Pain points

- Being contacted without context — he needs to quickly understand what
  has changed since he last saw the project.

## Behaviors

- Sporadic use, short sessions focused on one specific problem.

## Where this differs from other variants of the same role

Unlike the [engaged author architect](./01-engaged-author-architect.md),
he doesn't need or want to be consulted on every decision — only on
those that directly touch compliance with the approved project (linked
to `Task.licensingPhase`).

## Implications for features

- **In favor of**: read access focused on the permitting phases and
  relevant documents, with no obligation to follow everything — this is
  the case that best justifies a narrow-scope role rather than a generic
  `ADMIN`.
