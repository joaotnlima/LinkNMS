// The invite-email renderer (LINA-412) — pure, DB-free. Proves the secure link
// lands ONLY in the body (never the subject), both variants render, and the
// placeholder export carries no live token.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { renderInviteEmail, PREVIEW_LINK_PLACEHOLDER_TOKEN } from './invite-email.mjs';

const RFP = {
  id: '01930000-0000-7000-8000-000000000001',
  title: 'Canalização — Casa Silva',
  scope_text: 'Tubagem PEX, 3 pisos',
  submission_deadline: '2027-06-01T00:00:00.000Z',
  project_name: 'Casa Silva',
};
const LINK = 'https://portal.linknms.com/rfp/a1b2c3d4e5f6';

describe('renderInviteEmail', () => {
  test('first invite: subject + bodies, link ONLY in the body', () => {
    const { subject, html, text } = renderInviteEmail({ rfp: RFP, linkUrl: LINK });
    assert.match(subject, /Convite para proposta/);
    assert.ok(!subject.includes(LINK), 'the link must never be in the subject');
    assert.ok(html.includes(LINK), 'the link belongs in the html body');
    assert.ok(text.includes(LINK), 'the link belongs in the text body');
    // The RFP facts render.
    assert.ok(text.includes('Canalização — Casa Silva'));
    assert.ok(text.includes('2027-06-01'));
    assert.ok(text.includes('Casa Silva'));
  });

  test('re-issue variant: distinct subject + "atualizado" copy, link still body-only', () => {
    const { subject, html } = renderInviteEmail({ rfp: RFP, linkUrl: LINK, reissue: true });
    assert.match(subject, /atualizado/i);
    assert.ok(!subject.includes(LINK));
    assert.ok(html.includes(LINK));
  });

  test('escapes issuer-authored strings in the html', () => {
    const { html } = renderInviteEmail({
      rfp: { ...RFP, title: 'A & <b>B</b>' }, linkUrl: LINK,
    });
    assert.ok(html.includes('A &amp; &lt;b&gt;B&lt;/b&gt;'));
    assert.ok(!html.includes('<b>B</b>'));
  });

  test('tolerates a sparse RFP (no scope/deadline/project)', () => {
    const { subject, text } = renderInviteEmail({ rfp: { title: 'X' }, linkUrl: LINK });
    assert.ok(subject.includes('X'));
    assert.ok(text.includes(LINK));
  });

  test('the preview placeholder is a stable, non-secret string', () => {
    assert.equal(typeof PREVIEW_LINK_PLACEHOLDER_TOKEN, 'string');
    // Not a 64-char hash / 32-byte hex token — obviously not a live credential.
    assert.ok(!/^[0-9a-f]{64}$/i.test(PREVIEW_LINK_PLACEHOLDER_TOKEN));
    assert.ok(PREVIEW_LINK_PLACEHOLDER_TOKEN.length < 40);
  });
});
