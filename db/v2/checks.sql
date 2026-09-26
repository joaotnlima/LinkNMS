-- Executable checks of the to-be model against the "Casa Silva" seed.
-- Each block prints what a rule in the docs claims; the last section proves the DB refuses bad writes.
\pset footer off
\echo '== 1. Contracts each org may read commercially (V2) =='
SELECT o.legal_name AS viewer, string_agg(c.reference, ', ' ORDER BY c.reference) AS readable_contracts
FROM identity.organization o JOIN contracting.contract c ON o.id IN (c.client_org_id, c.supplier_org_id)
GROUP BY 1 ORDER BY 1;

\echo '== 2. Cost column per viewer (V5, D-27): subtree roll-up, split by the viewer''s side of each contract =='
\echo '   revenue = lines of contracts where the viewer is supplier · cost = lines where the viewer is client (or own estimates)'
WITH RECURSIVE sub AS (
  SELECT id AS root, id FROM planning.task WHERE deleted_at IS NULL
  UNION ALL SELECT s.root, t.id FROM planning.task t JOIN sub s ON t.parent_id = s.id),
viewers AS (SELECT seed.id(v) AS org, v FROM unnest(ARRAY['org.silva','org.douro','org.atlantico']) v),
lines AS (
  SELECT b.*, c.client_org_id, c.supplier_org_id, round(b.quantity*b.unit_price_cents) AS amt FROM contracting.boq_item b
  LEFT JOIN contracting.contract c ON c.id = b.contract_id WHERE b.superseded_by_change_order_id IS NULL),
agg AS (
  SELECT t.name, t.position, v.v,
         sum(l.amt) FILTER (WHERE l.supplier_org_id = v.org) AS revenue,
         sum(l.amt) FILTER (WHERE l.client_org_id = v.org OR l.estimate_owner_org_id = v.org) AS cost
  FROM planning.task t JOIN viewers v ON true JOIN sub s ON s.root = t.id
  LEFT JOIN lines l ON l.task_id = s.id
  WHERE t.id IN (seed.id('T-100'), seed.id('T-500'), seed.id('T-400'), seed.id('T-014'))
  GROUP BY 1,2,3)
SELECT name AS row, v AS viewer,
       coalesce(to_char(revenue/100.0,'FM999G999D00'),'') AS revenue_eur,
       coalesce(to_char(cost/100.0,'FM999G999D00'),'') AS cost_eur,
       CASE WHEN revenue IS NOT NULL AND cost IS NOT NULL THEN to_char((revenue-cost)/100.0,'FM999G999D00') ELSE '' END AS margin_eur,
       CASE WHEN revenue IS NULL AND cost IS NULL THEN '(empty)' ELSE '' END AS note
FROM agg ORDER BY position, v;

\echo '== 3. Edit scope per org (D-33): own branches + descendants in the contract chain; owner = everything =='
WITH RECURSIVE chain AS (
  SELECT o.id AS org, c.id AS contract FROM identity.organization o JOIN contracting.contract c ON c.supplier_org_id = o.id
  UNION SELECT ch.org, c.id FROM chain ch JOIN contracting.contract c ON c.parent_contract_id = ch.contract)
SELECT o.legal_name AS org,
       string_agg(t.name, ' · ' ORDER BY t.position) FILTER (WHERE t.parent_id IS NULL) AS editable_top_rows,
       count(t.id) AS editable_rows
FROM identity.organization o
JOIN planning.task t ON t.project_id = seed.id('prj.silva') AND (
      o.id = (SELECT owner_org_id FROM project.project WHERE id = t.project_id)
   OR t.branch_contract_id IN (SELECT contract FROM chain WHERE chain.org = o.id))
GROUP BY 1 ORDER BY 3 DESC;

\echo '== 4. Variations the owner is notified about (time/scope all; cost/material only on readable contracts) =='
SELECT v.kind, t.name, v.delta, v.status
FROM planning.variation v JOIN planning.task t ON t.id = v.task_id
WHERE v.scope_type = 'project'
   OR v.scope_id IN (SELECT id FROM contracting.contract WHERE seed.id('org.silva') IN (client_org_id, supplier_org_id))
ORDER BY v.first_changed_at;

\echo '== 5. Ledger as the owner reads it (V7): out-of-scope entries redacted, chain still verifiable =='
SELECT e.seq, e.type,
       CASE WHEN e.scope_type = 'project'
              OR e.scope_id IN (SELECT id FROM contracting.contract WHERE seed.id('org.silva') IN (client_org_id, supplier_org_id))
            THEN e.payload::text ELSE '[redacted: change in a contract you are not party to]' END AS payload,
       encode(e.entry_hash,'hex') AS entry_hash
FROM record.audit_event e WHERE e.project_id = seed.id('prj.silva') ORDER BY e.seq;

\echo '== 6. Chain verification (recompute every hash) =='
WITH RECURSIVE v AS (
  SELECT e.seq, e.entry_hash, sha256(''::bytea || e.payload_hash || convert_to(e.seq::text||'|'||e.occurred_at::text||'|'||e.scope_type||':'||e.scope_id::text,'UTF8')) = e.entry_hash
         AND sha256(convert_to(e.payload::text,'UTF8')) = e.payload_hash AS ok
  FROM record.audit_event e WHERE e.project_id = seed.id('prj.silva') AND e.seq = 1
  UNION ALL
  SELECT e.seq, e.entry_hash, v.ok AND e.prev_hash = v.entry_hash
         AND sha256(e.prev_hash || e.payload_hash || convert_to(e.seq::text||'|'||e.occurred_at::text||'|'||e.scope_type||':'||e.scope_id::text,'UTF8')) = e.entry_hash
  FROM record.audit_event e JOIN v ON e.seq = v.seq + 1 AND e.project_id = seed.id('prj.silva'))
SELECT max(seq) AS length, bool_and(ok) AS valid FROM v;

\echo '== 7. Proposal lanes under T-500 as the issuer (Douro) sees them (D-36) =='
SELECT coalesce(o.legal_name, r.email) AS bidder, p.channel, p.status,
       to_char(p.summary_total_cents/100.0,'FM999G999D00') AS total_eur, p.summary_duration_wd AS wd
FROM tendering.proposal p JOIN tendering.rfp_recipient r ON r.id = p.recipient_id
LEFT JOIN identity.organization o ON o.id = p.bidder_org_id
WHERE p.rfp_id IN (SELECT rfp_id FROM tendering.rfp_root WHERE task_id = seed.id('T-500')) ORDER BY 1;

\echo '== 8. The database refuses what the model forbids (each must ERROR) =='
\set ON_ERROR_STOP 0
\set VERBOSITY terse
\echo '-- 8a change order decided by its proposer'
UPDATE contracting.change_order SET decided_by_org_id = proposed_by_org_id WHERE id = seed.id('co.p1');
\echo '-- 8b edit a BoQ line of a signed contract in place'
UPDATE contracting.boq_item SET unit_price_cents = 1 WHERE id = seed.id('boq.ctr.prime.3.1');
\echo '-- 8c rewrite progress history'
UPDATE planning.progress_report SET note = 'x' WHERE task_id = seed.id('T-130') AND seq = 2;
\echo '-- 8d tamper with the ledger'
UPDATE record.audit_event SET payload = '{}' WHERE seq = 2;
\echo '-- 8e a second live prime contract on the same project'
INSERT INTO contracting.contract (id, project_id, kind, client_org_id, supplier_org_id, reference, origin, status)
VALUES (gen_random_uuid(), seed.id('prj.silva'), 'prime', seed.id('org.silva'), seed.id('org.alufer'), 'X', 'direct_entry', 'signed');
\echo '-- 8f an 11th hierarchy level'
INSERT INTO planning.task (id, project_id, depth, position, name) VALUES (gen_random_uuid(), seed.id('prj.silva'), 11, 'z', 'too deep');
\echo '-- 8g a verification decided by the organisation that asked for it'
UPDATE quality.verification_request SET decided_by_org_id = requested_by_org_id WHERE id = seed.id('vr.T-130');
\echo '-- 8h a non-conformity closed by someone other than who raised it'
INSERT INTO quality.nonconformity (id, project_id, raised_by_org_id, raised_by_person_id, severity, description, status, closed_by_org_id)
VALUES (gen_random_uuid(), seed.id('prj.silva'), seed.id('org.marta'), seed.id('p.marta'), 'major', 'Lintel V3', 'closed', seed.id('org.douro'));
