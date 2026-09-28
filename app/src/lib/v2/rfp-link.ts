// The public RFP link — server-only I/O (LINA-360, S5). The pure half (types,
// validation, formatters) is in rfp-link-view.ts; this file is the seam to the
// v2 tendering backend and imports `server-only` transitively through the v2
// client, so a client component must import the view, never this.
//
// Both calls are the `security: []` pair the backend exposes (LINA-322): the
// viewer is null and `allowAnonymous` is set, so the v2 client dispatches WITHOUT
// resolving a Clerk session (client.ts §callInProcess). Authorization is the
// backend's — the token in the path IS the credential, re-supplied on every call
// (no cookie is minted, so both pages can be server components; see the view
// header).
import 'server-only';

import { v2, V2Error } from './client';
import type { BidBody, ProposalEcho, RfpLinkView } from './rfp-link-view';

const base = (token: string) => `/rfp-links/${encodeURIComponent(token)}`;

/**
 * The three outcomes of the read, as a discriminated union rather than a throw,
 * so the server page renders a state instead of hitting an error boundary:
 *
 *   ready — a live link; the view carries `closed`/`proposal` for the rest.
 *   dead  — the uniform `not_found` (unknown OR closed-and-purged token). One
 *           outcome on purpose: nothing here distinguishes "never real" from
 *           "gone", so the copy cannot become a probe oracle.
 *   error — a transient failure (network, 5xx). NOT a dead link: telling someone
 *           whose connection blipped that the RFP is closed sends them away from
 *           a bid they could still place.
 */
export type RfpLinkLoad =
  | { state: 'ready'; view: RfpLinkView }
  | { state: 'dead' }
  | { state: 'error' };

export async function loadRfpLink(token: string): Promise<RfpLinkLoad> {
  try {
    const view = await v2<RfpLinkView>({
      method: 'GET',
      path: base(token),
      allowAnonymous: true,
    });
    return { state: 'ready', view };
  } catch (e) {
    if (e instanceof V2Error && e.status === 404) return { state: 'dead' };
    return { state: 'error' };
  }
}

/** The outcome of a submit, again as a union — the server action maps it. */
export type BidResult =
  | { ok: true; proposal: ProposalEcho }
  // A refusal the form renders as a whole-form banner. `code` lets the caller
  // distinguish a closed/spent link (invalid_transition) from a bad field set.
  | { ok: false; code: string; message: string };

export async function submitBid(token: string, body: BidBody): Promise<BidResult> {
  try {
    const proposal = await v2<ProposalEcho>({
      method: 'POST',
      path: `${base(token)}/proposal`,
      body,
      allowAnonymous: true,
    });
    return { ok: true, proposal };
  } catch (e) {
    if (e instanceof V2Error) {
      return { ok: false, code: e.code, message: bannerFor(e) };
    }
    return { ok: false, code: 'internal', message: 'That did not send. Try again.' };
  }
}

/**
 * The server's codes are the authority on WHAT happened; the sentence is this
 * surface's job. `invalid_transition` covers both a spent link and a window that
 * shut between load and submit — the v2 vocabulary (doc 11) has no
 * `already_submitted` code — so its copy tells the contractor not to chase it
 * without promising which of the two it was.
 */
function bannerFor(e: V2Error): string {
  switch (e.code) {
    case 'invalid_transition':
      return 'This request is no longer accepting proposals — the window may have closed, or a proposal has already been sent from this link.';
    case 'not_found':
      return 'This link is not valid. Ask whoever invited you to send a new one.';
    case 'validation_failed':
      return 'Some of these answers did not go through. Check the form and try again.';
    default:
      return e.detail || 'That did not send. Try again.';
  }
}
