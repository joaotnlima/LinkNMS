# Boundaries

What LinkNMS is not, and why. This is the canonical version — the short
lists in [`README.md`](../../README.md) and [`BRAND.md`](../../BRAND.md)
are summaries of it.

Stating these is not modesty. Every one of them is a decision that keeps
the product from drifting into something it cannot be good at, and each
has a specific failure it is avoiding.

## Not tamper-proof

The change history is **tamper-evident**: it reveals that a record was
altered after the fact. It does not prevent alteration, and it is not a
security perimeter or legal proof.

The word "tamper-proof" is never used about LinkNMS. This is a brand
guardrail, but the reason is not tone — it is that a claim of certainty
about the real world cannot survive contact with the first person who
tests it. The weak link is never the record; it is the people using it,
and saying so is what makes the rest credible.

## Not a BIM authoring or analysis suite

LinkNMS accepts BIM file uploads and previews them where the format
allows, attaching each model to the shared record as evidence. It does
not author or edit models, run clash detection, or replace Revit or
ArchiCAD. The model is evidence on the record, not the workspace it was
made in.

Context: BIM becomes mandatory in Portugal on 1 January 2030 (PortugalBIM
Strategy, RCM 89/2026), with a pilot starting in 2027.

## Not a municipal-permitting integration

LinkNMS stores links and marks permitting phases. It does not talk to
city systems.

There is nothing real to build against: no unified municipal API exists,
and every câmara has its own system. A "council-ready" integration with
nothing to integrate with would be an empty feature — the contractor
tries it, discovers it does nothing, and trust is lost faster than not
having the feature would have cost.

What LinkNMS does instead is honest, low-cost preparation: tasks can be
tagged with the RJUE phase they belong to (comunicação prévia, licença,
alvará, vistoria, autorização de utilização), so the record tracks where
the project stands without pretending to talk to systems that do not yet
expose an interface.

## Not an enterprise ERP

LinkNMS is multi-build by design: a contractor runs several builds at once,
switches between them, and gets one portfolio view across all of them. That
is a requirement, not a someday — a builder who can only see one build at a
time won't adopt it. What stays out of scope is the company's back office:
payroll, procurement, accounting and CRM are not LinkNMS's job.

The line against enterprise construction suites still holds, but on a
different axis: their barrier is the breadth of back-office modules, not the
fact of spanning several builds. LinkNMS spans a builder's builds while
staying narrow and legible on each one — it manages the record for the work,
never the system that runs the firm.

## Not a policing tool

Not a boundary in the feature sense, but the one most easily crossed by
accident, and the most expensive if it is.

LinkNMS is not designed against a dishonest counterparty. Designing for
fraud produces a surveillance instrument, and the side being watched
refuses to use it — which destroys the only property that gives the
record any value at all: that both parties were in it while it was being
written. See [02-problem.md](./02-problem.md).

Practically, this means no feature, no view and no piece of copy may
serve one side against the other. If a capability is useful only to the
owner as leverage, or only to the builder as cover, it does not belong
here.
