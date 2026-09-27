-- 0007 — Tendering public-token lifecycle (gap S1, doc 21-gap-review).
--
-- The RFP personal link is the flow D-29 makes central: a bidder who has never
-- heard of LinkNMS arrives from an email holding a 32-byte token and nothing
-- else. `tendering.rfp_recipient` already stored that token as a sha256 hash
-- (0001), but its lifecycle was undefined — no expiry, no revocation, and no
-- public endpoint to spend it against (gap S1). This migration adds the two
-- missing lifecycle columns; the public surface (GET the package, POST the
-- proposal) ships with the module code (modules/tendering).
--
-- Single-use is NOT a new column: a spent link is one whose recipient has
-- status = 'proposal_submitted' (0001) and whose auto-created proposal (one per
-- recipient, D-36) has left 'invited'/'draft'. The public submit is guarded on
-- that state, so a second POST answers already_submitted, and the GET after a
-- submit returns the recipient's own proposal back (the confirmation view)
-- rather than the form.
--
-- expires_at is stamped when the recipient is added, from the RFP's
-- submission_deadline plus a validity window (doc 21 S1: "default: RFP
-- submission_deadline + validity window"). Existing rows are back-filled from
-- their RFP the same way. revoked_at is null until a re-issue rotates the link.

ALTER TABLE tendering.rfp_recipient
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

-- Back-fill expiry for links minted before this migration: the RFP's
-- submission deadline plus the 14-day proposal-validity window.
UPDATE tendering.rfp_recipient rec
   SET expires_at = r.submission_deadline + interval '14 days'
  FROM tendering.rfp r
 WHERE r.id = rec.rfp_id
   AND rec.expires_at IS NULL;

-- The public token endpoints look a recipient up by token_hash; that column is
-- already UNIQUE (0001), so no extra index is needed for the point lookup.
