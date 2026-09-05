// Account setup — POST /me/profile (LINA-189).
//
// The screen this serves had been 404ing since it shipped, so these tests are
// deliberately adversarial about the two things that make the endpoint safe
// rather than merely working: identity comes from the session and nowhere else,
// and the role a user picks is a LABEL, never an entitlement.
//
//   node --test services/identity/profile.test.mjs
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMemoryLedger } from './ledger-port.mjs';
import { createMemoryStore } from './store.mjs';
import { createIdentityService } from './identity.mjs';
import { createIdentityHttp } from './http.mjs';

function setup() {
  const ledger = createMemoryLedger();
  const store = createMemoryStore({ ledger });
  const svc = createIdentityService({ store, ledger });
  const http = createIdentityHttp({ service: svc });
  // The Clerk bridge creates the party row before the setup screen is ever
  // reached (session.ts → findOrCreateByEmail), inventing a display name from
  // the email local part. Mirror that starting state exactly — testing against
  // a party that does not exist would test the wrong branch.
  const partyId = randomUUID();
  store.upsertParty({ id: partyId, displayName: 'joao', email: 'joao@example.com' });
  return { store, svc, http, partyId };
}

const VALID = { displayName: 'João Costa', role: 'owner', language: 'pt' };

async function expectError(promise, status, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.status, status, `expected ${status}, got ${err.status} (${err.message})`);
    if (code) assert.equal(err.code, code);
    return true;
  });
}

describe('completeProfile — the happy path', () => {
  let svc, store, partyId;
  beforeEach(() => ({ svc, store, partyId } = setup()));

  test('writes all three fields and flips setup_complete', async () => {
    const out = await svc.completeProfile({ actorPartyId: partyId, ...VALID });
    assert.deepEqual(out, {
      displayName: 'João Costa', role: 'owner', language: 'pt', setupComplete: true,
    });

    const party = store.getParty(partyId);
    assert.equal(party.displayName, 'João Costa');
    assert.equal(party.language, 'pt');
    assert.equal(party.setupComplete, true);
  });

  test('the product role vocabulary is translated to the party role vocabulary', async () => {
    // The screen says "General contractor"; identity.party's CHECK says
    // 'contractor'. If this ever regresses the write dies on a constraint
    // violation in production and reads as a 500, not a validation error.
    await svc.completeProfile({ actorPartyId: partyId, ...VALID, role: 'general_contractor' });
    assert.equal(store.getParty(partyId).role, 'contractor');
  });

  test('GET /me then reports the setup state, so the portal can stop asking', async () => {
    const before = await svc.getMe({ actorPartyId: partyId });
    assert.equal(before.setupComplete, false);
    assert.equal(before.language, null);

    await svc.completeProfile({ actorPartyId: partyId, ...VALID });

    const after = await svc.getMe({ actorPartyId: partyId });
    assert.equal(after.setupComplete, true);
    assert.equal(after.displayName, 'João Costa');
    assert.equal(after.language, 'pt');
  });
});

describe('completeProfile — identity is the session, never the body', () => {
  let svc, store, partyId;
  beforeEach(() => ({ svc, store, partyId } = setup()));

  test('no acting party is 401, not a write', async () => {
    await expectError(svc.completeProfile(VALID), 401, 'unauthenticated');
  });

  test('a body naming another party cannot touch that party', async () => {
    const victim = randomUUID();
    store.upsertParty({ id: victim, displayName: 'Someone Else', email: 'v@example.com' });

    // Every id-shaped field an attacker might hope is read. None is a parameter.
    await svc.completeProfile({
      actorPartyId: partyId,
      ...VALID,
      displayName: 'Hijacked',
      partyId: victim,
      actorPartyId_: victim,
      id: victim,
    });

    assert.equal(store.getParty(victim).displayName, 'Someone Else');
    assert.equal(store.getParty(victim).setupComplete, false);
    assert.equal(store.getParty(partyId).displayName, 'Hijacked'); // their OWN row, as asked
  });

  test('a live session whose party row is gone is 401, not 404', async () => {
    // 404 would tell the user to give up. 401 makes the client sign out and
    // start over, which is the only thing that can actually recover.
    await expectError(
      svc.completeProfile({ actorPartyId: randomUUID(), ...VALID }),
      401, 'unauthenticated',
    );
  });

  test('choosing "owner" grants no access to any build', async () => {
    await svc.completeProfile({ actorPartyId: partyId, ...VALID, role: 'owner' });
    // A project they are not a member of stays unreachable — the role on the
    // party is a description, and authorization is membership (ADR-0004).
    const other = randomUUID();
    const proj = await svc.createProject({
      actorPartyId: other, name: 'Not Theirs', baselineBudgetCents: 1000,
    });
    await expectError(svc.getProject({ actorPartyId: partyId, projectId: proj.id }), 403);
  });
});

describe('completeProfile — validation', () => {
  let svc, partyId;
  beforeEach(() => ({ svc, partyId } = setup()));

  const bad = [
    ['displayName', { ...VALID, displayName: '   ' }],
    ['displayName', { ...VALID, displayName: undefined }],
    ['displayName', { ...VALID, displayName: 'x'.repeat(201) }],
    ['role', { ...VALID, role: 'viewer' }],       // real party role, not electable
    ['role', { ...VALID, role: 'contractor' }],   // storage vocabulary, not the wire's
    ['role', { ...VALID, role: 'admin' }],
    ['language', { ...VALID, language: 'fr' }],
    ['language', { ...VALID, language: undefined }],
  ];

  for (const [field, input] of bad) {
    test(`rejects ${field} = ${JSON.stringify(input[field])} with a field-scoped 400`, async () => {
      await assert.rejects(
        svc.completeProfile({ actorPartyId: partyId, ...input }),
        (err) => {
          assert.equal(err.status, 400);
          // The field is what lets the screen put the message beside the input.
          assert.equal(err.field, field);
          return true;
        },
      );
    });
  }

  test('the display name is trimmed before it becomes the attribution name', async () => {
    const out = await svc.completeProfile({ actorPartyId: partyId, ...VALID, displayName: '  Ana  ' });
    assert.equal(out.displayName, 'Ana');
  });

  test('a rejected submit leaves the party untouched and setup still pending', async () => {
    const { svc: s, store, partyId: p } = setup();
    await assert.rejects(s.completeProfile({ actorPartyId: p, ...VALID, role: 'nope' }));
    assert.equal(store.getParty(p).setupComplete, false);
    assert.equal(store.getParty(p).displayName, 'joao');
  });
});

describe('completeProfile — idempotence', () => {
  let svc, store, http, partyId;
  beforeEach(() => ({ svc, store, http, partyId } = setup()));

  test('a second submit is 409 and does NOT overwrite the first', async () => {
    await svc.completeProfile({ actorPartyId: partyId, ...VALID });
    await expectError(
      svc.completeProfile({ actorPartyId: partyId, displayName: 'Second', role: 'general_contractor', language: 'en' }),
      409, 'already_setup',
    );
    const party = store.getParty(partyId);
    assert.equal(party.displayName, 'João Costa');
    assert.equal(party.role, 'owner');
    assert.equal(party.language, 'pt');
  });

  test('concurrent first submits settle on exactly one setup', async () => {
    const results = await Promise.allSettled([
      svc.completeProfile({ actorPartyId: partyId, ...VALID, displayName: 'A' }),
      svc.completeProfile({ actorPartyId: partyId, ...VALID, displayName: 'B' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const conflicts = results.filter((r) => r.status === 'rejected' && r.reason.status === 409);
    assert.equal(ok.length, 1);
    assert.equal(conflicts.length, 1);
    assert.equal(store.getParty(partyId).setupComplete, true);
  });
});

describe('completeProfile — HTTP shape (the contract the screen is coded against)', () => {
  let http, partyId;
  beforeEach(() => ({ http, partyId } = setup()));

  const session = (id) => ({ partyId: id });

  test('200 carries { profile } and never lands in a shared cache', async () => {
    const res = await http.completeProfile({ session: session(partyId), body: VALID });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      profile: { displayName: 'João Costa', role: 'owner', language: 'pt', setupComplete: true },
    });
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  test('400 names the field, so the message lands beside the input', async () => {
    const res = await http.completeProfile({
      session: session(partyId), body: { ...VALID, displayName: '' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.field, 'displayName');
    assert.ok(res.body.error.message);
  });

  test('no session is 401 with a typed code', async () => {
    const res = await http.completeProfile({ session: null, body: VALID });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'unauthenticated');
  });

  test('a missing body is a 400, not a crash', async () => {
    // handle() turns unparseable JSON into `undefined` rather than throwing.
    const res = await http.completeProfile({ session: session(partyId), body: undefined });
    assert.equal(res.status, 400);
  });

  test('the repeat submit is 409 already_setup — the client reads it as success', async () => {
    await http.completeProfile({ session: session(partyId), body: VALID });
    const res = await http.completeProfile({ session: session(partyId), body: VALID });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'already_setup');
  });

  test('errors that are not field errors still carry no `field` key', async () => {
    const res = await http.completeProfile({ session: null, body: VALID });
    assert.ok(!('field' in res.body.error));
  });
});
