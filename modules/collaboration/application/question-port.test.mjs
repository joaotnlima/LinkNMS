// The question port (PRD-06 V-8): facts of a live question, null for anything else.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createQuestionPort } from './question-port.mjs';

const rows = {
  q: { id: 'q', kind: 'question', project_id: 'p', author_org_id: 'o', addressee_org_id: 'a', question_status: 'open', object_type: 'document', object_id: 'd' },
  n: { id: 'n', kind: 'note', project_id: 'p', author_org_id: 'o' },
  gone: { id: 'gone', kind: 'question', project_id: 'p', author_org_id: 'o', deleted_at: new Date() },
};
const port = createQuestionPort({ getComment: async (id) => rows[id] ?? null });

test('a live question answers its facts', async () => {
  assert.deepEqual(await port.questionFacts('q'), {
    id: 'q', project_id: 'p', author_org_id: 'o', addressee_org_id: 'a', status: 'open', object_type: 'document', object_id: 'd',
  });
});

test('notes, tombstones and unknown ids answer null', async () => {
  assert.equal(await port.questionFacts('n'), null);
  assert.equal(await port.questionFacts('gone'), null);
  assert.equal(await port.questionFacts('x'), null);
});
