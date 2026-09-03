#!/usr/bin/env node
// Seat administration — the process for onboarding the first ten (LINA-75; ADR-0008).
//
//   node scripts/grant-seat.mjs list
//   node scripts/grant-seat.mjs grant <email> [--note "Ana, GC at Oak Lane"] [--source beta|invite]
//   node scripts/grant-seat.mjs revoke <email>
//
// A seat is what lets an address onto the record at all. Since LINA-124 the
// front door is Clerk, and the gate it feeds is app/src/server/session.ts →
// services/identity/seats.mjs: a Clerk account with no active seat here is
// authenticated but never becomes a party. Ten seats are given away by hand, so
// the "admin UI" for that is this file — a screen would be more code than the
// thing it administers, and every grant is a deliberate, logged act by a human.
//
// It connects as the MIGRATOR, not as identity_app, on purpose: identity_app
// holds SELECT and nothing else on identity.seat (0004_identity.sql), so the
// running application cannot seat anybody even if the request path is exploited.
// Issuing seats is an out-of-band administrative action, and this is the band.
//
// Uses `psql` and zero npm dependencies, exactly like db/migrate.mjs, so it runs
// anywhere the migration runner runs.
//
// WHEN STRIPE ARRIVES: this script does not grow a payment branch. The billing
// webhook inserts `source='stripe'` rows against the same table under its own
// role, and the auth path — which only ever asks "is there an active seat" —
// stays byte-for-byte identical. That separation is the whole reason seats are
// a table rather than a flag on identity.party.

import { execFileSync } from 'node:child_process';

const DB_URL = process.env.MIGRATOR_DATABASE_URL || process.env.DATABASE_URL || '';
if (!DB_URL) {
  console.error('error: set MIGRATOR_DATABASE_URL (or DATABASE_URL) to the migrator connection string.');
  console.error('note: use the DIRECT Neon endpoint, not -pooler (see the SET ROLE / pooler finding).');
  process.exit(1);
}

// Same normalisation as services/identity/email-normalize.mjs normalizeEmail, so
// a seat granted here is a seat the gate will actually match. Kept deliberately
// shallow, and deliberately duplicated: this script has zero npm dependencies
// and must run anywhere psql does.
function normalizeEmail(email) {
  const clean = typeof email === 'string' ? email.trim().toLowerCase() : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) ? clean : null;
}

// Parameters go through psql's own `:'name'` binding, which quotes and escapes
// them as literals — never string concatenation into the SQL text.
//
// The SQL is fed on STDIN rather than with `-c`: psql only performs variable
// interpolation on script input, so `-c` would pass `:'email'` through to the
// server verbatim and fail with a syntax error.
function psql(sql, params = {}) {
  const args = [DB_URL, '-X', '-q', '-A', '-t', '--csv', '-v', 'ON_ERROR_STOP=1'];
  for (const [k, v] of Object.entries(params)) args.push('-v', `${k}=${v}`);
  try {
    return execFileSync('psql', [...args, '-f', '-'], { encoding: 'utf8', input: sql }).trim();
  } catch (err) {
    // execFileSync's message embeds the whole argv — which includes the
    // connection string, password and all. Re-throw with only what psql said.
    const detail = String(err.stderr || '').trim() || 'psql failed';
    throw new Error(detail);
  }
}

const [, , cmd, emailArg] = process.argv;
const flag = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};

function requireEmail() {
  const email = normalizeEmail(emailArg);
  if (!email) {
    console.error(`error: "${emailArg ?? ''}" is not a well-formed email address.`);
    process.exit(1);
  }
  return email;
}

switch (cmd) {
  case 'list': {
    const out = psql(
      `select email, source, status, coalesce(note,''), granted_at
         from identity.seat order by granted_at`,
    );
    const rows = out ? out.split('\n') : [];
    const active = rows.filter((r) => r.split(',')[2] === 'active');
    console.log(out || '(no seats granted yet)');
    console.log(`\n${active.length} active seat(s), ${rows.length} total.`);
    // The ten free seats are a business commitment, so make the count loud
    // rather than something someone has to work out from the list.
    const beta = active.filter((r) => r.split(',')[1] === 'beta').length;
    console.log(`beta giveaway: ${beta}/10 used, ${Math.max(0, 10 - beta)} remaining.`);
    break;
  }

  case 'grant': {
    const email = requireEmail();
    const source = flag('source') || 'beta';
    if (!['beta', 'invite', 'stripe'].includes(source)) {
      console.error(`error: --source must be beta, invite or stripe (got "${source}").`);
      process.exit(1);
    }
    // Idempotent, and re-granting a revoked seat reinstates it cleanly rather
    // than leaving status and revoked_at inconsistent (the table CHECKs that).
    psql(
      `insert into identity.seat (email, source, note)
         values (:'email', :'source', nullif(:'note',''))
       on conflict (email) do update
         set status = 'active', revoked_at = null,
             source = excluded.source,
             note = coalesce(excluded.note, identity.seat.note)`,
      { email, source, note: flag('note') || '' },
    );
    console.log(`granted: ${email} (source=${source}) — they can now request a sign-in link.`);
    break;
  }

  case 'revoke': {
    const email = requireEmail();
    // Never a DELETE: we keep the record that a seat existed and was withdrawn.
    // Revoking shuts the door on NEW sign-ins; it does not retroactively erase
    // anything this person did — their authorship and approval stamps in the
    // ledger are immutable by design and must stay exactly as they are.
    const n = psql(
      `update identity.seat set status = 'revoked', revoked_at = now()
        where email = :'email' and status = 'active' returning 1`,
      { email },
    );
    console.log(n ? `revoked: ${email}` : `no active seat for ${email} — nothing to do.`);
    break;
  }

  default:
    console.error('usage: grant-seat.mjs list | grant <email> [--note ".."] [--source beta|invite] | revoke <email>');
    process.exit(1);
}
