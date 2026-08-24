# Open questions

What is genuinely undecided, and what would decide it. Nothing here is a
task list — these are the questions that, left unanswered, make the rest
of the documentation less certain than it reads.

Ordered by how much damage the wrong answer does.

## 1. Who pays, and does the other side still show up?

The account is bought by one party. Neutrality is a functional
requirement, not a nicety — the record only settles anything if both
sides were in it while it was written.

Unresolved: if the owner buys, does the builder participate in a tool the
owner is paying for? If the builder buys, does the owner ever see it?

**What decides it:** field evidence. This is the third question in the
validation interviews — *"who should be paying for this?"* — and the
answer most likely to be "the other one," from both sides.

## 2. Will the side that pays the daily cost actually keep the record?

The cost of maintaining the record is paid daily, in small increments,
mostly by the builder. The benefit lands rarely, in large increments,
mostly on the owner.

This is the fragile clause of the hypothesis in
[02-problem.md](./02-problem.md), and confirming that the pain exists
proves nothing about it.

**What decides it:** whether builders will try it on a live build, not
whether they like the idea. The adoption kill criterion exists for this
question specifically.

## 3. Is scope-gap detection a feature or a research project?

[05-functional-scope.md](./05-functional-scope.md) lists scope-gap
detection alongside a shared site calendar as though they cost the same.
They do not. Detecting work implied by the plans that no contract claims
requires understanding the plans.

Unresolved: whether the useful version is automatic detection, or a
structured checklist of the twenty or thirty boundaries that actually
cause disputes on a house build — window seals, penetrations, final
connections, cleanup.

**What decides it:** asking builders and owners which gaps actually bit
them. A list of real ones beats a general-purpose detector nobody can
build.

## 4. Two people with owner-level approval

The Client's Representative is not a separate role — it is a second
person holding the owner's access on the same build: a couple, or an
owner plus a hired project manager.

Unresolved, and it is a business question rather than a product mechanic:
when two people hold owner-level approval, does a change order need both
of them, or either one?

## 5. Are eleven roles the right number for this market?

The persona set includes independent quality inspection, an HSE officer
and a safety coordinator. Portuguese law makes the safety side mandatory
above certain thresholds (Decreto-Lei 273/2003), so it is not invented —
but a single-family house with a full independent inspection regime is
not the median build either.

Unresolved: whether the median target build has these roles at all, or
whether half the persona set describes larger projects than the ones
being sold to.

**What decides it:** the twelve validation conversations. Note which
roles the interviewees actually had on their build.

## 6. Which persona variants are real

The variants in [personas/](./personas/00-methodology.md) — four kinds of
contractor, three kinds of owner, two kinds of inspection — are
hypotheses written from sector knowledge, and they say so themselves.
They are useful for mediating feature decisions and worthless as
evidence.

**What decides it:** recording, against each variant, which real
conversation confirmed or contradicted it. Until at least one does, treat
every variant as a question.

## 7. The Supplier persona depends on a capability that does not exist

The Supplier only takes shape once purchase orders are part of the
product. Naming the persona now is fine; designing their access before
purchase orders exist is not.

## 8. The name

"LinkNMS" means nothing to a homeowner or a builder, and reads as network
management software to anyone in IT. The name has already changed twice.

Not urgent — a name is cheap to change before there are users, and
expensive to keep debating instead of validating. Recorded here so it is
not mistaken for a settled decision.
