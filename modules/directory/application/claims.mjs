// Directory application — unclaimed profiles and the claim path (PRD-03 R-16).
//
// An UNCLAIMED profile is created from an e-mail the platform already knows a
// company by (PRD-04 seeds them from RFP invitations by e-mail, through the
// seed port below). It shows only what the record knows. To claim it, an
// organisation proves control of THAT e-mail: claimProfile mails a
// single-use link (7 days, stored as a sha256) and only acceptProfileClaim
// with that token — from the same organisation — completes it. The address
// is never returned, only masked; an unknown / used / expired token answers
// 410 without saying which.
import { randomBytes, randomUUID, createHash } from 'node:crypto';

import { ProblemError } from '../../../platform/errors.mjs';
import { LISTABLE_KINDS, maskEmail, ownerProfileBody, slugify } from '../domain/profile.mjs';
import { UUID, requireActiveOrg, requireHuman } from './shared.mjs';

const CLAIM_TTL_MS = 7 * 24 * 3600 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** operationId: claimProfile — 202, a link goes to the profile's e-mail. */
export async function claimProfile({ viewer, store, mail, orgId, idempotencyKey = null, now = new Date() }) {
  requireActiveOrg(viewer);
  requireHuman(viewer, 'claiming a profile');
  if (!viewer.has('org:profile:manage')) throw new ProblemError('forbidden', null, { reason: 'role' });
  if (!LISTABLE_KINDS.includes(viewer.orgKind)) {
    throw new ProblemError('forbidden', 'households are not listed in the directory', { reason: 'org_kind' });
  }
  if (!UUID.test(orgId ?? '')) throw new ProblemError('not_found');
  // A replay answers the first 202 — no second link is minted or mailed.
  return store.idempotent(
    { key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'claimProfile', body: { org_id: orgId, claimant_org_id: viewer.orgId } },
    () => startClaim({ viewer, store, mail, orgId, now }),
  );
}

async function startClaim({ viewer, store, mail, orgId, now }) {
  const profile = await store.getProfileByOrg(orgId);
  if (!profile || !profile.listed) throw new ProblemError('not_found');
  if (profile.claimed) throw new ProblemError('invalid_transition', 'this profile is already claimed');
  if (await store.getProfileByOrg(viewer.orgId)) {
    throw new ProblemError('invalid_transition', 'your organisation already has a profile — merging two is not supported');
  }
  if (!viewer.personId) throw new ProblemError('version_conflict', 'your identity mirror has not caught up yet — retry');

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + CLAIM_TTL_MS);
  await store.createClaim({
    id: randomUUID(),
    profileOrgId: orgId,
    claimantOrgId: viewer.orgId,
    claimantPersonId: viewer.personId,
    tokenHash: sha256(token),
    sentTo: profile.contact_email,
    expiresAt,
  });
  const url = `${baseUrlOf(mail)}/companies/${profile.slug}/claim/${token}`;
  // The token lives only in the mail body (never logged, never in a response).
  await mail.sender.send({
    to: profile.contact_email,
    subject: `Claim ${profile.display_name} on LinkNMS`,
    text: `Someone asked to manage the LinkNMS profile of ${profile.display_name}.\n\n`
      + `If that was you, open this link while signed in to your company account (valid 7 days):\n${url}\n\n`
      + 'If it was not you, ignore this e-mail — nothing changes.',
    html: `<p>Someone asked to manage the LinkNMS profile of <b>${escapeHtml(profile.display_name)}</b>.</p>`
      + `<p>If that was you, open this link while signed in to your company account (valid 7 days):<br>`
      + `<a href="${url}">Claim the profile</a></p><p>If it was not you, ignore this e-mail — nothing changes.</p>`,
  });
  return { status: 202, body: { sent_to: maskEmail(profile.contact_email), expires_at: expiresAt.toISOString() } };
}

/** operationId: acceptProfileClaim — the e-mailed token completes the claim. */
export async function acceptProfileClaim({ viewer, store, token, idempotencyKey = null, now = new Date() }) {
  requireActiveOrg(viewer);
  requireHuman(viewer, 'claiming a profile');
  if (!viewer.has('org:profile:manage')) throw new ProblemError('forbidden', null, { reason: 'role' });
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw new ProblemError('gone');
  // Inside the reservation: a replay answers the profile, not 410 for a used token.
  return store.idempotent(
    { key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'acceptProfileClaim', body: { token_hash: sha256(token) } },
    () => acceptClaim({ viewer, store, token, now }),
  );
}

async function acceptClaim({ viewer, store, token, now }) {
  const claim = await store.findClaimByHash(sha256(token));
  if (!claim || claim.accepted_at || new Date(claim.expires_at) <= now) throw new ProblemError('gone');
  if (claim.claimant_org_id !== viewer.orgId) {
    throw new ProblemError('forbidden', 'switch to the organisation that asked for this claim', { reason: 'relationship' });
  }
  const row = await store.acceptClaim({
    claimId: claim.id, profileOrgId: claim.profile_org_id, claimantOrgId: viewer.orgId, kind: viewer.orgKind,
    actor: { personId: viewer.personId ?? null },
  });
  if (!row) throw new ProblemError('invalid_transition', 'the profile was claimed meanwhile, or your organisation now has one');
  return { status: 200, body: ownerProfileBody(row) };
}

/**
 * Seed port for PRD-04 X-2 (RFP invitations by e-mail): one unclaimed, listed
 * profile per e-mail; a second call with the same e-mail returns the first,
 * and an address whose profile was claimed returns that company's profile.
 * Not an HTTP operation — the directory's own consumer of
 * tendering.rfp.published / .recipients_added calls it (application/consumers.mjs).
 */
export function createUnclaimedProfileSeeder(store) {
  return {
    async ensureUnclaimed({ displayName, contactEmail, specialties = [] }) {
      const email = String(contactEmail ?? '').trim().toLowerCase();
      const name = String(displayName ?? '').trim();
      if (!EMAIL.test(email)) throw new Error('unclaimed profile needs a valid e-mail');
      if (!name) throw new Error('unclaimed profile needs a name');
      const taxonomy = await store.listSpecialties();
      const codes = new Set(taxonomy.map((s) => s.code));
      return store.insertUnclaimedProfile({
        orgId: randomUUID(),
        displayName: name.slice(0, 120),
        contactEmail: email,
        slugBase: slugify(name),
        specialties: [...new Set(specialties.filter((c) => codes.has(c)))],
      });
    },
  };
}

function sha256(v) {
  return createHash('sha256').update(v).digest('hex');
}

function baseUrlOf(mail) {
  const b = typeof mail.baseUrl === 'function' ? mail.baseUrl() : mail.baseUrl;
  return String(b ?? 'https://portal.linknms.com').replace(/\/+$/, '');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
