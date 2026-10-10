// Tendering event consumers (PRD-04, doc 10).
//
//   directory.profile.claimed → every past invite to the claimed address that
//     has no organisation gains the claimant (and so do their lanes): an
//     e-mail invitee who signs up and claims its unclaimed profile finds its
//     requests in the company inbox (PRD-04 §6 criterion 3).
//
// Delivery is at-least-once; the back-fill only fills NULLs, so a replay
// changes nothing.

/** @param {{ adoptClaimedAddress: Function }} store tendering pg-store */
export function tenderingConsumers(store) {
  return {
    'directory.profile.claimed': async (evt) => {
      const orgId = evt.data?.org_id;
      const email = evt.data?.email;
      if (!orgId || !email) return;
      await store.adoptClaimedAddress({ orgId, email });
    },
  };
}
