// MailSender adapters (LINA-412) — flag selection and the token-safe log line.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMailSender, createNoopMailSender, createLogMailSender,
  createCapturingMailSender, createResendMailSender,
} from './mail-sender.mjs';

const TOKEN = 'a'.repeat(64);
const MESSAGE = {
  to: 'bidder@example.pt',
  subject: 'Convite para proposta — X',
  html: `<a href="https://portal.linknms.com/rfp/${TOKEN}">open</a>`,
  text: `link: https://portal.linknms.com/rfp/${TOKEN}`,
};

describe('createMailSender — flag selection', () => {
  test('defaults to noop, returns a synthetic id, sends nothing', async () => {
    const s = createMailSender({ provider: undefined });
    assert.equal(s.provider, 'noop');
    const { id } = await s.send(MESSAGE);
    assert.match(id, /^noop-/);
  });

  test('provider=log selects the log adapter', () => {
    assert.equal(createMailSender({ provider: 'log', logger: { info() {} } }).provider, 'log');
  });

  test('provider=resend selects the resend adapter when a key is present', () => {
    const s = createMailSender({ provider: 'resend', env: { RESEND_API_KEY: 'k' }, fetchImpl: async () => {} });
    assert.equal(s.provider, 'resend');
  });

  test('provider=resend fails closed (loudly) when RESEND_API_KEY is absent', () => {
    assert.throws(() => createMailSender({ provider: 'resend', env: {} }), /RESEND_API_KEY is not set/);
  });

  test('env gate: defaults to resend when RESEND_API_KEY is present and no flag set', () => {
    const saved = process.env.RESEND_API_KEY;
    const savedT = process.env.TENDERING_MAIL_PROVIDER;
    const savedM = process.env.MAIL_PROVIDER;
    try {
      delete process.env.TENDERING_MAIL_PROVIDER;
      delete process.env.MAIL_PROVIDER;
      process.env.RESEND_API_KEY = 'k';
      assert.equal(createMailSender({ fetchImpl: async () => {} }).provider, 'resend');
    } finally {
      if (saved === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = saved;
      if (savedT !== undefined) process.env.TENDERING_MAIL_PROVIDER = savedT;
      if (savedM !== undefined) process.env.MAIL_PROVIDER = savedM;
    }
  });

  test('a genuinely unknown provider is a loud config error, never a silent no-op', () => {
    assert.throws(() => createMailSender({ provider: 'mailgun' }), /unknown mail provider/);
  });
});

describe('resend adapter — delegates to the shared sender, token never leaks on failure', () => {
  const env = { RESEND_API_KEY: 'test-key', TENDERING_MAIL_FROM: 'LinkNMS <tender@linknms.com>' };

  test('posts to Resend with the invite from-address and returns the message id', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, async json() { return { id: 'resend-123' }; } };
    };
    const s = createResendMailSender({ env, fetchImpl });
    const { id } = await s.send(MESSAGE);
    assert.equal(id, 'resend-123');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /api\.resend\.com/);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.from, env.TENDERING_MAIL_FROM);
    assert.equal(body.to, MESSAGE.to);
    assert.ok(body.html.includes(TOKEN), 'the token rides in the body, as intended');
  });

  test('a provider rejection throws WITHOUT the token-bearing body in the error', async () => {
    const fetchImpl = async () => ({ ok: false, status: 422, async json() { return {}; } });
    const s = createResendMailSender({ env, fetchImpl });
    await assert.rejects(s.send(MESSAGE), (err) => {
      const msg = String(err?.message ?? err);
      assert.ok(!msg.includes(TOKEN), 'the token must never appear in an error message');
      assert.ok(!msg.includes('/rfp/'), 'the secure link must never appear in an error message');
      return true;
    });
  });
});

describe('log adapter — the token NEVER reaches the log', () => {
  test('logs only to/subject/id; never html/text/headers', async () => {
    const lines = [];
    const logger = { info: (...args) => lines.push(args) };
    const s = createLogMailSender({ logger });
    const { id } = await s.send(MESSAGE);

    const serialized = JSON.stringify(lines);
    assert.ok(!serialized.includes(TOKEN), 'the token must never appear in a log line');
    assert.ok(!serialized.includes('/rfp/'), 'the secure link must never appear in a log line');
    // But the safe breadcrumb is there.
    assert.ok(serialized.includes(MESSAGE.to));
    assert.ok(serialized.includes(id));
  });
});

describe('test doubles', () => {
  test('noop send resolves with an id', async () => {
    assert.match((await createNoopMailSender().send(MESSAGE)).id, /^noop-/);
  });

  test('capturing double records every message', async () => {
    const s = createCapturingMailSender();
    await s.send(MESSAGE);
    assert.equal(s.sent.length, 1);
    assert.equal(s.sent[0].to, MESSAGE.to);
    assert.ok(s.sent[0].html.includes(TOKEN));
  });
});
