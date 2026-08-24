# Personas by role — methodology and how to use this

## What this is, and what it isn't yet

Each folder below corresponds to an **active role** (someone who uses the
application directly — this excludes Licensing Authority and
Neighbor/Condominium association, who have no login, see
[personas.md](../personas.md)). Within each folder, several files
represent **variants** of the same role — different people, with the same
type of technical access, but interests and priorities distinct enough to
pull the product in different directions.

**Honesty note**: real personas are "research-backed" — they come from
interviews and surveys with real users. The ones that follow **are not
that yet**. They are hypotheses informed by knowledge of the construction
sector, written to serve as a starting point to be tested, not as a
substitute for talking to real contractors and clients. Treat each one as
a question ("does the traditional master builder actually care about
X?"), not as an established fact — and note here when one is validated or
contradicted by real conversations.

## What they're for

Per the definition of personas you brought: they exist to **mediate
feature decisions**, not to decorate a document. Each persona file ends
with "Implications for features" — a direct link to concrete product
decisions (usually referencing
[05-functional-scope.md](../05-functional-scope.md)). The question to ask
whenever there's doubt about whether to build a feature: *does this help
this specific variant reach their goal, or does it only help the variant
we imagined first?* Two variants of the same role wanting different
things is a sign the feature needs to be configurable, not that one of
the two is "wrong".

## Structure

| Folder | Role | Number of variants |
|---|---|---|
| [owner/](./owner/) | Client / Owner | 3 |
| [contractor/](./contractor/) | Contractor / General contractor | 4 |
| [site-manager/](./site-manager/) | Site Manager / Foreman | 2 |
| [subcontractor/](./subcontractor/) | Subcontractor | 3 |
| [architect/](./architect/) | Architect / Designer | 2 |
| [quality-inspection/](./quality-inspection/) | Quality Inspection | 2 |
| [hse/](./hse/) | HSE Officer / Health & Safety | 2 |
| [supplier/](./supplier/) | Supplier | 2 (speculative — feature doesn't exist) |

Client's Representative, Licensing Authority, and Neighbor/Condominium
association are left out of this structure — the first has already been
resolved in [personas.md](../personas.md) (it's the same role as Owner,
with no need for its own technical variant); the other two are not users
of the application.
</content>
