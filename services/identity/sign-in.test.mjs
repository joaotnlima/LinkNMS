// Magic-link sign-in — adversarial unit tests (LINA-76; ADR-0007).
//
// Pure, zero-I/O: the service runs against the in-memory sign-in store, a fake
// parties port, and a fake sender. Every ADR-0007 invariant that does not need a
// real database is proven here; pg-sign-in.test.mjs proves the DB-level atomicity
// and the full request→consume→session path against a throwaway Neon branch.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSignInService, safeNext, buildLink, RATE_DEFAULT } from './sign-in.mjs';
import { createMemorySignInStore } from './sign-in-store.mjs';

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

function fakeParties() {
  const byEmail = new Map();
  const byId = new Map();
  let seq = 0;
  return {
    byId,
    async findOrCreateByEmail({ email, displayName, role }) {
      const clean = String(email).trim().toLowerCase();
      if (byEmail.has(clean)) return byEmail.get(clean);
      const p = { id: `party-${++seq}`, email: clean, displayName: displayName || clean.split('@')[0], role };
      byEmail.set(clean, p);
      byId.set(p.id, p);
      return p;
    },
    async getById(id) {
      return byId.get(id) ?? null;
    },
  };
}

function fakeSender({ configured = true } = {}) {
  const sent = [];
  return {
    sent,
    isConfigured: () => configured,
    async send(msg) {
      sent.push(msg);
      return { id: 'msg-1' };
    },
  };
}

// Deterministic ids that also record every raw token minted, so a test can spend
// the exact raw token the service just emailed (proving only its hash was stored).
function recordingIds() {
  const tokens = [];
  let n = 0;
  return {
    tokens,
    uuid: () => `id-${++n}`,
    token: () => {
      const t = `rawtok-${tokens.length}`;
      tokens.push(t);
      return t;
    },
  };
}

function mutableClock(startMs) {
  let t = startMs;
  return { now: () => new Date(t), advance: (ms) => { t += ms; } };
}

const BASE = 'https://app.linknms.com';
const START = Date.parse('2026-08-29T12:00:00.000Z');

function build(overrides = {}) {
  const store = overrides.store ?? createMemorySignInStore();
  const parties = overrides.parties ?? fakeParties();
  const sender = overrides.sender ?? fakeSender();
  const ids = overrides.ids ?? recordingIds();
  const clock = overrides.clock ?? mutableClock(START);
  const svc = createSignInService({ store, parties, sender, ids, clock, env: {}, ...overrides.opts });
  return { svc, store, parties, sender, ids, clock };
}

describe('sign-in — request (mint + email)', () => {
  test('fails closed with 503 when email delivery is unconfigured (ADR §5)', async () => {
    const { svc, sender } = build({ sender: fakeSender({ configured: false }) });
    await assert.rejects(
      () => svc.request({ email: 'dana@example.com', baseUrl: BASE }),
      (e) => e.status === 503 && e.code === 'email_unconfigured',
    );
    assert.equal(sender.sent.length, 0, 'nothing is sent when unconfigured');
  });

  test('known and unknown emails are indistinguishable — both mint + send (ADR §4)', async () => {
    const parties = fakeParties();
    await parties.findOrCreateByEmail({ email: 'known@example.com', role: 'contractor' }); // pre-existing party
    const { svc, sender } = build({ parties });

    await svc.request({ email: 'known@example.com', baseUrl: BASE });
    await svc.request({ email: 'stranger@example.com', baseUrl: BASE });

    assert.equal(sender.sent.length, 2, 'both send exactly one email');
    assert.equal(sender.sent[0].subject, sender.sent[1].subject, 'same subject either way');
    // The request path never consults parties, so it cannot branch on membership.
    assert.equal(parties.byId.size, 1, 'no party is created (or revealed) by /request');
  });

  test('a malformed address is a silent 202 no-op — nothing minted or sent', async () => {
    const { svc, sender, store } = build();
    await svc.request({ email: 'not-an-email', baseUrl: BASE });
    await svc.request({ email: '', baseUrl: BASE });
    await svc.request({ baseUrl: BASE });
    assert.equal(sender.sent.length, 0);
    // No token was stored, so a would-be consume of anything finds nothing.
    assert.equal(await store.consumeToken(sha256Hex('whatever'), new Date(START).toISOString()), null);
  });

  test('the raw token is never persisted — only its hash is (ADR §1)', async () => {
    const { svc, ids, store, sender } = build();
    await svc.request({ email: 'dana@example.com', baseUrl: BASE });
    const raw = ids.tokens.at(-1);
    // The emailed link carries the raw token...
    assert.match(sender.sent[0].html, new RegExp(raw));
    // ...and the store accepts ONLY its hash: spending the raw works, meaning the
    // service hashed before storing (a stored raw would never match sha256(raw)).
    const spent = await store.consumeToken(sha256Hex(raw), new Date(START).toISOString());
    assert.ok(spent, 'sha256(raw) is what the row was keyed by');
  });

  test('rate limit per email: the 6th request in the window is dropped (ADR §4)', async () => {
    const { svc, sender } = build();
    for (let i = 0; i < RATE_DEFAULT.max; i++) {
      await svc.request({ email: 'dana@example.com', ip: '1.1.1.1', baseUrl: BASE });
    }
    assert.equal(sender.sent.length, 5);
    await svc.request({ email: 'dana@example.com', ip: '1.1.1.1', baseUrl: BASE }); // 6th
    assert.equal(sender.sent.length, 5, 'over-limit email is silently dropped, still 202');
  });

  test('rate limit per IP: distinct emails from one IP are capped (ADR §4)', async () => {
    const { svc, sender } = build();
    for (let i = 0; i < RATE_DEFAULT.max; i++) {
      await svc.request({ email: `u${i}@example.com`, ip: '9.9.9.9', baseUrl: BASE });
    }
    assert.equal(sender.sent.length, 5);
    await svc.request({ email: 'fresh@example.com', ip: '9.9.9.9', baseUrl: BASE }); // 6th from same IP
    assert.equal(sender.sent.length, 5, 'over-limit IP is silently dropped');
    // A different IP is unaffected.
    await svc.request({ email: 'fresh@example.com', ip: '2.2.2.2', baseUrl: BASE });
    assert.equal(sender.sent.length, 6);
  });
});

describe('sign-in — consume (verify + find-or-create)', () => {
  async function mintFor(email, ctx) {
    await ctx.svc.request({ email, baseUrl: BASE });
    return ctx.ids.tokens.at(-1);
  }

  test('happy path: consuming a fresh token finds-or-creates the party', async () => {
    const ctx = build();
    const raw = await mintFor('dana@example.com', ctx);
    const { party } = await ctx.svc.consume({ token: raw });
    assert.equal(party.email, 'dana@example.com');
    assert.ok(party.id);
    // A returning signer resolves to the SAME party (upsert on email), not a dup.
    const raw2 = await mintFor('dana@example.com', ctx);
    const again = await ctx.svc.consume({ token: raw2 });
    assert.equal(again.party.id, party.id);
  });

  test('an already-consumed token → 400 invalid_token (single use, ADR §1)', async () => {
    const ctx = build();
    const raw = await mintFor('dana@example.com', ctx);
    await ctx.svc.consume({ token: raw });
    await assert.rejects(() => ctx.svc.consume({ token: raw }), (e) => e.status === 400 && e.code === 'invalid_token');
  });

  test('an expired token → 400 invalid_token (ADR §1)', async () => {
    const ctx = build();
    const raw = await mintFor('dana@example.com', ctx);
    ctx.clock.advance(16 * 60 * 1000); // past the 15-minute TTL
    await assert.rejects(() => ctx.svc.consume({ token: raw }), (e) => e.code === 'invalid_token');
  });

  test('an unknown / malformed token → the SAME 400 invalid_token (ADR §4)', async () => {
    const ctx = build();
    for (const bad of ['never-minted', '', null, undefined, 42]) {
      await assert.rejects(() => ctx.svc.consume({ token: bad }), (e) => e.status === 400 && e.code === 'invalid_token');
    }
  });

  test('DOUBLE-CONSUME RACE: two concurrent consumes of one link → exactly one session (ADR §1)', async () => {
    const ctx = build();
    const raw = await mintFor('dana@example.com', ctx);
    const results = await Promise.allSettled([ctx.svc.consume({ token: raw }), ctx.svc.consume({ token: raw })]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1, 'exactly one consume wins');
    assert.equal(failed.length, 1, 'the other is rejected');
    assert.equal(failed[0].reason.code, 'invalid_token');
    assert.equal(ctx.parties.byId.size, 1, 'exactly one party — one session, not two');
  });
});

describe('sign-in — redirect safety', () => {
  test('safeNext only honours same-origin relative paths', () => {
    assert.equal(safeNext('/projects/abc'), '/projects/abc');
    assert.equal(safeNext('//evil.com'), '/');
    assert.equal(safeNext('https://evil.com'), '/');
    assert.equal(safeNext('javascript:alert(1)'), '/');
    assert.equal(safeNext(undefined), '/');
  });

  test('buildLink embeds only a safe next and points at the callback', () => {
    assert.match(buildLink(BASE, 'RAW', '/invitations/accept?token=x'), /\/auth\/callback\?token=RAW&next=/);
    // A hostile next is dropped, not embedded.
    const link = buildLink(BASE, 'RAW', 'https://evil.com');
    assert.match(link, /\/auth\/callback\?token=RAW$/);
  });
});
