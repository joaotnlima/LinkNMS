# Value

What LinkNMS is *for*, and — separately, because they are not the same
thing — what each party on the build actually gets from it.

The operating-model distinction that shapes all of this is in
[03-operating-models.md](./03-operating-models.md); the roles referenced
below are defined in [personas.md](./personas.md).

## The value proposition

**LinkNMS digitizes the operation of building a house** — every specialty
contract, from groundwork to the final inspection — so that time, money
and scope stay visible to whoever needs them, instead of depending on
memory, goodwill, or a phone call to whoever happens to remember what was
agreed.

The change history is what makes this trustworthy, but it is not the
whole pitch. It is the backbone underneath a broader promise: **plan and
run the operation of the build**, across every party involved — not
merely keep a tidy record of disputes after they happen.

That distinction has a commercial consequence. A product sold purely on
disputes is insurance against an event most people believe will not
happen to them. A product that is useful on an ordinary Tuesday is used
on ordinary Tuesdays, and is therefore complete when the argument
arrives.

## What each party gets

Not a generic dashboard — a specific slice. One row per role.

| Persona | Primary value | Time | Money | Scope |
|---|---|---|---|---|
| Owner | Confidence the build is on track without needing construction expertise themselves | Master timeline rolled up across every Trade Contract, milestone alerts | Total budget vs. actual across all contracts; cash-flow view of what is due and when across independent payment schedules | What is covered by each contract, with gaps between them surfaced rather than hidden |
| Client's Representative | The Owner's value, delegated | As Owner | As Owner, or a subset where delegation is partial | As Owner |
| Contractor / General Contractor | Coordinate several trades under one commitment, protect margin | Master timeline with the cross-trade dependencies they own | Their own contract value vs. cost incurred, change-order value | Scope boundaries between the trades under their contract, to pre-empt "whose job is this" |
| Site Manager / Foreman | Keep execution moving day to day | Daily and weekly task list by crew, across whichever trades are on site | Typically none | Task-level scope: what is ready to start, gated by dependency completion |
| Subcontractor | Get paid for exactly what was agreed; no scope creep | Their own trade's timeline, plus the dependency trigger that says when they can start | Their own contract value, payment tied to verified milestones rather than self-reported completion | Precise definition of what is in and out of their contract |
| Supplier | Deliver on time without expediting drama | Delivery date, lead-time visibility | Purchase order value | Exactly what was ordered — spec and quantity |
| Architect / Designer | Design intent preserved through execution | Which trade is in which phase, to know when to inspect or approve | Fee milestones, where applicable | Any scope change that affects design routes through them |
| Quality Inspection | Verify each trade before the next one depends on it | Notified the moment a trade marks work complete, before the next trade may start | None | Explicit written acceptance criteria per task — not a verbal "looks fine" |
| HSE Officer | Understand what is happening on site right now, across every crew present | Which trades are on site simultaneously | None | Hazardous-work scope per trade, and where two trades' hazardous work overlaps |
| Licensing Authority | No login — milestone and phase evidence relevant to an inspection | Inspection-relevant milestones | None | Only the scope relevant to compliance |
| Neighbour / Condominium | No login — notice of disruptive work windows | Noise, access and common-area impact windows | None | None |

## Two rows worth a second look

**HSE.** In the turnkey model this is a nice-to-have on a big enough
site. In the direct-to-specialty model it becomes the one role positioned
to see a cross-trade coordination risk that no individual Trade Contract
can see on its own. The value changes with the model, not just the data.

**Owner.** The owner picks up a cash-flow planning need that simply does
not exist in the turnkey model, where the general contractor absorbs that
complexity internally. This is the clearest case of the direct model
handing the owner a job they did not ask for.

## What this document deliberately does not do

It maps value; it does not rank it.
[05-functional-scope.md](./05-functional-scope.md) lays out the full
product without MVP-gating or tiering it. Priority order is a decision to
make once the whole shape is visible — and after the problem is
validated, not before.
