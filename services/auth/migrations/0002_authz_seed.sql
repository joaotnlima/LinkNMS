-- Auth service — RBAC seed: system roles + §8.1 ratified permission matrix.
--
-- (LINA-143; Auth Bridge §4/§8.1; Architect LINA-142 §8.1.)
--
-- Seeds the three v1 system roles (`owner`, `gc`, `subcontractor`) and the
-- Architect-ratified permission matrix onto the 0001 table shape. Stable,
-- human-readable UUIDs keep the mapping explicit and reviewable.
--
-- RATIFIED MATRIX (Architect LINA-142 §8.1): owner / gc / subcontractor × the
-- real ACTION catalogue. Note the load-bearing caveat: `change_order.decide` is
-- seeded here as the STATIC half only — "may this role ever decide a CO?". The
-- runtime two-sided rule ("a CO may be decided by anyone EXCEPT its proposer")
-- is NOT expressible as a static row; it lives in `can()` (services/auth/can.mjs)
-- AND in the legacy DB CHECK (decided_by <> proposed_by). See the mandatory
-- constraint in §8.1 — LINA-143's `can()` is rejected at merge without it.
--
-- Idempotent by design (ON CONFLICT DO NOTHING): the forward-only runner applies
-- each file once, but re-running by hand must be a safe no-op.

CREATE SCHEMA IF NOT EXISTS authz;

-- ── permissions: the verb vocabulary (namespaced dot-verbs, deny-by-default) ──
INSERT INTO authz.permissions (id, key, descr) VALUES
  ('10000000-0000-4000-8000-000000000001', 'project.create',      'Create a project'),
  ('10000000-0000-4000-8000-000000000002', 'project.read',        'View a project and its record'),
  ('10000000-0000-4000-8000-000000000003', 'project.update',      'Edit project details'),
  ('10000000-0000-4000-8000-000000000004', 'project.delete',      'Delete a project'),
  ('10000000-0000-4000-8000-000000000005', 'project.invite',      'Invite a member / counterparty'),
  ('10000000-0000-4000-8000-000000000006', 'decision.create',     'Record a decision'),
  ('10000000-0000-4000-8000-000000000007', 'decision.read',       'Read decisions'),
  ('10000000-0000-4000-8000-000000000008', 'change_order.create', 'Propose a change order'),
  ('10000000-0000-4000-8000-000000000009', 'change_order.read',   'Read change orders'),
  ('10000000-0000-4000-8000-000000000010', 'change_order.decide', 'Decide a change order'),
  ('10000000-0000-4000-8000-000000000011', 'budget.read',         'View budget and cost movement'),
  ('10000000-0000-4000-8000-000000000012', 'schedule.read',       'View the schedule and progress'),
  ('10000000-0000-4000-8000-000000000013', 'schedule.update',     'Update the schedule'),
  ('10000000-0000-4000-8000-000000000014', 'task.assign',         'Assign and manage tasks'),
  ('10000000-0000-4000-8000-000000000015', 'member.invite',       'Invite a member / counterparty'),
  ('10000000-0000-4000-8000-000000000016', 'progress.report',     'Report progress'),
  ('10000000-0000-4000-8000-000000000017', 'plan.upload',         'Upload a plan document')
ON CONFLICT (id) DO NOTHING;

-- ── roles: the three v1 system roles (org_id NULL) ───────────────────────────
INSERT INTO authz.roles (id, org_id, key, name) VALUES
  ('20000000-0000-4000-8000-000000000001', NULL, 'owner',         'Owner'),
  ('20000000-0000-4000-8000-000000000002', NULL, 'gc',            'General Contractor'),
  ('20000000-0000-4000-8000-000000000003', NULL, 'subcontractor', 'Subcontractor')
ON CONFLICT (id) DO NOTHING;

-- ── role_permissions: the §8.1 matrix ─────────────────────────────────────────
-- owner: full project control + invite + record/revise decisions ───────────
INSERT INTO authz.role_permissions (role_id, permission_id) VALUES
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001'), -- project.create
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'), -- project.read
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003'), -- project.update
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000004'), -- project.delete
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000005'), -- project.invite
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000015'), -- member.invite
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000006'), -- decision.create
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000007'), -- decision.read
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000008'), -- change_order.create
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000009'), -- change_order.read
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000010'), -- change_order.decide (STATIC half; runtime ≠ proposer in can())
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000011'), -- budget.read
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000012'), -- schedule.read
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000013'), -- schedule.update
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000014')  -- task.assign
ON CONFLICT DO NOTHING;

-- gc: project member, manage change orders, owns the plan ─────────────────
INSERT INTO authz.role_permissions (role_id, permission_id) VALUES
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002'), -- project.read
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000006'), -- decision.create
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000007'), -- decision.read
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000008'), -- change_order.create
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000009'), -- change_order.read
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000010'), -- change_order.decide (STATIC half)
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000011'), -- budget.read
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000012'), -- schedule.read
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000013'), -- schedule.update
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000016'), -- progress.report
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000017'), -- plan.upload
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000014')  -- task.assign
ON CONFLICT DO NOTHING;

-- subcontractor: scoped read + assigned tasks ─────────────────────────────
INSERT INTO authz.role_permissions (role_id, permission_id) VALUES
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002'), -- project.read (SCOPED via resource_acls — §8.1)
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000009'), -- change_order.read
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000011'), -- budget.read
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000012'), -- schedule.read
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000016'), -- progress.report (SCOPED to assigned stages — §8.1)
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000014')  -- task.assign
ON CONFLICT DO NOTHING;