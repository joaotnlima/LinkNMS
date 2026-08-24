---
role: Client / Owner
variant: The couple / shared decision
status: unvalidated hypothesis
---

# The couple / shared decision

## Who they are

Two people (typically a couple, but could be partners or family) deciding
together, often with different priorities from one another — one more
focused on budget, the other on design/finish. This is the concrete
situation behind the "Client representative" persona in
[personas.md](../../personas.md), already resolved at the access level
(two `ProjectMember`s with the same role) but not at the process level.

## Motivations

Both people want equal visibility, and neither wants to be the last to
know about a decision the other has already made.

## Pain points

- Disagreement between the two of them about a change — the app sees two
  `OWNER`s, but doesn't know they might not be aligned.
- Risk of one deciding alone (approving a `ChangeOrder`) without the other
  knowing, creating the same type of conflict the product exists to
  prevent on the contractor-client side, now within the client's own
  side.

## Behaviors

- May use the app separately, at different times — it's not guaranteed
  they see the same thing at the same time.

## Where this differs from other variants of the same role

It's the only Owner variant where the "client" isn't a single person —
the other two variants ([first-time owner](./01-first-time-owner.md),
[experienced owner](./02-experienced-owner-investor.md)) describe one
person's level of knowledge; this one describes a dynamic between two.

## Implications for features

- **In favor of**: visibility of who specifically approved what, not just
  "the owner approved" — the `AuditLog` already records this per
  individual user (`changedByName`), which already solves half the
  problem; what remains is deciding the business rule (one is enough, or
  both have to approve).
- **In favor of**: notifying both `OWNER`s of a project whenever a change
  is proposed, not just one.
- **Open question, deliberately repeated**: the same one from
  [personas.md](../../personas.md) and
  [03-premium-contractor.md](../contractor/03-premium-contractor.md) —
  it appears in three different places because it's genuinely the same
  unresolved business decision, not three distinct problems.
