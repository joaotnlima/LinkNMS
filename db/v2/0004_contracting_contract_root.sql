-- 0004 — contracting.contract_root (to-be docs 06, 15; phase 3).
--
-- A contract is signed over a set of plan rows: the roots of the branches it
-- covers (ContractCreate.root_task_ids in api/v2). planning.task.contract_id
-- is only stamped on the branch root WHEN THE CONTRACT IS SIGNED (doc 15,
-- "set when the branch is awarded/signed") — so a DRAFT contract needs its
-- own record of which rows it is about. This table is that record, owned by
-- contracting; planning reads it from the contracting.contract.signed event
-- to bind tasks and take the baseline (doc 10). No cross-schema FK on
-- task_id (doc 02: no cross-schema foreign keys).
CREATE TABLE contracting.contract_root (
  contract_id uuid NOT NULL REFERENCES contracting.contract(id),
  task_id     uuid NOT NULL,
  PRIMARY KEY (contract_id, task_id)
);
