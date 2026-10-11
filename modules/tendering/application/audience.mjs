// The tendering NOTIFICATION AUDIENCE PORT (PRD-12 N-1, doc 10 §Notification
// centre). Published for the collaboration module, which owns notifications
// but must not read tendering.* to find who to tell:
//
//   rfpAudience(rfpId) → null | {
//     rfp_id, project_id, title, issuer_org_id, status, root_task_ids[],
//     awarded_proposal_id, bidders: [{ org_id, proposal_id, proposal_status, active }]
//   }
//
// `bidders` are ORGANISATIONS with a lane (V8 — no person, no price, no
// email). `active` is false for a recipient that declined the invitation or
// bounced, or whose lane was withdrawn: they are no longer in the tender, so
// clarifications and cancellations are not theirs to hear about. The issuer
// is never in `bidders` (an org cannot bid on its own RFP).
const GONE_RECIPIENT = new Set(['declined', 'bounced']);

/** @param {{ rfpAudienceRows: (rfpId: string) => Promise<object|null> }} store tendering pg-store */
export function createTenderingAudience(store) {
  return {
    async rfpAudience(rfpId) {
      const found = await store.rfpAudienceRows(rfpId);
      if (!found) return null;
      const { rfp, bidders } = found;
      return {
        rfp_id: rfp.id,
        project_id: rfp.project_id,
        title: rfp.title,
        issuer_org_id: rfp.issuer_org_id,
        status: rfp.status,
        root_task_ids: rfp.root_task_ids ?? [],
        awarded_proposal_id: rfp.awarded_proposal_id ?? null,
        bidders: bidders
          .filter((b) => b.org_id !== rfp.issuer_org_id)
          .map((b) => ({
            org_id: b.org_id,
            proposal_id: b.proposal_id ?? null,
            proposal_status: b.proposal_status ?? null,
            active: !GONE_RECIPIENT.has(b.recipient_status) && b.proposal_status !== 'withdrawn',
          })),
      };
    },
  };
}
