-- 0023 — Connecting the RFP and the directory (PRD-04 X-1..X-13, D-47).
--
-- Ownership: Tendering. Nothing here references another schema except the
-- one-off back-fill of specialty_codes from planning.task (read once, at
-- migration time, as 0019 did for documents).
--
--   rfp_recipient.source       — where the bidder came from: directory (added
--                                from the search or a profile), email (typed by
--                                the issuer), asked_to_bid (an approved request).
--                                The PRD's `company_id` is the existing org_id:
--                                a directory profile is keyed by its
--                                organisation id; an e-mail invite has none
--                                until that address's unclaimed profile is
--                                claimed (back-filled by the tendering consumer
--                                of directory.profile.claimed).
--   rfp_recipient.company_name — the directory display name, snapshotted when
--                                added from the directory.
--   rfp.listed                 — "also list it as an open request" (D-47).
--                                Replaces visibility = 'open'; visibility is
--                                KEPT, deprecated, in step with listed by a
--                                trigger (it is in the v2 contract and billing's
--                                open-listing usage still counts it).
--   rfp.specialty_codes        — taxonomy codes of the package rows (planning
--                                task.specialty_code) — what open requests are
--                                matched on.
--   bid_request                — a company asks to bid on a listed RFP; the
--                                issuer approves (creates the lane) or declines.
--
-- No GRANTs (single application pool, see 0008_project_phases_signoff.sql).

-- 1. Invites carry their source ─────────────────────────────────────────────
ALTER TABLE tendering.rfp_recipient
  ADD COLUMN source       text NOT NULL DEFAULT 'email'
    CONSTRAINT rfp_recipient_source CHECK (source IN ('directory', 'email', 'asked_to_bid')),
  ADD COLUMN company_name text
    CONSTRAINT rfp_recipient_company_name_len CHECK (company_name IS NULL OR char_length(company_name) BETWEEN 1 AND 160),
  ADD COLUMN created_at   timestamptz NOT NULL DEFAULT now();

-- Before PRD-04 an org_id on an invite meant "a platform organisation picked
-- by the issuer" (or a self-serve apply, which is no longer possible): the
-- closest source is directory. Address-only invites were typed: email.
UPDATE tendering.rfp_recipient SET source = 'directory' WHERE org_id IS NOT NULL;

CREATE INDEX rfp_recipient_org ON tendering.rfp_recipient (org_id) WHERE org_id IS NOT NULL;
CREATE INDEX rfp_recipient_unowned_email ON tendering.rfp_recipient (lower(email)) WHERE org_id IS NULL;

-- 2. Listed replaces "open" ─────────────────────────────────────────────────
ALTER TABLE tendering.rfp
  ADD COLUMN listed          boolean NOT NULL DEFAULT false,
  ADD COLUMN specialty_codes text[]  NOT NULL DEFAULT '{}';

UPDATE tendering.rfp SET listed = true WHERE visibility = 'open';

UPDATE tendering.rfp r
   SET specialty_codes = coalesce((
         SELECT array_agg(DISTINCT t.specialty_code ORDER BY t.specialty_code)
           FROM tendering.rfp_package_row pr
           JOIN planning.task t ON t.id = pr.task_id
          WHERE pr.rfp_id = r.id AND pr.package_version = r.package_version
            AND t.specialty_code IS NOT NULL), '{}');

-- The deprecated column follows `listed`; a writer that only knows
-- `visibility` (the pre-PRD-04 contract) still lands on the same meaning.
CREATE FUNCTION tendering.rfp_sync_listed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.listed := NEW.listed OR NEW.visibility = 'open';
  ELSIF NEW.listed IS DISTINCT FROM OLD.listed THEN
    NULL; -- listed wins
  ELSIF NEW.visibility IS DISTINCT FROM OLD.visibility THEN
    NEW.listed := NEW.visibility = 'open';
  END IF;
  NEW.visibility := CASE WHEN NEW.listed THEN 'open' ELSE 'invite_only' END;
  RETURN NEW;
END $$;

CREATE TRIGGER rfp_sync_listed BEFORE INSERT OR UPDATE OF listed, visibility ON tendering.rfp
  FOR EACH ROW EXECUTE FUNCTION tendering.rfp_sync_listed();

ALTER TABLE tendering.rfp
  ADD CONSTRAINT rfp_listed_is_open CHECK (listed = (visibility = 'open'));

CREATE INDEX rfp_listed_published ON tendering.rfp (submission_deadline) WHERE listed AND status = 'published';

-- 3. Requests to bid ────────────────────────────────────────────────────────
CREATE TABLE tendering.bid_request (
  id                     uuid PRIMARY KEY,
  rfp_id                 uuid NOT NULL REFERENCES tendering.rfp(id),
  org_id                 uuid NOT NULL,
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  requested_by_person_id uuid NOT NULL,
  requested_at           timestamptz NOT NULL DEFAULT now(),
  decided_by_person_id   uuid,
  decided_at             timestamptz,
  recipient_id           uuid REFERENCES tendering.rfp_recipient(id),
  UNIQUE (rfp_id, org_id),
  CONSTRAINT bid_request_decided CHECK ((status = 'pending') = (decided_at IS NULL)
                                        AND (status = 'pending') = (decided_by_person_id IS NULL)),
  CONSTRAINT bid_request_lane CHECK ((status = 'approved') = (recipient_id IS NOT NULL))
);
CREATE INDEX bid_request_org ON tendering.bid_request (org_id);
