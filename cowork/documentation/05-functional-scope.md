# Functional scope

Everything the product must eventually do, organized by function rather
than by build priority. This is the full shape, not an MVP, and nothing
here is gated or tiered — priority is a decision to make once the whole
shape is visible, and after the problem is validated.

Why each area matters, and to whom, is in [04-value.md](./04-value.md).
The Trade Contract concept these features assume is defined in
[03-operating-models.md](./03-operating-models.md). What is deliberately
absent is in [06-boundaries.md](./06-boundaries.md).

## 1. Project and Trade Contract structure

- **Flexible cardinality.** A project contains as many Trade Contracts as
  the owner actually signed — one, or one per specialty, or anything
  between. The product never asks which operating model this build is.
- **Responsible-party flexibility.** A Trade Contract's responsible party
  can be a general contractor holding several of them, or a specialty
  subcontractor engaged directly by the owner.
- **Master roll-up view.** Time, money and scope aggregate from every
  Trade Contract into one project-level view for the owner.
- **Scope-gap detection.** Every scope item across every active Trade
  Contract is checked against one question: is there any piece of
  physical work implied by the plans that no contract explicitly claims?
  Flag it before it becomes a dispute, not after. This is the most direct
  answer to houses being built specialty by specialty — and the most
  technically ambitious item in this document, since it implies reading
  intent from plans. See [07-open-questions.md](./07-open-questions.md).

## 2. Time and scheduling

- **Master timeline** aggregating every Trade Contract's schedule into
  one project view, with cross-trade dependencies (electrical rough-in
  depends on framing completion; drywall depends on electrical and
  plumbing rough-in both being signed off).
- **Per-trade timeline**, fully visible to that trade's responsible
  party, in summary to the owner, and to adjacent trades whose start
  depends on it.
- **Dependency-gated start.** A task cannot move to "in progress" until
  its upstream dependency is not merely marked done but verified. This
  closes the gap that causes the *"I started assuming it was ready"*
  dispute.
- **Licensing-phase milestones**, so the timeline reflects the regulatory
  process (comunicação prévia, licença, alvará, vistoria, autorização de
  utilização) alongside the physical one.
- **Site-presence calendar**: which trades are scheduled on site on any
  given day. Feeds both the neighbour notices below and the HSE
  coordination features in section 5.
- **Disruptive-work notices**: an owner-controlled way to generate a
  notice (noise, blocked access, common-area impact) for neighbours or a
  condominium association, sourced from the site-presence calendar rather
  than typed up each time.

## 3. Money and budget

- **Per-trade budget**, planned vs. actual, rolling up to one master
  project budget. A change in one contract's cost does not require
  touching another's numbers.
- **Trade-scoped change orders.** A change to the electrical scope
  changes the electrician's contract value; it does not silently inflate
  a project-wide number with no clear owner of the increase.
- **Payment milestones tied to verified completion**, not to
  self-reported completion. A milestone unlocks when the relevant task
  passes inspection sign-off — the money-side counterpart of
  dependency-gated scheduling.
- **Cross-contract cash-flow view** for the owner: what is due, to whom,
  and when, across every independent payment schedule at once.
- **Cost-to-completion and variance reporting**, per trade and rolled up,
  so *"are we still on budget"* has an answer that does not require
  adding up six contracts by hand.

## 4. Scope and specification

- **Explicit scope documents per Trade Contract**, with inclusions stated
  affirmatively rather than inferred from the absence of an exclusion.
  The direct cause of *"I thought that was included"* is an implicit
  scope, not a missing change-order process.
- **Change order workflow**, scoped to the Trade Contract it affects.
- **Acceptance criteria per task or milestone**, written before work
  starts and checked at completion — replacing a verbal "looks fine" with
  something that can be pointed back to.
- **Scoped document and drawing attachment.** A subcontractor sees the
  pages relevant to their trade, not the entire plan set. This is a
  usability requirement, not a permissions nicety: the traditional master
  builder works from a phone on site and will abandon a tool that makes
  them wade for what matters to them.

## 5. Cross-trade coordination

This area exists because of the direct-to-specialty and hybrid models;
none of it is needed when there is only one contractor to coordinate with
— see [03-operating-models.md](./03-operating-models.md).

- **Overlap detection**: flag when two Trade Contracts are scheduled on
  site simultaneously, so it is visible rather than discovered on
  arrival.
- **Shared site calendar**, visible to every active Trade Contract — the
  plumber sees that the electrician will also be there on Tuesday without
  the owner relaying it.
- **Unclaimed-scope routing**: when an issue or a piece of work belongs to
  no existing contract's scope, it is flagged and routed to the owner to
  assign, rather than silently becoming nobody's problem.

## 6. Trust and accountability

The backbone underneath the rest, not the entire pitch.

- **Change history** covering every entity above — Trade Contracts, scope
  items, cross-trade dependencies, payment-milestone verification — not
  just tasks and budget lines. It is tamper-*evident*, never
  tamper-*proof*; the distinction and its consequences are in
  [06-boundaries.md](./06-boundaries.md).
- **Per-trade history visibility.** Each subcontractor sees their own
  contract's full history; the owner sees everything across every
  contract.
- **Verification gates**, the mechanism that makes the record matter
  operationally rather than archivally: a record advances a dependency or
  unlocks a payment only once the right party has verified it, not merely
  logged it.

## 7. Persona-specific views

Each role gets the slice of time, money and scope relevant to them (see
[04-value.md](./04-value.md)), not one dashboard trying to serve
everyone.

- **Owner**: master timeline, master budget with cash-flow projection,
  scope-gap flags, across all Trade Contracts.
- **Trade Contract holder** (subcontractor or general contractor): their
  own contract only — timeline, budget, scope, payment milestones.
- **Site Manager**: cross-trade daily and weekly execution, task-level
  detail, no budget.
- **Quality Inspection and HSE**: a queue of pending verifications and
  incidents across every active trade, filterable by type. The same
  mechanics with different criteria — see [personas.md](./personas.md).
- **Architect**: design-change and approval queue, tied to whichever
  Trade Contracts a change affects.

## 8. BIM as evidence

BIM is part of the record from the start, as evidence rather than as a
modelling tool. What LinkNMS refuses to do with it, and why, is in
[06-boundaries.md](./06-boundaries.md).

- **Upload, preview and submit the project's model.** The model can be
  brought in from day one — uploaded, previewed where the format allows,
  and submitted as the project's BIM record, attached to the shared
  history and stamped with who submitted it and when.
- **Trade Contracts map onto BIM disciplines.** Structural, electrical,
  plumbing, finishes — the same breakdown a model organizes itself
  around, which lines a submitted model up against the record for free.
- **Structured export as the near-term seam.** Exporting Trade Contracts,
  tasks and scope items costs little and is the honest half of
  "integrating or exporting, doesn't matter which."
- **Scope suggestion as a long-term direction.** Once a real municipal
  BIM seam exists, a submitted model could in principle generate Trade
  Contract scope suggestions. A direction, not a promise, and not
  something to build before there is a real system to build it against.
