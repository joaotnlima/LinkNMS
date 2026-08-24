# Personas — LinkNMS

The eleven roles involved in building a house, and what each one needs
from LinkNMS. This list covers stakeholders an earlier, six-persona
version missed: supplier, independent quality inspection, health and
safety, and parties external to the project (neighbour, licensing
authority).

Variants *within* each role — four kinds of contractor, three kinds of
owner, two kinds of quality inspection — are a separate layer, and one
still to be written. They matter: a traditional master builder and a
volume production contractor are the same persona in this table and
completely different users in practice.

## Persona table

| Persona | Role on site | What they need from LinkNMS |
|---|---|---|
| Client / Owner | Sets priorities, approves decisions, tracks costs and schedule | Simple progress view, approvals, budget, photos, messages and alerts |
| Client's Representative | Family member, project manager, or architect acting on the client's behalf | Delegated access, approve or comment on decisions, receive updates |
| Contractor / General contractor | Plans and executes the works; coordinates crews and suppliers | Planning, tasks, daily log, decision requests, cost control |
| Site Manager / Foreman | Operates on site and ensures day-to-day execution | Tasks by crew, checklists, photos, incidents, materials, and quick communication |
| Subcontractor | Executes trades: electrical, plumbing, HVAC, carpentry, etc. | Assigned work, dates, relevant drawings, completion/issue reporting |
| Supplier | Supplies materials, equipment, or finishes | Orders, delivery dates, receipt confirmation, product documentation |
| Architect / Designer | Clarifies the design and validates drawing/spec changes | Clarification requests, plan versions, approvals and change log |
| Quality Inspection / Clerk of works | Controls quality, compliance, and execution against the design | Inspections, non-conformities, photographic evidence, reports and sign-offs |
| HSE Officer / Health & Safety Technician | Controls risks, safety, and corrective actions on site | Safety inspections, non-conformities, evidence, action plans |
| Licensing Authority / Public inspector | May carry out inspections or require documentation | One-off access to documents, inspection milestones and compliance evidence |
| Neighbour / Condominium association | Stakeholder regarding noise, access, damage, or interventions in common areas | Site notices, contacts, occurrence logging and follow-up |

## What this list settles, and what it leaves open

**The licensing authority is not a platform user.** "One-off access to
documents" means exactly that: viewing specific documents and milestones,
not an account with free navigation through the project. The product
answer is a share link with a limited scope and an expiry date ("these 3
documents, valid until X"), not an account for a council employee. Giving
them an account reopens a question best left closed: who authorizes that
access, and on what legal basis.

**The neighbour is a persona information is recorded *about*, not by.**
Every other persona *uses* the product. Nobody expects a neighbour to
create an account to see site notices. What this persona calls for is a
record of occurrences — date, description, who or what was affected,
resolution status — kept by the site team. If it ever makes sense to
actively notify them ("works will be noisy tomorrow, 9am–12pm"), that is
an outbound notification, not access to the platform. The same mistake as
the licensing-authority case: giving an account to someone who only needs
to be informed.

**Quality Inspection and Site Manager have structurally opposed
interests, and that is the point.** The site manager wants the works to
move forward; quality inspection exists precisely to be able to say they
don't move forward without correction, even against the contractor's
immediate interest. A non-conformity therefore cannot be something the
contractor resolves and closes alone — it needs to pass back through
whoever raised it before it is considered settled. Without that, the
non-conformity log is decoration.

**HSE and Quality Inspection are the same mechanics with different
criteria.** Inspections, non-conformities, photographic evidence,
reports — the structure is identical between "controls quality" and
"controls safety"; what changes is the criteria, not the mechanics. In
Portugal this also carries legal weight: works above certain thresholds
require a Health and Safety Plan and a safety coordinator (Decreto-Lei
273/2003) — it is not a bonus persona, it is frequently mandatory.

**The Client's Representative is not a separate role.** It is a second
person with the owner's access on the same build — a couple, or an owner
plus a hired project manager. What is left to decide is not a product
mechanic but a process one: when two people hold owner-level approval,
does a change order need both of them, or either one? That has to be a
business answer.

**The Supplier depends on a capability that doesn't exist yet.** This
persona only takes shape once purchase orders are part of the product. It
makes sense to name it now; it does not make sense to design their access
before then.

## Contractor and Subcontractor, given how houses actually get built

The table above lists Contractor and Subcontractor as if a Subcontractor
always sits underneath a Contractor. In practice, an owner often contracts
each specialty directly, with no general contractor in the relationship at
all — a "Subcontractor," in that case, is the direct counterparty to the
Owner, not a role subordinate to Contractor. See
[03-operating-models.md](./03-operating-models.md)
for the turnkey / direct-to-specialty / hybrid distinction this implies,
and why it changes what several personas in this table actually need, not
just who they report to.

## On access

Access is described here in terms of what each persona needs to see and
do, not as a fixed set of named roles. Forcing eleven personas into three
values (owner / contractor / admin) makes every new persona an exception;
naming roles after the personas that actually exist on a build, and
allowing an individual to be granted or denied something their role
normally carries, is the shape this product needs. The two cases already
known to need narrower scope are the subcontractor (only their own tasks)
and the architect (only documents).
