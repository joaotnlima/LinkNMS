// Upload limits shared by every module that accepts file bytes (D-49).
//
// One cap for every document kind — drawings, models, photos, specs — so the
// task Files tab, the RFP model and any later surface say the same number.
// Enforced server-side where the file is declared (the declared size is what
// the presigned PUT is signed for; completeUpload proves the stored size).
// The token-scoped bidder attachments (tendering, anonymous link holders) keep
// their own, smaller abuse bound.

/** 100 MB — D-49 (the founder's default, unconfirmed). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
