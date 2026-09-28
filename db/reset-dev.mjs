#!/usr/bin/env node
// LinkNMS dev-database reset — "zero out the data, keep the reference tables"
// (LINA-365 support request).
//
//   node db/reset-dev.mjs [--yes] [--scope=all|schedule] [--wipe-identity]
//                         [--url=<conn>] [--allow-any-host] [--dry-run]
//
// PURPOSE
//   Truncate the transactional/test data so you can re-run flows (build
//   creation, plan authoring, procurement, sign-off, …) from a clean slate,
//   while PRESERVING the reference/catalog tables and the migration ledger. No
//   DDL, no drop — data only. Sequences are RESET (RESTART IDENTITY).
//
// WHAT IS ALWAYS PRESERVED  (never truncated, under any scope)
//   platform.schema_migrations           the forward-only migration ledger
//   platform.holiday                      reference calendar
//   billing.plan, billing.add_on          pricing catalog
//   directory.specialty                   v2 specialty catalog
//   schedule.specialty                    v1 specialty catalog
//   schedule.plan_template                v1 plan templates
//   planning.plan_template(+_row,_link)   v2 plan templates
//   By default the Clerk login mirror is also kept so you stay signed in:
//   identity.organization, identity.person, identity.org_membership
//   Pass --wipe-identity to also clear it (Clerk re-mirrors on next sign-in /
//   webhook) — use for testing onboarding / org-provisioning from scratch.
//
// SCOPE
//   --scope=all       (default) every app schema's data, minus the preserve set
//   --scope=schedule  only the schedule.* schema (the founder's literal ask:
//                     "truncate all schedule tables, leave specialty and
//                     plan_template")
//
// SAFETY (this is DESTRUCTIVE — it is dev-only by construction)
//   1. It REFUSES to run against the production compute endpoint
//      (ep-mute-sky-zaq70b4s), hardcoded — no flag can override that.
//   2. By default it only runs against the known dev endpoint
//      (ep-soft-hall-zacvct6x). Pass --allow-any-host to target another dev/
//      local database (still blocked from prod).
//   3. It does nothing without --yes. Without it (or with --dry-run) it prints
//      the target + the exact table list and exits.
//   4. TRUNCATE runs with RESTART IDENTITY and WITHOUT CASCADE, inside one
//      transaction. No-CASCADE means it can never silently wipe a preserved
//      table via a foreign key — if a kept table ever referenced a cleared one
//      it would abort loudly instead of destroying data.
//
// CONNECTION  DATABASE_URL / MIGRATOR_DATABASE_URL / --url=<conn>. Requires the
// migrator role (owns the tables). Needs `psql` on PATH — same as db/migrate.mjs,
// zero npm dependencies.
import { execFileSync } from 'node:child_process';

// --- config -----------------------------------------------------------------
const APP_SCHEMAS = [
  'schedule', 'project', 'planning', 'contracting', 'tendering',
  'collaboration', 'documents', 'identity', 'directory', 'billing',
  'quality', 'record', 'reputation', 'platform',
];

// Reference / catalog / bookkeeping — kept under every scope.
const PRESERVE_ALWAYS = new Set([
  'platform.schema_migrations',
  'platform.holiday',
  'billing.plan',
  'billing.add_on',
  'directory.specialty',
  'schedule.specialty',
  'schedule.plan_template',
  'planning.plan_template',
  'planning.plan_template_row',
  'planning.plan_template_link',
]);

// Clerk login mirror — kept by default so you stay signed in; --wipe-identity
// clears it (re-mirrored by Clerk on next sign-in / webhook).
const IDENTITY_MIRROR = new Set([
  'identity.organization',
  'identity.person',
  'identity.org_membership',
]);

// Neon compute endpoints. Prod is a hard block; dev is the default allow.
const PROD_ENDPOINT = 'ep-mute-sky-zaq70b4s';
const DEV_ENDPOINT = 'ep-soft-hall-zacvct6x';

// --- args --------------------------------------------------------------------
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`${k}=`));
  return hit ? hit.slice(k.length + 1) : d;
};
const YES = has('--yes') || process.env.RESET_YES === '1';
const DRY_RUN = has('--dry-run') || !YES;
const SCOPE = val('--scope', 'all');
const WIPE_IDENTITY = has('--wipe-identity');
const ALLOW_ANY_HOST = has('--allow-any-host');

if (!['all', 'schedule'].includes(SCOPE)) {
  console.error(`FATAL: --scope must be 'all' or 'schedule' (got '${SCOPE}').`);
  process.exit(2);
}

const DB_URL =
  val('--url', '') ||
  process.env.MIGRATOR_DATABASE_URL ||
  process.env.DATABASE_URL ||
  '';
if (!DB_URL) {
  console.error(
    'FATAL: pass --url=<conn> or set MIGRATOR_DATABASE_URL / DATABASE_URL (migrator role).',
  );
  process.exit(2);
}

// --- endpoint guard ----------------------------------------------------------
// Extract the Neon compute-endpoint id from the host, tolerating the "-pooler"
// suffix (ep-soft-hall-zacvct6x-pooler.… -> ep-soft-hall-zacvct6x).
function endpointId(connString) {
  let host = '';
  try {
    host = new URL(connString).hostname;
  } catch {
    const m = connString.match(/@([^:/?]+)/);
    host = m ? m[1] : connString;
  }
  const label = host.split('.')[0];
  return label.replace(/-pooler$/, '');
}
const ep = endpointId(DB_URL);

if (ep === PROD_ENDPOINT) {
  console.error(
    `FATAL: refusing to run against the PRODUCTION endpoint (${PROD_ENDPOINT}).\n` +
      'This script is dev-only and will never truncate production data.',
  );
  process.exit(3);
}
if (ep !== DEV_ENDPOINT && !ALLOW_ANY_HOST) {
  console.error(
    `FATAL: endpoint '${ep}' is not the known dev endpoint (${DEV_ENDPOINT}).\n` +
      'If this is really a dev/local database, re-run with --allow-any-host.',
  );
  process.exit(3);
}

// --- psql helpers ------------------------------------------------------------
function psql(args, input) {
  return execFileSync('psql', [DB_URL, '-v', 'ON_ERROR_STOP=1', ...args], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}
function rows(sql) {
  return psql(['-tA', '-c', sql])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

// --- build the clear-list ----------------------------------------------------
const schemaFilter =
  SCOPE === 'schedule'
    ? `table_schema = 'schedule'`
    : `table_schema IN (${APP_SCHEMAS.map((s) => `'${s}'`).join(',')})`;

const allTables = rows(
  `SELECT table_schema||'.'||table_name FROM information_schema.tables ` +
    `WHERE table_type='BASE TABLE' AND ${schemaFilter} ORDER BY 1;`,
);

const preserve = new Set(PRESERVE_ALWAYS);
if (!WIPE_IDENTITY) for (const t of IDENTITY_MIRROR) preserve.add(t);

const clearList = allTables.filter((t) => !preserve.has(t));

// --- report ------------------------------------------------------------------
console.log('LinkNMS dev reset');
console.log(`  target endpoint : ${ep}`);
console.log(`  scope           : ${SCOPE}`);
console.log(`  identity mirror : ${WIPE_IDENTITY ? 'WIPE' : 'keep (stay signed in)'}`);
console.log(`  tables to clear : ${clearList.length}`);
console.log(`  tables kept     : ${allTables.length - clearList.length}`);
console.log('  preserved:');
for (const t of allTables.filter((t) => preserve.has(t))) console.log(`     • ${t}`);

if (clearList.length === 0) {
  console.log('\nNothing to truncate. Done.');
  process.exit(0);
}

if (DRY_RUN) {
  console.log('\n-- DRY RUN (no --yes): would TRUNCATE, RESTART IDENTITY --');
  for (const t of clearList) console.log(`     ✗ ${t}`);
  console.log('\nRe-run with --yes to execute.');
  process.exit(0);
}

// --- execute -----------------------------------------------------------------
// One transaction; no CASCADE (see SAFETY note). All referencing tables are in
// the list by construction, so ordering is irrelevant to a single TRUNCATE.
const list = clearList.join(', ');
console.log('\nTruncating…');
psql(
  ['-q'],
  `BEGIN;\nTRUNCATE TABLE ${list} RESTART IDENTITY;\nCOMMIT;\n`,
);
console.log(`Done — ${clearList.length} tables truncated, sequences reset.`);
