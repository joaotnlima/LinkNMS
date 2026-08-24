---
role: Supplier
variant: The critical / custom-order supplier
status: unvalidated hypothesis — purchase-order feature doesn't exist yet (Tier 3 of the roadmap)
---

# The critical / custom-order supplier

## Who they are

Manufacturer or supplier of a specific product with a long production
timeline and no quick alternative (e.g. custom-made window frames,
specific technical elements). A delay here isn't a one-off inconvenience —
it delays everything downstream in the schedule.

## Motivations

Communicate timelines precisely and be notified early of changes that
affect the order (e.g. a change in measurements midway through the
process).

## Where this differs from other variants of the same role

Unlike the [big-box supplier](./01-big-box-supplier.md), this variant
justifies real timeline visibility — the cascading effect on the
`Task`/Gantt is direct and significant.

## Implications for features

- **In favor of**: if "Purchase orders" gets built, this variant is the
  case that justifies linking an order directly to a `Task` (with a
  visible dependency on the Gantt), not just a standalone purchase record
  — the [premium contractor](../contractor/03-premium-contractor.md) is
  the one who would miss this most, since that's where custom orders are
  most common.
