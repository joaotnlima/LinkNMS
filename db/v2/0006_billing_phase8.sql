-- 0006 — Billing (phase 8): the plan catalogue.
--
-- The four billing tables (plan, subscription, sponsorship, add_on) already
-- ship with the bootstrap DDL (0001, ### billing in 15-data-model.md), so this
-- forward migration only seeds the catalogue the module reads from.
--
-- Prices and entitlement limits are ILLUSTRATIVE (doc 07: "Illustrative
-- tiers"; pricing numbers are out of scope per AGENT-INDEX §1) — real pricing
-- is a founder decision, and the charging provider itself is open question 17
-- (14-open-questions.md), so nothing here is billed against.
--
-- Entitlement keys are the CREATE/MANAGE capabilities the entitlements port
-- gates (modules/billing/application/entitled.mjs): reading is never a key —
-- doc 04 §4: entitlements gate creating and managing, never seeing what you
-- already agreed to.
INSERT INTO billing.plan (code, org_kind, name, price_cents, interval, entitlements) VALUES
  -- Household: pays per project (one-off / during the build) — doc 07.
  ('owner-project',     'household',  'Owner — per project',        14900, 'project', '{"projects:active": 1,  "seats": 5}'),
  -- General contractor: Starter / Pro / Business by active projects + seats.
  ('gc-starter',        'contractor', 'GC Starter',                  4900, 'month',   '{"projects:active": 3,  "seats": 5,  "rfp:open-credits": 3}'),
  ('gc-pro',            'contractor', 'GC Pro',                     14900, 'month',   '{"projects:active": 10, "seats": 15, "rfp:open-credits": 10}'),
  ('gc-business',       'contractor', 'GC Business',                39900, 'month',   '{"projects:active": 50, "seats": 50, "rfp:open-credits": 50}'),
  -- Specialty contractor: Solo / Crew / Company by seats + open-RFP credits.
  ('specialty-solo',    'contractor', 'Specialty Solo',              1900, 'month',   '{"projects:active": 5,  "seats": 1,  "rfp:open-credits": 2}'),
  ('specialty-crew',    'contractor', 'Specialty Crew',              4900, 'month',   '{"projects:active": 10, "seats": 5,  "rfp:open-credits": 5}'),
  ('specialty-company', 'contractor', 'Specialty Company',           9900, 'month',   '{"projects:active": 25, "seats": 20, "rfp:open-credits": 15}'),
  -- Consultant: by active projects.
  ('consultant',        'consultant', 'Consultant',                  2900, 'month',   '{"projects:active": 10, "seats": 3}')
ON CONFLICT (code) DO NOTHING;
