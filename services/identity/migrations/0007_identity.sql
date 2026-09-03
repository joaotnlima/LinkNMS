-- Identity — RBAC seed: system roles + v1 permission matrix (LINA-140; Auth Bridge §4/§8.1).
--
-- Seeds the three v1 system roles (`owner`, `gc`, `subcontractor`) and a proposed
-- v1 permission matrix onto the 0006 table shape. Rows use stable, human-readable
-- UUIDs so the mapping is explicit and reviewable.
--
-- ⚠️ ARCHITECT REVIEW ITEM (Auth Bridge §8.1): the exact permission-per-role
-- matrix below is a PROPOSAL for ratification. The schema (0006) is the spec's
-- fixed contract; this seed's matrix is the v1 default and may be tightened by
-- the Architect before 0A-impl-2 ships `can()`. Nothing here should be treated
-- as the final word on Owner/GC/Sub access until ratified.
--
-- Idempotent by design (ON CONFLICT DO NOTHING + WHERE NOT EXISTS): the forward-
-- only runner applies this file once, but re-running it by hand must be a safe
-- no-op rather than a duplicate/unique-constraint error. Roles are system roles
-- (org_id NULL); the partial unique index from 0006 forbids duplicate keys.

CREATE SCHEMA IF NOT EXISTS identity;

-- ── permissions: the verb vocabulary ─────────────────────────────────────────
-- Namespaced dot-verbs (Auth Bridge §4 examples: 'project.create',
-- 'change_order.approve'). Deny-by-default: only verbs explicitly granted below
-- are ever allowed by `can()`.
INSERT INTO identity.permissions (id, key, descr) VALUES
  ('10000000-0000-4000-8000-000000000001', 'project.create',      'Create a project'),
  ('10000000-0000-4000-8000-000000000002', 'project.read',        'View a project and its record'),
  ('10000000-0000-4000-8000-000000000003', 'project.update',      'Edit project details'),
  ('10000000-0000-4000-8000-000000000004', 'project.delete',      'Delete a project'),
  ('10000000-0000-4000-8000-000000000005', 'project.invite',      'Invite a member / counterparty'),
  ('10000000-0000-4000-8000-000000000006', 'decision.create',     'Record a decision'),
  ('10000000-0000-4000-8000-000000000007', 'decision.read',       'Read decisions'),
  ('10000000-0000-4000-8000-000000000008', 'change_order.create', 'Propose a change order'),
  ('10000000-0000-4000-8000-000000000009', 'change_order.read',   'Read change orders'),
  ('10000000-0000-4000-8000-000000000010', 'change_order.approve','Approve / reject a change order'),
  ('10000000-0000-4000-8000-000000000011', 'budget.read',         'View budget and cost movement'),
  ('10000000-0000-4000-8000-000000000012', 'schedule.read',       'View the schedule and progress'),
  ('10000000-0000-4000-8000-000000000013', 'schedule.update',     'Update the schedule'),
  ('10000000-0000-4000-8000-000000000014', 'task.assign',         'Assign and manage tasks')
ON CONFLICT (id) DO NOTHING;

-- ── roles: the three v1 system roles (org_id NULL) ──────────────────────────
INSERT INTO identity.roles (id, org_id, key, name) VALUES
  ('20000000-0000-4000-8000-000000000001', NULL, 'owner',         'Owner'),
  ('20000000-0000-4000-8000-000000000002', NULL, 'gc',            'General Contractor'),
  ('20000000-0000-4000-8000-000000000003', NULL, 'subcontractor', 'Subcontractor')
ON CONFLICT (id) DO NOTHING;

-- ── role_permissions: the v1 matrix (PROPOSAL — Architect to ratify, §8.1) ──
-- Roles are inserted with stable ids above, so this join is a plain INSERT of
-- (role_id, permission_id) pairs; ON CONFLICT keeps it idempotent.
--
-- owner: full project control + invite ───────────────────────────────
INSERT INTO identity.role_permissions (role_id, permission_id) VALUES
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001'), -- project.create
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'), -- project.read
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003'), -- project.update
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000004'), -- project.delete
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000005'), -- project.invite
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000006'), -- decision.create
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000007'), -- decision.read
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000008'), -- change_order.create
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000009'), -- change_order.read
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000010'), -- change_order.approve
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000011'), -- budget.read
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000012'), -- schedule.read
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000013'), -- schedule.update
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000014')  -- task.assign
ON CONFLICT DO NOTHING;

-- gc: project member, manage change orders ──────────────────────────
INSERT INTO identity.role_permissions (role_id, permission_id) VALUES
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002'), -- project.read
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000006'), -- decision.create
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000007'), -- decision.read
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000008'), -- change_order.create
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000009'), -- change_order.read
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000010'), -- change_order.approve
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000011'), -- budget.read
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000012'), -- schedule.read
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000013'), -- schedule.update
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000014')  -- task.assign
ON CONFLICT DO NOTHING;

-- subcontractor: scoped read + assigned tasks ───────────────────────
INSERT INTO identity.role_permissions (role_id, permission_id) VALUES
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002'), -- project.read
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000009'), -- change_order.read
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000011'), -- budget.read
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000012'), -- schedule.read
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000014')  -- task.assign
ON CONFLICT DO NOTHING;
