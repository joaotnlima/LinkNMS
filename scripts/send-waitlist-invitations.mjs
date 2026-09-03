#!/usr/bin/env node
// LINA-130 — go-date D-1 activation batch entry point.
//
//   node scripts/send-waitlist-invitations.mjs [--dry-run] [--limit 10]
//
// Thin wrapper over services/identity/clerk-invite-batch.mjs, which does the
// work. It lives in services/ so its `@clerk/backend` / `pg` imports resolve;
// this file only delegates via a file URL. Everything else — env, flags,
// exit codes — is documented on the real batch.
//
// Env required: MIGRATOR_DATABASE_URL (or DATABASE_URL), CLERK_SECRET_KEY,
// CLERK_ORG_ID. Optional: CLERK_ORG_INVITE_ROLE.
//
// Run from the repo root. Use --dry-run first to preview who would go out before
// the owner commits on go-date.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const batchPath = join(here, '..', 'services', 'identity', 'clerk-invite-batch.mjs');
await import(fileURLToPath(new URL(`file://${batchPath}`)));
