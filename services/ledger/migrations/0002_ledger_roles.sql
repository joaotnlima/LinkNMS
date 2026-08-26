-- Ledger grant matrix + read view (Slice 1, ADR-0002 §4, ADR-0006 §1).
--
-- Runs as the migrator, AFTER db/roles.sql (which creates the `*_app` roles) and
-- db/0001_platform.sql (which grants each app role USAGE on its own schema only).
-- This file sets the ledger's least-privilege table/function grants — the "who
-- may touch the trust anchor, and how" half of the guarantee (ADR-0002 §4):
--
--   * audit_event: NO role gets raw INSERT/UPDATE/DELETE. The only writer is
--     ledger.append_event (SECURITY DEFINER, owned by the migrator). App roles
--     read the trail through the ledger.project_audit view, never the base table.
--   * append_event: EXECUTE for the ledger service AND the two domain services
--     whose actions produce events in R0 (decision, change_order). Those two get
--     nothing else in this schema — the cross-schema seam stays a single narrow
--     hole (a typed in-process call now, HTTP later — ADR-0003/0006 §1).
--   * budget_event: a normal projection the ledger service writes/reads.
--
-- Role names match db/roles.sql (`ledger_app`, `decision_app`, `change_order_app`).
-- Forward-only.

-- ── Read view: app roles read the trail through this, never the base table ────
-- Per-project scoping is applied by the caller (WHERE project_id = …); R0 has no
-- row-level tenancy yet (a later slice). Owned by the migrator, so SELECT through
-- it works even though app roles hold no SELECT on the base table.
create or replace view ledger.project_audit as
  select project_id, seq, type, actor_party_id,
         occurred_at, inserted_at, payload,
         payload_hash, prev_hash, entry_hash
    from ledger.audit_event;

-- ── The only sanctioned writer: EXECUTE, and strip the default PUBLIC grant ───
revoke all on function
  ledger.append_event(uuid, text, uuid, timestamptz, jsonb, text) from public;
grant execute on function
  ledger.append_event(uuid, text, uuid, timestamptz, jsonb, text)
  to ledger_app, decision_app, change_order_app;

-- ── Reads: the audit trail is served through the view ─────────────────────────
grant select on ledger.project_audit to ledger_app;

-- ── Budget projection: normal DML for the ledger service only ─────────────────
grant select, insert, update on ledger.budget_event to ledger_app;

-- ── Load-bearing: nobody writes (or reads) audit_event directly ───────────────
-- No GRANT of INSERT/UPDATE/DELETE on ledger.audit_event exists anywhere; these
-- REVOKEs make it explicit and survive any future default-privilege change.
revoke insert, update, delete, truncate on ledger.audit_event from public;
revoke insert, update, delete, truncate on ledger.audit_event
  from ledger_app, decision_app, change_order_app;
revoke select on ledger.audit_event
  from ledger_app, decision_app, change_order_app;
