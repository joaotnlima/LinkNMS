# 14 — Open questions

Ordered by how much damage a wrong answer does.

1. **Will specialties pay?** (D-01, D-05) The least validated side carries a paywall. Decide the
   success metric for the first specialty cohort (e.g. % of invited subs who subscribe or are
   sponsored within 30 days) before building specialty-only features.
2. **Does a GC accept that the owner sees every change live, in clay?** (D-13, D-23) Strong
   transparency may push GCs to stop updating dates. Watch how often controlled rows are updated.
3. **Household approval policy.** With two people in a household, does a change order need
   `any` or `all`? Default proposed: `any`, configurable per household.
4. **Can the owner and a GC both create the project?** Proposed: yes; a project created by a
   supplier stays in `draft` until the owner claims it.
5. **Does the supplier rate the owner** (e.g. payment reliability on prime/direct contracts)?
   Not decided in D-16. Symmetry argues yes; owner acquisition argues no.
6. **Double-blind review publication** (14 days) — proposed, not confirmed.
7. **Sealed-bid opening.** Should the issuer only see proposals after the deadline?
   Not in v1; relevant for trust with bidders.
8. **Subs see the full plan but edit only their branch** (V1, D-33). Watch whether GCs ask to hide
   other trades' rows from their subcontractors.
9. **Consultants' scope** — the architect edits only rows the owner assigns to it. Confirm, or give it
   its own branch (design and licensing rows).
10. **Licensing phases (RJUE) and BIM** — carried over from the product docs, not re-designed here;
    they attach to Project (phases as milestones) and Documents (BIM evidence).
11. **Pricing numbers per tier** — the model is defined; the prices are not.
12. **GDPR** — household owners are private individuals; retention of personal data in an
    append-only ledger needs a crypto-shredding or pseudonymisation strategy for erasure requests.
15. **Roles (D-34)** — are the 6 roles right? Does a site lead verify work, or only managers?
16. **Household signing** — can a representative (hired PM) sign contracts for the owner, or only admins?
17. **Clerk Billing vs Stripe + certified PT invoicing** — needs EUR/VAT/AT-certification check ([16 §9](./16-access-model-clerk.md)).
