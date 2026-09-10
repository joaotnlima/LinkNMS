// Contract tests for plan templates (LINA-241; ADR-0018). These prove, against
// the in-memory store (which seeds the identical system default the migration
// seeds), the four promises the acceptance criteria name:
//   - resolve returns the user default when present, else the system default
//     (user → system ladder; org skipped in v1);
//   - upsert writes the caller's single user default; a second upsert REPLACES
//     it, never creating a 2nd default;
//   - the body validator rejects dates / owners / a 3rd level at the edge;
//   - the acting party is the session, never the body (a forged owner is inert).
// Run: node --test services/schedule/plan-template.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryStore } from './ports.mjs';
import { createPlanTemplateService, validateTemplateBody } from './plan-template.mjs';
import { createScheduleService } from './schedule.mjs';
import { createScheduleHttp } from './http.mjs';
import { PLAN_SKELETON_BODY } from './plan-skeleton.mjs';

const ALICE = 'party-alice';
const BOB = 'party-bob';

function build() {
  const store = createInMemoryStore();
  const planTemplate = createPlanTemplateService({ store });
  // createScheduleHttp requires a `service`; the template surface uses none of it.
  const service = createScheduleService({
    store,
    ledger: { append() {}, currentBudget: () => ({ currentCents: 0 }), getAudit: () => ({ events: [] }) },
    identity: { authorize: () => ({ role: 'counterparty' }), requireMember: () => ({}) },
  });
  const http = createScheduleHttp({ service, planTemplate });
  return { store, planTemplate, http };
}

// A valid names-only body distinct from the seeded skeleton.
const MY_BODY = [
  { name: 'Sitework', tasks: ['Clear', 'Grade'] },
  { name: 'Shell', tasks: ['Frame'] },
];

test('resolve returns the seeded system default when the caller has none', async () => {
  const { planTemplate } = build();
  const out = await planTemplate.resolveDefault(ALICE);
  assert.equal(out.source, 'system');
  assert.deepEqual(out.body, PLAN_SKELETON_BODY);
  assert.equal(out.template.ownerScope, 'system');
  assert.equal(out.template.isDefault, true);
});

test('resolve prefers the caller\'s user default over the system one (user → system ladder)', async () => {
  const { planTemplate } = build();
  await planTemplate.saveDefault(ALICE, { name: 'Mine', body: MY_BODY });
  const out = await planTemplate.resolveDefault(ALICE);
  assert.equal(out.source, 'user');
  assert.deepEqual(out.body, MY_BODY);
  assert.equal(out.template.name, 'Mine');
});

test('one user default per caller — a second save replaces, never adds a 2nd default', async () => {
  const { store, planTemplate } = build();
  await planTemplate.saveDefault(ALICE, { body: MY_BODY });
  await planTemplate.saveDefault(ALICE, { body: [{ name: 'Redone', tasks: [] }] });
  const userDefaults = store._planTemplates.filter(
    (t) => t.owner_scope === 'user' && t.owner_id === ALICE && t.is_default);
  assert.equal(userDefaults.length, 1);
  const out = await planTemplate.resolveDefault(ALICE);
  assert.deepEqual(out.body, [{ name: 'Redone', tasks: [] }]);
});

test('defaults are per-caller — Bob\'s save does not touch Alice\'s resolve', async () => {
  const { planTemplate } = build();
  await planTemplate.saveDefault(BOB, { body: MY_BODY });
  const alice = await planTemplate.resolveDefault(ALICE);
  assert.equal(alice.source, 'system'); // Alice still gets the system default
});

test('the acting party is the session — a forged owner in the body is inert', async () => {
  const { store, planTemplate } = build();
  // A body/name carrying an ownerId must not re-key the row; owner_id is the actor.
  await planTemplate.saveDefault(ALICE, { name: 'x', body: MY_BODY, ownerId: BOB });
  const row = store._planTemplates.find((t) => t.owner_scope === 'user' && t.is_default);
  assert.equal(row.owner_id, ALICE);
});

test('resolve/save require an authenticated caller (401 without a party)', async () => {
  const { planTemplate } = build();
  await assert.rejects(() => planTemplate.resolveDefault(null), /acting party is required/);
  await assert.rejects(() => planTemplate.saveDefault(null, { body: MY_BODY }), /acting party is required/);
});

// ── Body validation (rejects dates / owners / 3rd level) ─────────────────────

test('validator accepts the names-only two-level shape and trims', () => {
  const clean = validateTemplateBody([{ name: '  A ', tasks: ['  t1 ', 't2'] }]);
  assert.deepEqual(clean, [{ name: 'A', tasks: ['t1', 't2'] }]);
});

test('validator rejects a 3rd level / a task carrying dates or an owner', () => {
  // A task-as-object is the shape a date/owner/sub-task would arrive in.
  assert.throws(() => validateTemplateBody([{ name: 'A', tasks: [{ name: 't', start: '2026-01-01' }] }]),
    /two levels/);
});

test('validator rejects a phase carrying anything beyond { name, tasks }', () => {
  assert.throws(() => validateTemplateBody([{ name: 'A', tasks: [], start: '2026-01-01' }]),
    /names-only/);
  assert.throws(() => validateTemplateBody([{ name: 'A', tasks: [], owner: 'gc' }]),
    /names-only/);
});

test('validator rejects an empty body and empty names', () => {
  assert.throws(() => validateTemplateBody([]), /non-empty array/);
  assert.throws(() => validateTemplateBody([{ name: '', tasks: [] }]), /non-empty name/);
  assert.throws(() => validateTemplateBody([{ name: 'A', tasks: [''] }]), /non-empty name/);
});

// ── HTTP surface ─────────────────────────────────────────────────────────────

test('GET resolve → 200 with the system default; the actor comes from the session', async () => {
  const { http } = build();
  const res = await http.resolvePlanTemplate({ session: { partyId: ALICE } });
  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'system');
});

test('PUT save → 200 then GET resolve returns it; a bad body is a typed 400, not a 500', async () => {
  const { http } = build();
  const saved = await http.savePlanTemplate({ session: { partyId: ALICE }, body: { body: MY_BODY } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.source, 'user');

  const back = await http.resolvePlanTemplate({ session: { partyId: ALICE } });
  assert.deepEqual(back.body.body, MY_BODY);

  const bad = await http.savePlanTemplate({
    session: { partyId: ALICE }, body: { body: [{ name: 'A', tasks: [{ name: 'x' }] }] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'too_deep');
});

test('an unauthenticated caller is a typed 401 envelope, never a 500', async () => {
  const { http } = build();
  const res = await http.resolvePlanTemplate({ session: null });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'unauthenticated');
});
