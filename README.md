# LinkNMS

LinkNMS is a collaboration platform for building a house.

It connects the homeowner with every party doing or managing the work —
general contractor, specialty subcontractors, site manager, architect,
inspectors — around one shared record of what was agreed, what changed,
and what it cost.

Its reason to exist is the moment a build goes sideways: *"who decided
this, when, and how much did it move the budget?"* LinkNMS turns that from
an argument into a lookup.

## The problem

On a house build, deadlines, decisions and budget change constantly, and
the record of those changes lives in people's memory, in WhatsApp threads,
and in whatever the contractor wrote down. When the owner and the builder
disagree months later, there is no shared source of truth to appeal to —
only two versions of the same conversation.

The problem gets harder, not easier, when the house is built specialty by
specialty. The owner then coordinates several independent parties who
don't know each other, have no shared history, and where no single party
is accountable for how the pieces interlock.

## What LinkNMS is

Three things that only work because they work together:

1. **Time** — every trade's schedule, with the dependencies between them,
   rolled up into one master timeline both sides can see.
2. **Money** — budget by line item, planned versus actual, per contract
   and rolled up, so "are we still on budget" has an answer.
3. **Scope and history** — what each party agreed to do, and a record of
   every change: who, when, and the value before and after. Supporting files,
   including BIM models, attach here — uploaded, previewed where the format
   allows, and tied to the change they document.

Sold as SaaS. The account is bought by one party — either the homeowner or
the contractor — but paying for it never means owning the record against the
other. The platform is the neutral ground every party on the build works from.

## Who it is for

- **Homeowners** running a build they cannot personally supervise
  full-time, who fear being told after the fact that scope, timeline or
  price changed.
- **Builders, contractors and site managers** who want a defensible record
  as much as the owner does — proof that a change was requested and
  approved, not invented later.

Both are non-technical. Neither wants a heavyweight enterprise
construction suite; they want a clear shared ledger for one build.

Eleven roles are documented in detail — see
[`cowork/documentation/personas.md`](./cowork/documentation/personas.md).

## Two operating models

Real houses get built one of two ways, and LinkNMS is designed for both:

- **Turnkey.** The owner signs with one contractor, who subcontracts and
  coordinates every specialty underneath their own contract.
- **Direct-to-specialty.** The owner contracts each specialty separately —
  mason, electrician, plumber, carpenter, roofer, tiler, painter — with no
  general contractor in between. The owner *is* the coordinator, whether
  they intended to take on that job or not.

Hybrids are, in practice, the most common of all. The concept that lets
one product serve all three is the **Trade Contract** — a scoped agreement
for one specialty, with its own responsible party, scope, budget and
timeline, rolling up into one master project view. See
[`03-operating-models.md`](./cowork/documentation/03-operating-models.md).

## What LinkNMS is not

- **Not tamper-*proof*.** The change history is tamper-*evident*: it
  reveals after-the-fact edits, it does not prevent them. These are
  different properties and LinkNMS never blurs them.
- **Not a BIM authoring or analysis suite.** LinkNMS accepts BIM file
  uploads and previews them where the format allows, attaching each model to
  the shared record. It does not author or edit models, run clash detection,
  or replace tools like Revit or ArchiCAD — the model is evidence on the
  record, not the workspace it was made in. BIM only becomes mandatory in
  Portugal on 1 January 2030 (PortugalBIM Strategy, RCM 89/2026), with a
  pilot starting in 2027.
- **Not a municipal-permitting integration.** LinkNMS stores links and marks
  permitting phases; it does not talk to city systems that do not yet expose
  an API.
- **Not an enterprise ERP.** A builder runs several builds at once, so
  LinkNMS is multi-build by design — switch between builds and see them all
  in one portfolio view. What it is *not* is the company's back office: no
  accounting, payroll, procurement, or CRM. It is the shared record for the
  work, not the system that runs the firm.

## Current state

Product definition. This repository documents what LinkNMS is, who it
serves, and what it must eventually do. It contains no implementation and
no build plan — that is deliberate at this stage: the shape of the product
gets settled before anything is built against it.

## Repository layout

```
cowork/          Planner — the product definition (documentation, design notes, .pen canvas)
brand-book/      Storybook brand book — the live identity site (deployed on Vercel)
design-system/   Design tokens + logo asset pipeline (the single source for colour/type/icons)
BRAND.md         Verbal & strategic identity (meaning, voice, governance)
```

New projects/services get their own top-level folder alongside these.

## Documentation

[`cowork/documentation/00-index.md`](./cowork/documentation/00-index.md)
— what the product is, who it serves, and the full functional scope.
