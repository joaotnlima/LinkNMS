-- 0008 — Token-scoped proposal attachments (LINA-370, S5 follow-up).
--
-- The public RFP form (gap S1, 0007) collapses a bid to a single total + a
-- working-day duration, but the wire kept `tendering.proposal.document_ids`
-- (0001) for the bidder's supporting files — a portfolio, a method statement,
-- a photo of comparable work. That array had no upload path: an anonymous
-- bidder holds only a token, and the Documents module (documents.*, 0001) is
-- built on org+person identity (both uploader columns are NOT NULL) and V6
-- relationship authorization — neither of which a tokened stranger has.
--
-- Rather than weaken the Documents invariants or punch an anonymous hole into
-- that module, the token-scoped upload lives entirely inside tendering (which
-- already owns the `rfp-links` anonymous surface): a small table of proposal
-- attachments, keyed to the proposal, stored on the SAME private R2 bucket the
-- Documents module uses (presigned both ways, ADR/doc 08), authorized by the
-- token on write and by the issuer/bidder relationship on read. Decision D-37.
--
-- Lifecycle mirrors the Documents upload protocol:
--   1. reserve  — a row is inserted `pending`; the handler mints a presigned
--                 PUT whose signature pins the declared sha256, so storage
--                 itself refuses bytes that differ from what was declared;
--   2. the client PUTs the file to R2;
--   3. complete — the handler proves the object exists with the declared size,
--                 then flips the row to `stored`. Only `stored` rows may be
--                 referenced by a proposal's document_ids at submit.
-- A reserved-but-never-completed row is an invisible orphan (never `stored`,
-- never referenced) — harmless, and cheap to sweep later if it ever matters.

CREATE TABLE tendering.proposal_document (
  id            uuid PRIMARY KEY,
  proposal_id   uuid NOT NULL REFERENCES tendering.proposal(id) ON DELETE CASCADE,
  storage_key   text NOT NULL,
  file_name     text NOT NULL,
  mime          text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','stored')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  stored_at     timestamptz
);

-- The two hot lookups: every complete/submit reads the attachments of one
-- proposal; the download route reads one row by id (the PK covers that).
CREATE INDEX proposal_document_proposal_idx
  ON tendering.proposal_document (proposal_id);
