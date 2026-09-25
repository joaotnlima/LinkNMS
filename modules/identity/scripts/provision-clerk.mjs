// Provision the doc-16 access catalogue into a Clerk instance — idempotent.
//
//   CLERK_SECRET_KEY=sk_test_… node modules/identity/scripts/provision-clerk.mjs [--dry-run]
//
// Creates/updates the custom organisation permissions (§5) and the 7 roles
// (§4) with exactly the permissions the matrix grants. Refuses sk_live_ keys
// unless --live is passed: custom roles in production need the B2B add-on and
// touching the live instance is a founder-visible change, not a side effect.
//
// Role SETS per org kind (household/contractor/consultant) are not a Clerk
// server concept — which roles an org can hand out is enforced by our invite
// UI and the webhook mirror (domain/mirror.mjs rejects roles outside the
// catalogue); Clerk holds the union.
import { ROLES, PERMISSION_MATRIX, PERMISSIONS, permissionsForRole } from '../domain/access.mjs';

const API = 'https://api.clerk.com/v1';
const key = process.env.CLERK_SECRET_KEY;
const dryRun = process.argv.includes('--dry-run');
const allowLive = process.argv.includes('--live');

if (!key) fail('set CLERK_SECRET_KEY');
if (key.startsWith('sk_live_') && !allowLive) {
  fail('refusing to touch a LIVE Clerk instance without --live (doc 16 §2: custom roles in prod need the B2B add-on)');
}

const DESCRIPTIONS = {
  admin: 'Company owner / managing partner; the homeowner',
  manager: 'Project/commercial manager: runs projects, tenders, signs',
  representative: "Client's representative acting for the owner",
  site_lead: 'Site manager / foreman: runs execution, no money',
  finance: 'Accounting: measurements and payments, no plan editing',
  member: 'Crew / staff: reports progress where staffed',
  inspector: 'Independent quality/HSE inspector: verifies and inspects',
};

async function clerk(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function listAll(path) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const page = await clerk('GET', `${path}?limit=100&offset=${offset}`);
    const items = page.data ?? page;
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

const existingPerms = await listAll('/organization_permissions');
const existingRoles = await listAll('/organization_roles');
const permByKey = new Map(existingPerms.map((p) => [p.key, p]));
const roleByKey = new Map(existingRoles.map((r) => [r.key, r]));

// 1. Permissions (§5 rows). Clerk keys them `org:<feature>:<action>` — ours already are.
for (const permission of PERMISSIONS) {
  if (permByKey.has(permission)) { log(`= permission ${permission}`); continue; }
  log(`+ permission ${permission}`);
  if (dryRun) continue;
  const created = await clerk('POST', '/organization_permissions', {
    name: permission.replace(/^org:/, '').replace(/:/g, ' '),
    key: permission,
    description: `doc 16 §5 — held by: ${PERMISSION_MATRIX[permission].join(', ')}`,
  });
  permByKey.set(permission, created);
}

// 2. Roles (§4) with exactly the matrix's permissions.
for (const role of ROLES) {
  const roleKey = `org:${role}`;
  const wanted = permissionsForRole(role);
  const wantedIds = wanted.map((p) => permByKey.get(p)?.id).filter(Boolean);
  const existing = roleByKey.get(roleKey);

  if (!existing) {
    log(`+ role ${roleKey} (${wanted.length} permissions)`);
    if (dryRun) continue;
    await clerk('POST', '/organization_roles', {
      name: role, key: roleKey, description: DESCRIPTIONS[role], permissions: wantedIds,
    });
    continue;
  }

  const currentIds = new Set((existing.permissions ?? []).map((p) => (typeof p === 'string' ? p : p.id)));
  const same = wantedIds.length === currentIds.size && wantedIds.every((id) => currentIds.has(id));
  if (same) { log(`= role ${roleKey}`); continue; }
  log(`~ role ${roleKey} → ${wanted.length} permissions`);
  if (dryRun) continue;
  await clerk('PATCH', `/organization_roles/${existing.id}`, {
    name: role, key: roleKey, description: DESCRIPTIONS[role], permissions: wantedIds,
  });
}

log(dryRun ? 'dry run — nothing written' : 'done');

function log(line) { console.log(line); }
function fail(msg) { console.error(msg); process.exit(1); }
