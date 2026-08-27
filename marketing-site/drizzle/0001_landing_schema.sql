-- LINA-34 — move the waitlist into its own `landing` schema and leave `public`
-- empty, add a `referrer` column, and backfill the `role` column from localized
-- display labels to stable, language-independent enum keys.
--
-- Safe to run once against a database whose only waitlist table is public.signups.
-- After this, the app (Drizzle) reads/writes landing.signups exclusively.

CREATE SCHEMA IF NOT EXISTS "landing";

CREATE TABLE IF NOT EXISTS "landing"."signups" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email"         text NOT NULL,
  "email_norm"    text NOT NULL,
  "role"          text,
  "locale"        text NOT NULL DEFAULT 'pt',
  "source"        text NOT NULL DEFAULT 'organic',
  "referrer"      text,
  "status"        text NOT NULL DEFAULT 'unconfirmed',
  "confirm_token" text,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "confirmed_at"  timestamptz,
  CONSTRAINT "signups_email_norm_unique" UNIQUE ("email_norm")
);

CREATE INDEX IF NOT EXISTS "signups_status_idx" ON "landing"."signups" ("status");
CREATE INDEX IF NOT EXISTS "signups_locale_idx" ON "landing"."signups" ("locale");
CREATE INDEX IF NOT EXISTS "signups_source_idx" ON "landing"."signups" ("source");
CREATE INDEX IF NOT EXISTS "signups_token_idx" ON "landing"."signups" ("confirm_token");

-- Migrate any existing rows from public.signups, mapping the old localized role
-- labels (pt-PT / EN / es-ES) onto the canonical keys. Unknown/NULL roles pass
-- through as NULL. ON CONFLICT keeps this idempotent on email_norm.
INSERT INTO "landing"."signups"
  ("id","email","email_norm","role","locale","source","referrer","status","confirm_token","created_at","confirmed_at")
SELECT
  s."id", s."email", s."email_norm",
  CASE s."role"
    WHEN 'Dono de obra'                  THEN 'homeowner'
    WHEN 'Homeowner running a build'     THEN 'homeowner'
    WHEN 'Propietario de una obra'       THEN 'homeowner'
    WHEN 'Empreiteiro / construtor'      THEN 'contractor'
    WHEN 'Contractor / builder'          THEN 'contractor'
    WHEN 'Contratista / constructor'     THEN 'contractor'
    WHEN 'Especialidade / subcontratado' THEN 'subcontractor'
    WHEN 'Specialty / subcontractor'     THEN 'subcontractor'
    WHEN 'Especialidad / subcontratista' THEN 'subcontractor'
    WHEN 'Arquiteto'                     THEN 'architect'
    WHEN 'Architect'                     THEN 'architect'
    WHEN 'Arquitecto'                    THEN 'architect'
    WHEN 'Diretor de obra'               THEN 'site_manager'
    WHEN 'Site manager'                  THEN 'site_manager'
    WHEN 'Jefe de obra'                  THEN 'site_manager'
    WHEN 'Outro'                         THEN 'other'
    WHEN 'Other'                         THEN 'other'
    WHEN 'Otro'                          THEN 'other'
    ELSE NULL
  END,
  s."locale", s."source", NULL, s."status", s."confirm_token", s."created_at", s."confirmed_at"
FROM "public"."signups" s
ON CONFLICT ("email_norm") DO NOTHING;

-- public is now empty for this project.
DROP TABLE IF EXISTS "public"."signups";
