-- Ledger & Budget service — schema `ledger` (ADR-0002, ADR-0006 §1).
-- Owner of the `audit_event` trust anchor and the `budget_event` projection.
--
-- The load-bearing rule (ADR-0002 §4): NO role — not even the ledger's own app
-- role — holds raw INSERT/UPDATE/DELETE on `audit_event`. Every append goes
-- through `ledger.append_event(...)`, a SECURITY DEFINER function that
-- constructs `seq`/`prev_hash`/`entry_hash` in exactly one place (ADR-0006 §1).
-- `payload_hash` (canonical-JSON sha256) is computed by the shared JS core
-- `services/ledger/hash-chain.mjs` and passed in — it is NEVER re-implemented in
-- SQL. The only hashing done here is the chain-link `sha256(prev || payload)`,
-- a trivial concat of two ascii hex strings, cross-checked against the JS core
-- in the ledger tests.
--
-- Forward-only. Applied by the migrator/owner role; app roles never run DDL.

create schema if not exists ledger;

-- pgcrypto provides digest() for the chain-link hash. Installed into `public`.
create extension if not exists pgcrypto;

-- The append-only hash chain. One monotonic `seq` per project; `entry_hash`
-- binds each event to its predecessor so any silent edit/delete/reorder of a
-- past event breaks every downstream link (detected by verifyChain).
create table if not exists ledger.audit_event (
  id             uuid        primary key default gen_random_uuid(),
  project_id     uuid        not null,
  seq            bigint      not null,
  type           text        not null,
  actor_party_id uuid,                                   -- null for system events
  occurred_at    timestamptz not null,                  -- server-authoritative (ADR-0002 §5)
  payload        jsonb,
  payload_hash   text        not null,                  -- sha256(canonical_json(meaning)) — from JS core
  prev_hash      text        not null,                  -- entry_hash of seq-1 (genesis constant for seq 1)
  entry_hash     text        not null,                  -- sha256(prev_hash || payload_hash)
  inserted_at    timestamptz not null default now(),
  constraint audit_event_project_seq_uq   unique (project_id, seq),
  constraint audit_event_project_entry_uq unique (project_id, entry_hash),
  constraint audit_event_seq_positive     check (seq >= 1),
  constraint audit_event_hash_shape       check (
    char_length(payload_hash) = 64 and
    char_length(prev_hash)    = 64 and
    char_length(entry_hash)   = 64
  )
);

-- Ordered scan per project (audit read, verify) is the hot path.
create index if not exists audit_event_project_seq_idx
  on ledger.audit_event (project_id, seq);

-- Budget projection: exactly one row per approved change order (FR5). Current
-- budget = baseline (from the project_created genesis event payload) + Σ
-- delta_cents. UNIQUE(change_order_id) makes "a CO moves the budget once, ever"
-- a database fact, and is the exactly-once backstop for serverless retries.
create table if not exists ledger.budget_event (
  id              uuid        primary key default gen_random_uuid(),
  project_id      uuid        not null,
  change_order_id uuid        not null,
  delta_cents     bigint      not null,
  audit_event_id  uuid        references ledger.audit_event(id),
  created_at      timestamptz not null default now(),
  constraint budget_event_co_uq unique (change_order_id)
);

create index if not exists budget_event_project_idx
  on ledger.budget_event (project_id);

-- The one place a row enters `audit_event`. SECURITY DEFINER: runs as the table
-- owner, so calling roles need only EXECUTE on this function and hold no direct
-- INSERT on the table. Constructs seq/prev/entry under a per-project advisory
-- lock so concurrent appends can never fork the chain or reuse a seq.
create or replace function ledger.append_event(
  p_project_id     uuid,
  p_type           text,
  p_actor_party_id uuid,
  p_occurred_at    timestamptz,
  p_payload        jsonb,
  p_payload_hash   text
) returns ledger.audit_event
language plpgsql
security definer
set search_path = ledger, pg_temp
as $$
declare
  genesis constant text := repeat('0', 64);
  v_seq   bigint;
  v_prev  text;
  v_entry text;
  v_row   ledger.audit_event;
begin
  if p_payload_hash is null or char_length(p_payload_hash) <> 64 then
    raise exception 'append_event: payload_hash must be a 64-char sha256 hex'
      using errcode = '22023';
  end if;

  -- Serialize appends for this project: seq/prev_hash are read-modify-write.
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));

  select ae.seq, ae.entry_hash
    into v_seq, v_prev
    from ledger.audit_event ae
   where ae.project_id = p_project_id
   order by ae.seq desc
   limit 1;

  v_seq  := coalesce(v_seq, 0) + 1;
  v_prev := coalesce(v_prev, genesis);

  -- Chain link. Trivial concat of two ascii hex strings — matches the JS core's
  -- entryHash(prev, payloadHash) byte-for-byte (asserted in the ledger tests).
  v_entry := encode(public.digest(v_prev || p_payload_hash, 'sha256'), 'hex');

  insert into ledger.audit_event
    (project_id, seq, type, actor_party_id, occurred_at,
     payload, payload_hash, prev_hash, entry_hash)
  values
    (p_project_id, v_seq, p_type, p_actor_party_id, p_occurred_at,
     p_payload, p_payload_hash, v_prev, v_entry)
  returning * into v_row;

  return v_row;
end;
$$;

comment on function ledger.append_event(uuid, text, uuid, timestamptz, jsonb, text) is
  'The only path that writes ledger.audit_event. Constructs seq/prev_hash/entry_hash under a per-project advisory lock (ADR-0002 §2, ADR-0006 §1). payload_hash is computed by the shared JS canonical-JSON core and passed in.';
