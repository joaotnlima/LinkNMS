// The markup layer (PRD-06) — pure rules: geometry per kind (V-5, V-6), the
// markups-only version a save appends (§5), close/re-open and links (V-8).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateGeometry, validateMarkupSave, markupOnlyVersion, sameMarkup, markupTransition,
  validateMarkupLink, markupBody, MAX_MARKUPS_PER_SAVE,
} from './markup.mjs';

const ID = (n) => `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('geometry per kind', () => {
  test('two points for cloud / arrow / measure / calibration, one for text', () => {
    assert.equal(validateGeometry('cloud', { points: [[0, 0], [10, 5]] }).error, null);
    assert.equal(validateGeometry('arrow', { points: [[0, 0], [10, 5]] }).error, null);
    assert.equal(validateGeometry('measure', { points: [[0, 0], [10, 5]] }).error, null);
    assert.equal(validateGeometry('text', { points: [[3, 4]] }).error, null);
    assert.match(validateGeometry('text', { points: [[3, 4], [5, 6]] }).error, /exactly 1 point/);
    assert.match(validateGeometry('cloud', { points: [[0, 0]] }).error, /exactly 2 points/);
  });

  test('coordinates are finite and bounded; a cloud needs an area; points differ', () => {
    assert.ok(validateGeometry('measure', { points: [[0, 0], [Infinity, 1]] }).error);
    assert.ok(validateGeometry('measure', { points: [[0, 0], ['1', 1]] }).error);
    assert.ok(validateGeometry('measure', { points: [[0, 0], [2e9, 1]] }).error);
    assert.ok(validateGeometry('cloud', { points: [[0, 0], [0, 10]] }).error);
    assert.ok(validateGeometry('arrow', { points: [[1, 1], [1, 1]] }).error);
  });

  test('calibration carries length_mm > 0; nothing else does; extra keys are dropped', () => {
    const ok = validateGeometry('calibration', { points: [[0, 0], [460, 0]], length_mm: 11400, colour: 'red' });
    assert.deepEqual(ok.geometry, { points: [[0, 0], [460, 0]], length_mm: 11400 });
    assert.ok(validateGeometry('calibration', { points: [[0, 0], [460, 0]] }).error);
    assert.ok(validateGeometry('calibration', { points: [[0, 0], [460, 0]], length_mm: 0 }).error);
    assert.ok(validateGeometry('measure', { points: [[0, 0], [460, 0]], length_mm: 5 }).error);
  });
});

describe('saveDocumentMarkups body', () => {
  const good = {
    base_version_no: 2,
    markups: [
      { id: ID(1), page_or_layout: '1', kind: 'cloud', geometry: { points: [[396, 124], [470, 180]] }, text: ' Skylight width ' },
      { id: ID(2), page_or_layout: '1', kind: 'arrow', geometry: { points: [[150, 386], [150, 456]] }, text: 'Downpipe Ø80 → Ø100?' },
      { id: ID(3), page_or_layout: '3', kind: 'calibration', geometry: { points: [[90, 420], [550, 420]], length_mm: 11400 } },
    ],
  };

  test('normalises drafts (trimmed text, page pinned)', () => {
    const { errors, drafts } = validateMarkupSave(good);
    assert.deepEqual(errors, {});
    assert.equal(drafts.length, 3);
    assert.equal(drafts[0].text, 'Skylight width');
    assert.equal(drafts[2].pageOrLayout, '3');
    assert.equal(drafts[2].text, null);
  });

  test('names every bad field by path', () => {
    const { errors } = validateMarkupSave({
      base_version_no: 0,
      markups: [
        { id: 'nope', page_or_layout: '', kind: 'arrow', geometry: { points: [[0, 0], [1, 1]] } },
        { id: ID(1), page_or_layout: '1', kind: 'measure', geometry: { points: [[0, 0], [1, 1]] }, text: 'x' },
        { id: ID(1), page_or_layout: '1', kind: 'stamp', geometry: {} },
      ],
    });
    assert.ok(errors.base_version_no);
    assert.ok(errors['markups[0].id']);
    assert.ok(errors['markups[0].page_or_layout']);
    assert.match(errors['markups[0].text'], /arrow \+ note/);
    assert.match(errors['markups[1].text'], /carries no text/);
    assert.match(errors['markups[2].id'], /duplicate/);
    assert.ok(errors['markups[2].kind']);
  });

  test('1–200 markups per save', () => {
    assert.ok(validateMarkupSave({ base_version_no: 1, markups: [] }).errors.markups);
    const many = Array.from({ length: MAX_MARKUPS_PER_SAVE + 1 }, (_, i) => ({
      id: ID(i + 1), page_or_layout: '1', kind: 'text', geometry: { points: [[1, 1]] }, text: 'x',
    }));
    assert.ok(validateMarkupSave({ base_version_no: 1, markups: many }).errors.markups);
  });
});

describe('the markups-only version (PRD-06 §5)', () => {
  test('re-points the base bytes: same key, mime, size and sha256; labelled with its base', () => {
    const base = { version_no: 2, storage_key: 'v2/documents/d/v2-r/A-301.pdf', mime: 'application/pdf', size_bytes: '2048', sha256: 'c'.repeat(64) };
    assert.deepEqual(markupOnlyVersion(base, { note: '  ' }), {
      storageKey: base.storage_key, mime: 'application/pdf', sizeBytes: 2048, sha256: 'c'.repeat(64),
      baseVersionNo: 2, changeKind: 'markup_only', note: null,
    });
    assert.equal(markupOnlyVersion(base, { note: ' roof review ' }).note, 'roof review');
  });
});

describe('replay, state and links', () => {
  const row = {
    id: ID(1), document_id: 'd', author_org_id: 'o', page_or_layout: '1', kind: 'text',
    geometry: { points: [[1, 2]] }, text: 'x',
  };
  test('a replayed draft is the same markup only with the same author, page, kind, geometry and text', () => {
    const draft = { id: ID(1), pageOrLayout: '1', kind: 'text', geometry: { points: [[1, 2]] }, text: 'x' };
    assert.equal(sameMarkup(row, draft, { documentId: 'd', authorOrgId: 'o' }), true);
    assert.equal(sameMarkup(row, { ...draft, text: 'y' }, { documentId: 'd', authorOrgId: 'o' }), false);
    assert.equal(sameMarkup(row, draft, { documentId: 'd', authorOrgId: 'other' }), false);
  });

  test('close / re-open are idempotent', () => {
    assert.deepEqual(markupTransition('open', 'close'), { ok: true, to: 'closed' });
    assert.deepEqual(markupTransition('closed', 'close'), { ok: true, noop: true });
    assert.deepEqual(markupTransition('closed', 'reopen'), { ok: true, to: 'open' });
  });

  test('a link names exactly one target', () => {
    assert.deepEqual(validateMarkupLink({ question_id: ID(9) }).link, { questionId: ID(9) });
    assert.deepEqual(validateMarkupLink({ nonconformity_id: ID(8) }).link, { nonconformityId: ID(8) });
    assert.ok(validateMarkupLink({}).errors.link);
    assert.ok(validateMarkupLink({ question_id: ID(9), nonconformity_id: ID(8) }).errors.link);
    assert.ok(validateMarkupLink({ question_id: 'x' }).errors.question_id);
  });

  test('the wire body leaves unset links and close stamps absent', () => {
    const body = markupBody({
      ...row, version_no: 3, author_person_id: 'p', created_at: new Date('2026-10-10T10:00:00Z'), state: 'open',
      closed_at: null, question_id: null, nonconformity_id: ID(8),
    });
    assert.equal(body.created_at, '2026-10-10T10:00:00.000Z');
    assert.equal('closed_at' in body, false);
    assert.equal('question_id' in body, false);
    assert.equal(body.nonconformity_id, ID(8));
    assert.deepEqual(body.author, { person_id: 'p', org_id: 'o' });
  });
});
