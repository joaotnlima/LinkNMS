// Published query port: the address-only invitees of a SENT RFP (PRD-04 X-2).
// The directory seeds an unclaimed profile for each when it hears
// tendering.rfp.published / .recipients_added; it never reads tendering.*.
// Draft recipients are never answered — a draft is private until sent (T-6).

/** @param {{ emailInvitees: Function }} store tendering pg-store */
export function createInviteePort(store) {
  return {
    /** → { emails: string[] (lower-case), specialty_codes: string[] } */
    async emailInviteesOf(rfpId) {
      return store.emailInvitees(rfpId);
    },
  };
}
