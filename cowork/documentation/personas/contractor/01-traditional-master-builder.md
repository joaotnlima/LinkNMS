---
role: Contractor / General Contractor
variant: The traditional master builder
status: unvalidated hypothesis
---

# The traditional master builder

## Who they are

Solo contractor or with a very small team (2-5 people), decades of
practical experience, reputation built by word-of-mouth, not marketing.
Prices by the job, not by detailed quantity surveying. Doesn't use
spreadsheets or management software — uses WhatsApp, paper, and memory.
Probably the most common contractor profile on a "turnkey" build of a
single-family home in Portugal, and the one the current version of
LinkNMS serves best by accident (it's the scenario closest to the
already-built "prototype for one build").

## Motivations

To finish the build well, maintain their reputation, avoid administrative
headaches. Their business is building, not managing systems.

## Pain points

- Verbal disputes about what was agreed — without a record, their word is
  worth as much as the client's, which is uncomfortable for both.
- Any tool that seems "for large companies" is felt as friction without
  obvious return.
- Low digital comfort — filling out long forms is real friction, not
  design perfectionism.

## Behaviors

- Mobile phone is the only realistic device for use on site; will never
  open a laptop at the construction site.
- Prefers to do something in 10 seconds over doing it well in 2 minutes.
- Trusts photos and dates more than written reports — visual proof
  convinces them (and convinces their client) more than text.

## Where this differs from other variants of the same role

Unlike the
[growing contractor](./02-growing-contractor.md), they have no interest
whatsoever in managing multiple projects simultaneously within the same
tool — they only have one build at a time, or at most two.
Unlike the
[premium contractor](./03-premium-contractor.md), they don't negotiate
specification changes frequently — the project is what it is, changes are
the exception, not the norm.

## Implications for features

- **In favor of**: interfaces with the minimum number of required fields
  possible; any flow that currently requires filling out a long form
  (e.g. creating a task with 8 fields) should have a "quick" version with
  2-3 fields and the rest optional/deferred. Photos as the main way of
  documenting progress, not text.
- **Against**: any feature that assumes multiple projects managed in
  parallel (aggregated dashboards, cross-project reports) — for this
  variant, it's dead weight in the interface, not value.
- **Concrete risk**: if the product becomes too "corporate" in how it
  asks for data, this is the contractor who simply goes back to WhatsApp
  and stops using the tool — and is probably the most common variant of
  the initial target market. Worth designing with them in mind first, not
  last.
