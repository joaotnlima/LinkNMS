-- LinkNMS waitlist — initial schema (LINA-34).
-- Source of truth for the {verified}/150 count; email_norm unique enforces dedupe.
CREATE TABLE IF NOT EXISTS "signups" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email"         text NOT NULL,
  "email_norm"    text NOT NULL,
  "role"          text,
  "locale"        text NOT NULL DEFAULT 'pt',
  "source"        text NOT NULL DEFAULT 'organic',
  "status"        text NOT NULL DEFAULT 'unconfirmed',
  "confirm_token" text,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "confirmed_at"  timestamptz,
  CONSTRAINT "signups_email_norm_unique" UNIQUE ("email_norm")
);

CREATE INDEX IF NOT EXISTS "signups_status_idx" ON "signups" ("status");
CREATE INDEX IF NOT EXISTS "signups_locale_idx" ON "signups" ("locale");
CREATE INDEX IF NOT EXISTS "signups_source_idx" ON "signups" ("source");
CREATE INDEX IF NOT EXISTS "signups_token_idx" ON "signups" ("confirm_token");
