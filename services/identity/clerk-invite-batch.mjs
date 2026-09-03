#!/usr/bin/env node
// Identity — the go-date D-1 activation batch (LINA-130; Onboarding Plan v4
// Phase 2).
//
//   node services/identity/clerk-invite-batch.mjs [--dry-run] [--limit 10]
//
// Sends Clerk org invitations to the first `--limit` (default 10) WAITLISTED
// signups ordered by signup_order, then — for each accepted send — grants a beta
// seat (ADR-0008) and flips the waitlist row to `active`. Runs against the
// waitlist/identity schemas as the MIGRATOR (like grant-seat.mjs), because the
// running app must never seat or activate anybody (identity_app and waitlist_app
// hold no DML that does).
//
// REQUIRES (env):
//   MIGRATOR_DATABASE_URL | DATABASE_URL   the migrator connection string (DIRECT,
//                                          not -pooler — see the pooler finding)
//   CLERK_SECRET_KEY                        Clerk Backend API key
//   CLERK_ORG_ID                            the Clerk org to invite into
//   CLERK_ORG_INVITE_ROLE                   optional Clerk org role (default basic_member)
//
// Use --dry-run to preview who WOULD go out without sending a single email.
import { createClerkOrgInviter, sendWaitlistInvitations } from './clerk-invite.mjs';
import { createPgStore as createWaitlistPgStore } from '../waitlist/pg-store.mjs';
import { getPool } from '../ledger/db.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const limitFlag = process.argv.indexOf('--limit');
const LIMIT = limitFlag > -1 ? Number(process.argv[limitFlag + 1]) : 10;

const env = process.env;

function requireDb() {
  const url = env.MIGRATOR_DATABASE_URL || env.DATABASE_URL;
  if (!url) {
    console.error('error: set MIGRATOR_DATABASE_URL (or DATABASE_URL) to the migrator connection string.');
    process.exit(1);
  }
  // The batch calls the waitlist store (SELECT) and the same Postgres the store
  // uses; getPool reads the migrator URL passed below. We connect as migrator so
  // the promotion + activation-record + seat writes are all permitted.
  return { url };
}

function requireClerk(env) {
  const secretKey = env.CLERK_SECRET_KEY;
  const orgId = env.CLERK_ORG_ID;
  if (!secretKey || !orgId) {
    console.error('error: set CLERK_SECRET_KEY and CLERK_ORG_ID to send org invitations.');
    process.exit(1);
  }
  return createClerkOrgInviter({
    secretKey,
    orgId,
    role: env.CLERK_ORG_INVITE_ROLE || 'basic_member',
  });
}

// The seat port — grants an active beta seat, the exact SQL grant-seat.mjs runs
// (ADR-0008 §7: 0004_identity.sql CHECKs status; the app role cannot write it,
// so we run as migrator). Idempotent on conflict, exactly like the CLI.
function seatAdder(pool) {
  return {
    async grant(email, { source = 'beta', note = 'D-1 activation (LINA-130)' } = {}) {
      await pool.query(
        `insert into identity.seat (email, source, note)
           values ($1, $2, $3)
         on conflict (email) do update
           set status = 'active', revoked_at = null,
               source = excluded.source,
               note = coalesce(excluded.note, identity.seat.note)`,
        [email, source, note],
      );
    },
  };
}

async function main() {
  const { url } = requireDb();

  // getPool derives the pool from MIGRATOR_DATABASE_URL|DATABASE_URL.
  process.env.DATABASE_URL = url;
  const pool = getPool();
  const store = createWaitlistPgStore({ pool });
  const inviter = requireClerk(env);

  const started = new Date().toISOString();
  console.log(`LINA-130 D-1 activation batch @ ${started}${DRY_RUN ? ' [DRY-RUN]' : ''}`);
  console.log(`target: first ${LIMIT} waitlisted by signup_order`);

  const { invited, summary } = await sendWaitlistInvitations({
    store,
    seats: seatAdder(pool),
    inviter,
    limit: LIMIT,
    dryRun: DRY_RUN,
  });

  for (const row of invited) {
    console.log(
      `  [${row.outcome.padEnd(7)}] signup#${String(row.signupOrder).padStart(3)} ` +
      `${row.email}${row.clerkInvitationId ? ` invitation=${row.clerkInvitationId}` : ''}` +
      `${row.error ? ` error=${row.error}` : ''}`,
    );
  }

  console.log(
    `summary: ${summary.total} targeted, ${summary.invited} invited, ${summary.failed} failed` +
    `${DRY_RUN ? ' (nothing sent)' : ''}`,
  );

  await pool.end();
  if (summary.failed > 0) {
    console.error('some invitations failed — see per-row errors above.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('fatal:', (err && err.message) || err);
  process.exit(1);
});
