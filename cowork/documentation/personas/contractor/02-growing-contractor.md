---
role: Contractor / General Contractor
variant: The growing contractor
status: unvalidated hypothesis
---

# The growing contractor

## Who they are

Small company (10-30 people), several builds simultaneously, several of
their own crews plus subcontractors. Has already outgrown Excel and the
per-build WhatsApp group — is feeling the pain of scaling without
processes, and knows it. Delegates the day-to-day management of each
build to a [foreman](../site-manager/) and focuses on managing the
business: margin, capacity, which builds to accept next.

## Motivations

Professionalize the operation without losing the agility that made them
grow. Protect margin across several builds at once, not just one.

## Pain points

- Lack of aggregated view — to know how the 4 ongoing builds are doing,
  they have to ask 4 foremen separately.
- Tools designed for "one build" force them to duplicate accounts or leave
  the tool to see the overall picture.
- Subcontractors shared between builds (the same electrical crew in two
  houses at the same time) are hard to coordinate without cross
  visibility.

## Behaviors

- Uses a computer for management, mobile phone for occasional
  follow-up.
- Requests reports regularly — weekly or biweekly — for business
  decisions, not just operational ones.
- Delegates day-to-day data entry; they consume reports, they don't fill
  out forms.

## Where this differs from other variants of the same role

Unlike the
[traditional master builder](./01-traditional-master-builder.md), a
single project isn't enough — they need visibility across projects.
Unlike the
[volume production contractor](./04-volume-production-contractor.md), the
builds they manage are still all different from each other (it's not
serial construction), so they don't benefit as much from replicable
templates — they benefit more from aggregation and comparison.

## Implications for features

- **In favor of**: a dashboard that spans projects (today LinkNMS is
  designed for one project at a time — see the README, "prototype for
  one build"). This variant is the first concrete sign that "one
  project at a time" has a short shelf life if the target market
  includes companies, not just individual owners.
- **In favor of**: export/reports (already identified as a gap in the
  roadmap), because that's how they effectively consume information.
- **Against, for now**: it's not worth building multi-project before
  confirming that this variant is a real slice of the market being
  targeted — it can be a deliberate step 2, not a day-1 requirement.
