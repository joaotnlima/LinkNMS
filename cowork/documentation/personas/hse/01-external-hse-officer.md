---
role: HSE Officer / Health & Safety
variant: The external HSE technician, hired by legal obligation
status: unvalidated hypothesis
---

# The external HSE technician, hired by legal obligation

## Who they are

Occasional presence, typically on builds above the thresholds that require
a Health & Safety Plan and safety coordinator (Portuguese Health & Safety
on Construction Sites Decree-Law 273/2003). Focused on documentary
compliance as much as on physical inspection.

## Motivations

Meet and demonstrate legal compliance — the written record matters as much
as the actual correction, because it's what protects all parties in the
event of an inspection or incident.

## Pain points

- Safety documentation scattered across paper and different apps, hard to
  present coherently if requested.

## Behaviors

- Scheduled visits, formal reports, strong emphasis on dated photographic
  evidence.

## Where this differs from other variants of the same role

Unlike the [informal safety lead](./02-informal-safety-lead.md), this
variant has an explicit legal obligation behind what they record — it's
not best practice, it's a requirement.

## Implications for features

- **In favor of**: exporting safety reports separately from quality reports
  (same data structure as Quality Inspection, different `type` field),
  because they may need to be presented separately to an inspecting
  authority.
