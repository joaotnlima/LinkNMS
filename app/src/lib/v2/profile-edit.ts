// The onboarding PROFILE-WRITE field mapping (LINA-385, Phase 12b.6 — the
// account-setup half of the v1→v2 cutover) — the PURE half, kept free of
// `server-only`/`./client` so it is unit-testable without a Clerk session (same
// split as `org-provision.ts` ↔ `org.ts`). The I/O wrapper that PUTs lives in
// `./profile-write.ts`.
//
// ── WHAT THIS PINS DOWN ───────────────────────────────────────────────────────
// The v1 account-setup screen POSTed `{ displayName, role, language }` to
// `/api/v1/me/profile`. On v2 those three land in TWO places, by design:
//   • role         → the v2 org KIND, set at `POST /organizations` (org.ts).
//                     v2 has no per-person role column (doc 16), so role never
//                     travels on the profile write.
//   • displayName  → the person's `name`   (identity.person, self-service edit)
//   • language     → the person's `locale` (identity.person)
// This module owns only the second pair — the `PUT /me/profile` body.
//
// ── THE language → locale MAPPING ─────────────────────────────────────────────
// The screen speaks a 2-letter `language` (en/pt/es); the v2 person `locale`
// enum is `pt-PT | en | es` (db/v2/0001, openapi `Person`). Portuguese is the one
// that widens (`pt` → `pt-PT`); en/es are identity. This is the single place that
// translation lives so a drift is reviewable in one diff.

/** The 2-letter language the onboarding screen offers. */
export type Language = 'en' | 'pt' | 'es';

/** The v2 person `locale` enum, exactly as openapi `Person` / db/v2/0001 accept. */
export type Locale = 'pt-PT' | 'en' | 'es';

/** The onboarding inputs to the profile write, pre-translation. */
export interface ProfileEditInput {
  /**
   * How the person named themselves on the record → the person `name`.
   * Required; trimmed. A blank value is a programmer error here (the form must
   * validate first) and throws.
   */
  displayName: string;
  /** The language the person picked → the person `locale`. */
  language: Language;
}

/** The `PUT /me/profile` wire body, exactly the two fields the endpoint accepts. */
export interface ProfileUpdateBody {
  name: string;
  locale: Locale;
}

const LOCALE_FOR_LANGUAGE: Record<Language, Locale> = {
  en: 'en',
  pt: 'pt-PT',
  es: 'es',
};

/** The onboarding language → v2 person locale mapping. */
export function localeForLanguage(language: Language): Locale {
  return LOCALE_FOR_LANGUAGE[language];
}

/**
 * Pure onboarding-input → `PUT /me/profile` body. Throws on a blank display
 * name: it is required by the endpoint and the form is expected to have
 * validated it, so reaching here blank is a defect, not a user error to render.
 */
export function toProfileUpdateBody(input: ProfileEditInput): ProfileUpdateBody {
  const name = input.displayName?.trim();
  if (!name) throw new Error('display name is required');
  return { name, locale: localeForLanguage(input.language) };
}
