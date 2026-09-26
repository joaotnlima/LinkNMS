-- 0002 — platform.idempotency_key (phase 0).
--
-- Doc 11: every POST command accepts Idempotency-Key; a replay returns the
-- original result. This table is the memory of that promise. The reservation
-- row is inserted in the SAME transaction as the command's domain write, so a
-- rolled-back command leaves no reservation and the key is cleanly retryable.
--
-- Scoped per caller (Clerk user id) and operation: one tenant's key can never
-- collide with another's, and reusing a key on a different operation is a
-- different request, not a replay.

CREATE TABLE platform.idempotency_key (
  key             text NOT NULL,
  caller          text NOT NULL,            -- Clerk user id of the acting person
  operation_id    text NOT NULL,            -- OpenAPI operationId
  request_hash    bytea NOT NULL,           -- sha256 of the canonical request body
  response_status int,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  PRIMARY KEY (key, caller, operation_id)
);

-- Retention sweeps delete by age; nothing else ever mutates a completed row.
CREATE INDEX idempotency_key_created ON platform.idempotency_key (created_at);
