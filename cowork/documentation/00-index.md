# LinkNMS — product documentation

This folder is the product definition: what LinkNMS is, why it should
exist, who it serves, and what it must eventually do.

It contains no implementation, no architecture and no build plan. That is
not an oversight — see **Current state** below.

## The documents

Each one owns a subject. Where a subject is mentioned outside its own
document, it is a link, not a copy.

| | Document | Owns |
|---|---|---|
| 01 | [Overview](./01-overview.md) | What LinkNMS is, in one page. Start here. |
| 02 | [The problem](./02-problem.md) | Why it should exist — stated so it can be proven wrong, with the criteria that would kill it |
| 03 | [Operating models](./03-operating-models.md) | Turnkey, direct-to-specialty, hybrid — and the Trade Contract, the concept that serves all three |
| 04 | [Value](./04-value.md) | What each party gets, specifically: their slice of time, money and scope |
| 05 | [Functional scope](./05-functional-scope.md) | Everything the product must eventually do, organized by function, not by build order |
| 06 | [Boundaries](./06-boundaries.md) | What LinkNMS is not, and the reasoning behind each refusal |
| 07 | [Open questions](./07-open-questions.md) | What is undecided, and what would decide it |
| 08 | [Brand](./08-brand.md) | The elected logo ("House Record") and the brand-kit — which asset to use where |
| — | [Personas](./personas.md) | The eleven roles on a build and what each needs |
| — | [Persona variants](./personas/00-methodology.md) | Variants within each role — four kinds of contractor, three kinds of owner |

See also [`BRAND.md`](../../BRAND.md) at the repo root: positioning,
voice, visual identity, and the claims LinkNMS is allowed to make. The
applied logo and asset kit are documented in [08 — Brand](./08-brand.md),
with a browsable [brand-book](../design/brand-book/index.html).

## Reading order

**If you are deciding whether this is worth building** — 02, then 03.
Nothing else matters until the problem holds.

**If you are new to the product** — 01, then 03, then 04. Read 03 before
04: the operating-model distinction is what makes the value map make
sense, not the other way round.

**If you are looking for whether something is in scope** — 05 for what is
in, 06 for what is deliberately out, 07 for what has not been decided.

## Current state

**Unvalidated.** Everything in this folder is reasoning. No conversation
with an owner or a builder has informed any of it.

There are two gates, in order:

1. **Problem validation.** [02-problem.md](./02-problem.md) states the
   hypothesis and the evidence that would kill it. The criteria were
   fixed before the first conversation, deliberately, and are not
   renegotiable afterwards.
2. **Interest.** Evidence that people on both sides of a build want this
   enough to do the daily work it requires.

Implementation — architecture, data model, stack, build order — starts
after both, and not before. Documents describing how to build this were
written once and deleted for exactly that reason.
