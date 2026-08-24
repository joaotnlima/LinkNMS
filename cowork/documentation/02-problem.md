# The problem

This document states the one problem LinkNMS exists to solve, precisely
enough that it can be proven wrong. Everything else in this folder
describes what the product *is*; this describes why it should exist at
all — and what evidence would show it shouldn't.

## In one sentence

**On a private house build, the decisions that move deadline, scope and
price are made verbally, on site, over many months — and neither party
ends up holding a record the other accepts.**

## The moment it happens

Month seven. A wall is not where the owner remembers agreeing it would
be. The invoice carries a line the owner does not recognise. Both parties
are describing the same conversation from memory, and both are being
honest.

Nobody is lying. That is the point, and it is why "protect yourself from
a dishonest builder" is the wrong framing: the common case is two honest
people with two incompatible recollections and no third thing to appeal
to.

## Two costs, not one

The dispute is the visible cost. It is also the rare one — most builds
end with grumbling, not litigation. If the product is sold on disputes
alone, it is insurance against an event most people believe won't happen
to them, and insurance is a hard sell to optimists.

The cost that is actually paid, every week, is different on each side:

**Owner.** Spending a large sum on something they cannot supervise
full-time, they buy information by interruption — calls, messages, site
visits — and still cannot answer "are we on time and on budget" without
asking someone who benefits from the answer.

**Builder.** Every one of those calls stops work. Every change agreed in
passing has to be reconstructed from memory when it reaches the invoice,
and defended without evidence. The builder does not want to be watched;
they want to stop being interrupted, and to stop having to argue for money
they believe they are owed.

These are the same underlying gap seen from two sides. It is the reason
one product can address both, and the reason the pitch must never be
framed as one side's tool against the other.

## What people do today, and why it is not enough

| Today | Why it fails |
|---|---|
| WhatsApp | Everything is recorded and nothing is findable. There is no state — only a stream. Nobody can answer "what is the current agreed scope" by scrolling. |
| Spreadsheet held by one party | It is one party's version. The other has no reason to accept it, and usually never sees it. |
| The site manager's notebook | Not shared, not searchable, and it belongs to one side. |
| Nothing | The most common option, and it works right up until it doesn't. |

The bar is not "better than nothing." The bar is **better than WhatsApp
plus goodwill**, for people who are not looking for software.

## What is explicitly NOT the problem

Stating these keeps the product from drifting:

- **Not a planning problem.** Making the plan is not hard. The plan
  changing forty times, with no agreed record of the current state, is.
- **Not a lack of construction software.** It exists. It is built for
  companies running many projects, not for two parties on one house.
- **Not fraud.** Designing against a dishonest counterparty produces a
  policing tool that the other side will refuse to use — which destroys
  the only thing that makes the record worth anything: that both sides
  are in it. This is a product boundary as much as a framing choice —
  see [06-boundaries.md](./06-boundaries.md).
- **Not proof.** The record can reveal that it was altered after the
  fact. It cannot prevent alteration, and it is not evidence in the legal
  sense. Claiming otherwise would be the fastest way to lose the trust the
  whole product depends on.

## The hypothesis, stated so it can fail

> Owners and builders on private house builds experience recurring,
> quantifiable cost from the absence of a shared record of agreed
> changes — and enough of them will adopt a shared record that both sides
> can see, even though adopting it requires daily effort from the side
> that benefits least on any given day.

The second clause is the fragile one. A shared record has a structural
adoption problem: the cost is paid daily, in small increments, by the
builder; the benefit lands rarely, in large increments, mostly when
something goes wrong. Any evidence gathered has to test that clause, not
just the first one. Confirming that the pain exists proves nothing —
almost every pain exists.

## What would prove this wrong

Twelve conversations: six builders, six owners who have finished or are
mid-build. Decided in advance, so the result cannot be argued away
afterwards:

| Signal | Kill criterion |
|---|---|
| **Frequency** | Fewer than 7 of 12 describe a specific episode in the last 12 months, unprompted, where a verbally-agreed change caused a dispute over invoice or schedule → the problem is not frequent enough to build on. |
| **Cost** | Fewer than half can put a number on it — euros or days lost → it is an irritation, not a cost. Irritations do not get paid for. |
| **Alternative** | 8 or more say some version of "that's what WhatsApp and knowing your builder is for" → the incumbent is good enough. |
| **Adoption** | Fewer than 3 of the 6 builders will agree to try it on a live build, or to hand over the change history of a past one → they like the idea and will not do the work. This is the criterion most likely to fail, and the most important one. |
| **Sides** | If builders consistently read it as the owner's surveillance tool, the neutral positioning does not survive contact and the product needs rethinking before it needs building. |

Any two of these failing is a stop, not a pivot signal to be interpreted
generously later.

## Status

The questions this document leaves open — who pays, and whether the side
carrying the daily cost will do the work — are tracked in
[07-open-questions.md](./07-open-questions.md).

Unvalidated. Everything above is reasoning, not evidence. It was written
before the first conversation, deliberately, so that the conversations
can contradict it.
