# Overview

LinkNMS is a collaboration platform for building a house.

It connects the homeowner with every party doing or managing the work —
general contractor, specialty subcontractors, site manager, architect,
inspectors — around one shared record of what was agreed, what changed,
and what it cost.

Its reason to exist is the moment a build goes sideways: *"who decided
this, when, and how much did it move the budget?"* LinkNMS turns that
from an argument into a lookup.

## The three pieces

They only work because they work together. Any one of them alone already
exists in a spreadsheet.

**Time.** Every trade's schedule, with the dependencies between them,
rolled up into one master timeline both sides can see.

**Money.** Budget by line item, planned versus actual, per contract and
rolled up, so *"are we still on budget"* has an answer.

**Scope and history.** What each party agreed to do, and a record of
every change: who, when, and the value before and after. Supporting
files, including BIM models, attach here — uploaded, previewed where the
format allows, and tied to the change they document.

## Who it is for

**Homeowners** running a build they cannot personally supervise
full-time, who fear being told after the fact that scope, timeline or
price changed.

**Builders, contractors and site managers** who want a defensible record
as much as the owner does — proof that a change was requested and
approved, not invented later.

Both are non-technical. Neither wants a heavyweight enterprise
construction suite; they want a clear shared ledger for one build.

Eleven roles participate in a build, and they do not all need the same
thing — see [personas.md](./personas.md), and
[04-value.md](./04-value.md) for what each one actually needs to see and
control.

## The commercial shape

Sold as SaaS. The account is bought by one party — either the homeowner
or the contractor — but paying for it never means owning the record
against the other. The platform is the neutral ground every party on the
build works from.

Neutrality is not a marketing position here; it is a functional
requirement. A record only settles an argument if both sides were in it
while it was being written, and nobody stays in a record they believe is
the other side's instrument.

Who actually pays first, and whether the non-paying side will still
participate, is unresolved — see
[07-open-questions.md](./07-open-questions.md).

## What shapes the product most

Not the feature list. Two things:

**Houses get built in more than one shape.** Turnkey, direct-to-specialty
and hybrid are three different coordination problems, and the difference
runs through everything —
see [03-operating-models.md](./03-operating-models.md).

**The record has to be worth its own cost.** Keeping it is daily work,
paid mostly by the builder; the payoff is rare and lands mostly on the
owner. That asymmetry is the product's central risk, and it is stated
plainly in [02-problem.md](./02-problem.md).

## Where the edges are

LinkNMS is not tamper-proof, not a BIM authoring suite, not a permitting
integration, and not an ERP. Each of those refusals has a reason, and the
reasons matter more than the list —
see [06-boundaries.md](./06-boundaries.md).

## Current state

Product definition, unvalidated. The full scope is written down in
[05-functional-scope.md](./05-functional-scope.md); how it gets built is
not, and deliberately so — see the gates in
[00-index.md](./00-index.md).
