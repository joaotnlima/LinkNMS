-- Enable in-place sign-off resolution (LINA-278; ADR-0023 Addendum A §1).
--
-- Migration 0012 (LINA-277, #129) shipped schedule.phase_sign_off_request with an
-- "append-only" grant (SELECT + INSERT only) and a comment describing resolution
-- as "a NEW approved/rejected row". But the table it actually created is built for
-- IN-PLACE resolution, not an append-only ledger:
--   * the resolution lives on the request row itself — `resolved_at` +
--     `resolution_comment` columns, plus the CHECK
--     `phase_sign_off_resolved_iff_not_pending` that binds resolved_at to a
--     non-pending status;
--   * `phase_sign_off_one_pending_per_phase` (partial UNIQUE WHERE status =
--     'pending') keeps exactly one OUTSTANDING request per phase.
--
-- With INSERT-only, a 'pending' row can never be moved to 'approved'/'rejected'
-- (no UPDATE), and inserting a second terminal row leaves the original stuck
-- 'pending' forever — which permanently blocks the one-pending index and makes
-- "reject, then request again" impossible. The endpoint contract is also
-- request-addressed (`/sign-off/:requestId/approve|reject`), which only makes
-- sense against the row the id names. So the correct model — and the one the
-- table's own columns + CHECK were designed for — is in-place resolution.
--
-- This grant is the missing piece: approve/reject stamps status + resolved_at +
-- resolution_comment on the SAME row (guarded by the CHECK and the one-pending
-- index). Tamper-evidence for the sign-off DECISION does not rely on this row's
-- immutability — it lives in the one-way `project_phase` signed_off trigger, the
-- append-only `plan_change_log`, and the change-order ledger (ADR-0014). The
-- request row is a mutable-lifecycle workflow record, like `rfp`/`rfp_recipient`
-- (both of which already grant UPDATE in 0012).
--
-- Forward-only: 0012 is already applied on dev, so its bytes are frozen (the prod
-- schema-gate checksum guard). This adds the grant in a new migration rather than
-- editing 0012. Head migration is schedule/0012.

GRANT UPDATE ON TABLE schedule.phase_sign_off_request TO schedule_app;

COMMENT ON TABLE schedule.phase_sign_off_request IS
  'Sign-off request resolved IN PLACE (approve/reject stamps status + resolved_at + resolution_comment on the request row; one pending per phase via partial UNIQUE). Supersedes the append-only note from 0012 — tamper-evidence for the decision is the one-way project_phase trigger + plan_change_log + change-order ledger, not this workflow row. LINA-278 / ADR-0023 Addendum A.';
