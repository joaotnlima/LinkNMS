import { test } from 'node:test';
import assert from 'node:assert/strict';

import { unclaimedNameFor } from './unclaimed.mjs';

test('a company domain names the unclaimed profile (PRD-04 X-2)', () => {
  assert.equal(unclaimedNameFor('obra@empreiteiro-amigo.pt'), 'Empreiteiro Amigo');
  assert.equal(unclaimedNameFor('Geral@Construcoes-Silva.com.pt'), 'Construcoes Silva');
  assert.equal(unclaimedNameFor('vendas@vidralux.example.pt'), 'Example');
});

test('a personal-mail address or a malformed one names nothing — no person is listed', () => {
  assert.equal(unclaimedNameFor('joao.silva@gmail.com'), null);
  assert.equal(unclaimedNameFor('ana@sapo.pt'), null);
  assert.equal(unclaimedNameFor('nope'), null);
  assert.equal(unclaimedNameFor('a@localhost'), null);
});
