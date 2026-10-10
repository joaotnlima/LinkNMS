// The collaboration QUESTION PORT published for other modules (doc 02 rule 2).
// Documents records that a drawing markup became a question (PRD-06 V-8)
// without reading collaboration.*:
//
//   questionFacts(questionId) → null | {
//     id, project_id, author_org_id, addressee_org_id, status, object_type, object_id
//   }
//
// Null for anything that is not a live question (a note, an answer, a
// tombstone, an unknown id). The caller decides its own rule on the facts.

/** @param {{ getComment: (id: string) => Promise<object|null> }} store collaboration pg-store */
export function createQuestionPort(store) {
  return {
    async questionFacts(questionId) {
      const c = await store.getComment(questionId);
      if (!c || c.kind !== 'question' || c.deleted_at) return null;
      return {
        id: c.id,
        project_id: c.project_id ?? null,
        author_org_id: c.author_org_id,
        addressee_org_id: c.addressee_org_id ?? null,
        status: c.question_status ?? null,
        object_type: c.object_type,
        object_id: c.object_id,
      };
    },
  };
}
