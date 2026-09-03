# ADR-0001 — Stack & platform

- **Status:** Proposed (awaiting CEO approval)
- **Date:** 2026-08-25
- **Deciders:** Full-Stack Architect (with CEO ruling on the service-topology trade-off)
- **Context issue:** LINA-26 (R0)

## Context

R0 is the thinnest end-to-end slice a homeowner + one GC can use to answer
"who decided this, when, and how much did it move the budget?" — responsive web,
no native. Deploy target is Vercel (CEO direction). The product will later grow
to many houses and many parties, so today's core must not be a dead end.

## Decision

- **Frontend + API:** **Next.js (App Router)** deployed on **Vercel**. UI is
  server-rendered React; the HTTP API is Next.js Route Handlers running as
  Vercel serverless functions. One deployable, clean internal seams (ADR-0003).
- **System of record:** **Postgres** (Vercel Postgres / Neon — serverless
  Postgres). Strong transactions and constraints are non-negotiable for a
  budget/audit product; the ledger's integrity leans on them (ADR-0002).
- **Data access:** a thin typed query layer (SQL migrations checked into the
  repo; a light query builder or `postgres.js`). No heavyweight ORM in R0 —
  the ledger rules are explicit SQL we want to read and audit.
- **Language:** TypeScript end to end.
- **Auth (R0):** ~~magic-link / invite-token sessions~~ → **Clerk** since
  LINA-124 (Auth Migration 0B); ADR-0007 is superseded. Sessions are still
  scoped to a project by the same permission model. Full
  IdP is out of scope; the permission *model* (ADR-0004) is what matters now.

## The service-topology trade-off (for the CEO to rule on)

The brief asks for a "micro-service-oriented" architecture. My recommendation:

- **Do:** design around **bounded capability services** (Identity/Membership,
  Decision Log, Change Order, Ledger/Budget) with explicit interfaces, each
  exposed as its own group of Vercel serverless functions (ADR-0003).
- **Don't (yet):** split them into separately deployed processes with their own
  databases and network hops. For one homeowner + one GC, distributed
  micro-services buy us operational cost, eventual-consistency bugs, and
  distributed-transaction pain across the very budget math that must be exact —
  with no scaling benefit at this volume.

This gives real seams to extract services later (each already has a defined
interface and owns its tables) **without** paying the distributed-systems tax on
day one. It satisfies the *intent* (service-oriented, splittable, Vercel-native)
while protecting correctness and velocity. **If the CEO wants hard process/DB
separation in R0, I'll adjust — but I'd be recording it as a known cost.**

## Consequences

- **Positive:** exact transactional budget math; fast delivery; Vercel-native;
  clean extraction path per service.
- **Negative / debt:** shared Postgres means service isolation is by convention
  + schema ownership, not enforced by the network. We accept and document this;
  ADR-0003 defines the seams that make later extraction mechanical.
- **Revisit when:** we add a third party type or multi-house, or a service needs
  independent scaling/deploy cadence.
