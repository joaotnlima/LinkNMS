# Flow 01 — Bootstrap a build: two entry points, one converged record

**Status:** current · **Owner:** Full-Stack Architect · **Since:** LINA-227 (FE),
building on LINA-221 / ADR-0016 (contract).

A build on LinkNMS can be started from **either side of the table** — the
homeowner who commissions it, or the general contractor who runs it. Both routes
land on the **same shared record**: one project, one immutable ledger, the same
two seats (owner + GC). The only differences are *who creates first* and *who
gets invited*. This doc is the map of both paths and where they converge.

Related: [ADR-0011](../docs/architecture/adr/0011-build-creation-operating-model.md)
(build-creation operating model), [ADR-0016](../docs/architecture/adr/0016-gc-as-creator-ownership-inversion.md)
(the ownership inversion this flow's GC path rests on). The wizard's pure
contract lives in `app/src/lib/build-creation.ts`.

## The one screen that forks the flow

The New-build wizard opens at **`/projects/new`** with a pre-Basics question —
pen D2, *"Who are you on this build?"*:

- **Owner (homeowner)** — pre-selected default.
- **General contractor** — the inverted path.

This screen is a **pre-wizard question, not a counted step**: the three-step rail
(Basics → Operating model → Invite) is unchanged, so an owner's flow past this
point is byte-identical to what shipped before the role screen existed. The
choice is carried to Basics as `?as=owner|counterparty` and echoed into the
`createProject` call as `creatorRole`. A direct hit on `/projects/new/basics`
with no `?as` defaults to `owner` — the service default — so nothing regresses.

`creatorRole` is **never trusted as a membership claim**: it is a choice the
wizard sends, validated and defaulted server-side (`services/identity`), and the
acting party still comes from the verified session.

## Path A — Owner creates (the default, unchanged)

1. **`/projects/new`** — pick **Owner** → Continue.
2. **`/projects/new/basics`** (`?as=owner`) — name, address, type, expected start.
   Submit creates the build as a **draft** with the creator as the `owner`
   membership and `owner_party_id` stamped at genesis.
3. **`/projects/[id]/operating-model`** — choose turnkey / direct / hybrid.
4. **`/projects/[id]/invite`** — invite the **general contractor** (or a
   specialty, for direct-to-specialty). The first invite commits the draft to
   `active`.

## Path B — GC creates (the inversion, ADR-0016)

1. **`/projects/new`** — pick **General contractor** → Continue.
2. **`/projects/new/basics`** (`?as=counterparty`) — same fields; the lede reads
   for a GC ("a build you'll run", not "a build you own"). Submit creates the
   draft with the creator as the **`counterparty`** membership and
   **`owner_party_id` NULL** — there is no homeowner yet, and the record says so
   truthfully rather than pretending the GC is the owner.
3. **`/projects/[id]/operating-model`** — same choice. The draft is driven by its
   sole member (the "draft-driver" right, ADR-0016 §3), so a counterparty creator
   may set the model and commit — a right scoped to a draft, not a widened role.
4. **`/projects/[id]/invite`** — the invite **inverts to the homeowner** (role
   `owner`). The service admits `owner` only while the build has no owner member
   yet, so this is exactly the one inverted first invite. On accept, the
   homeowner's `owner` membership is inserted and `owner_party_id` is stamped
   **once** (NULL → value, never re-pointed) alongside an `owner_joined` ledger
   event.

## Where the paths converge

After the first invite is accepted, **both records are identical in shape**: one
owner, one primary counterparty, an operating model, and a ledger whose genesis
event records `creatorRole` + `creatorPartyId` — so the audit trail always names
*who founded the build and as what*, regardless of which door it came through.
Everything downstream (plan import, change orders, budget movement, the audit
log) is blind to the entry point.

## Invariants this flow must not break

- **`owner_party_id` never lies.** NULL means "no homeowner member yet"; a value
  means a real owner who joined. It is set once and never re-pointed (enforced at
  the SQL layer, ADR-0016 §4). Authorization decides on **membership role**,
  never on `owner_party_id`, so a NULL owner is not an authz hole.
- **The owner path is byte-identical.** The role screen is additive; picking
  Owner (or hitting Basics directly) reproduces the pre-LINA-227 behaviour.
- **The client never decides who may join.** The FE sends the role it intends;
  the service is the authority and rejects anything the build does not admit.
- **A draft has exactly one member** — its creator. That is what makes the
  draft-driver right tight: "a member of a draft" uniquely identifies its creator.
