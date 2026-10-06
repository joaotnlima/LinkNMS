// MailSender adapters (LINA-412) — flag selection and the token-safe log line.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMailSender, createNoopMailSender, createLogMailSender, createCapturingMailSender,
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

  test('an unknown provider is a loud config error, never a silent no-op', () => {
    assert.throws(() => createMailSender({ provider: 'resend' }), /unknown mail provider/);
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
