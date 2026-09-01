// Shared email sender — unit tests (LINA-76; ADR-0007 §5).
// Proves the fail-closed contract and that the link never lands in a log or the
// return value. Resend is stubbed via an injected fetch — no network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sendEmail, isEmailConfigured } from './sender.mjs';

const MSG = { to: 'dana@example.com', subject: 'hi', html: '<a href="https://x/auth/callback?token=SECRET">go</a>' };

describe('email sender', () => {
  test('isEmailConfigured reflects RESEND_API_KEY', () => {
    assert.equal(isEmailConfigured({}), false);
    assert.equal(isEmailConfigured({ RESEND_API_KEY: 'k' }), true);
  });

  test('FAILS CLOSED with 503 when RESEND_API_KEY is unset — no fetch, no leak', async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({}) }; };
    await assert.rejects(
      () => sendEmail(MSG, { env: {}, fetchImpl }),
      (e) => e.status === 503 && e.code === 'email_unconfigured',
    );
    assert.equal(called, false, 'never attempts delivery when unconfigured');
  });

  test('posts to Resend with a bearer token and the message body', async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return { ok: true, json: async () => ({ id: 're_123' }) };
    };
    const out = await sendEmail(MSG, { env: { RESEND_API_KEY: 'k', RESEND_FROM: 'X <x@y.com>' }, fetchImpl });
    assert.equal(out.id, 're_123');
    assert.equal(captured.url, 'https://api.resend.com/emails');
    assert.equal(captured.init.headers.Authorization, 'Bearer k');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.from, 'X <x@y.com>');
    assert.equal(body.to, MSG.to);
  });

  test('a provider rejection throws 502 and logs only the status (never the body)', async () => {
    const logged = [];
    const orig = console.error;
    console.error = (...a) => logged.push(a);
    try {
      const fetchImpl = async () => ({ ok: false, status: 422, text: async () => 'token=SECRET echoed back' });
      await assert.rejects(
        () => sendEmail(MSG, { env: { RESEND_API_KEY: 'k' }, fetchImpl }),
        (e) => e.status === 502 && e.code === 'email_send_failed',
      );
    } finally {
      console.error = orig;
    }
    const flat = JSON.stringify(logged);
    assert.doesNotMatch(flat, /SECRET/, 'the secret link/token is never logged');
  });
});
