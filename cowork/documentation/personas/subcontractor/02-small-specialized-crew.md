---
role: Subcontractor
variant: The small specialized crew
status: unvalidated hypothesis
---

# The Small Specialized Crew

## Who they are

3-5 people from one trade (e.g. a masonry crew, a plumbing crew), with a
crew leader who bridges to the main [contractor](../contractor/). The
crew leader is the one who would likely use the app, not each individual
worker.

## Motivations

Coordinating well with other crews so there's no dead time (e.g. not
being able to move forward because the previous crew hasn't left yet).

## Pain points

- Poorly communicated dependencies between different crews' tasks cause
  the loss of entire days.

## Behaviors

- The crew leader reports on behalf of everyone; the rest of the crew
  likely never touches the app directly.

## Where this differs from other variants of the same role

Unlike the [independent tradesperson](./01-independent-tradesperson.md),
this variant genuinely cares about dependencies between tasks — not just
"what I have to do," but "when does the previous crew free up the space
for me to come in."

## Implications for features

- **In favor of**: clear visibility of dependencies in the Gantt chart for
  whoever is assigned to the next task, not just for whoever manages the
  project — a direct link to the UI gap already identified in
  [05-functional-scope.md](../../05-functional-scope.md) (dependencies
  today only appear in a tooltip, not visually in the Gantt chart).
