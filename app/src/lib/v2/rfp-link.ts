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

/** The presigned-PUT ticket the reserve step answers. */
export interface ProposalUploadTicket {
  documentId: string;
  uploadUrl: string;
  expiresAt: string;
}

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

// ── Portfolio-attachment uploads (LINA-375; BE LINA-370) ─────────────────────
// Steps 1 and 3 of the reserve → PUT → complete protocol. BOTH run here on the
// server (they call the v2 tendering module in-process over the anonymous
// `rfp-links` surface); only step 2 — the presigned PUT of the raw bytes — runs
// in the browser (upload-client.ts), so the file never crosses our server. The
// token in the path is the whole credential, re-supplied on every call.

/** A reserved upload (step 1), or a refusal the widget renders per-file. */
export type ReserveResult =
  | { ok: true; ticket: ProposalUploadTicket }
  | { ok: false; code: string; message: string };

/** The wire the reserve endpoint answers: ids/urls in snake_case. */
interface ReserveTicketWire {
  document_id: string;
  upload_url: string;
  expires_at: string;
}

/**
 * Step 1 — reserve one attachment and get a presigned PUT. The BE mints the
 * document id, pins the declared sha256 into the signature (so the browser can
 * only upload the bytes it declared), and enforces the type/size/count caps; a
 * spent or closed link is `invalid_transition` (409), the same case the submit's
 * closed-link banner covers.
 */
export async function reserveProposalDocument(
  token: string,
  file: { name: string; mime: string; sizeBytes: number; sha256: string },
): Promise<ReserveResult> {
  try {
    const t = await v2<ReserveTicketWire>({
      method: 'POST',
      path: `${base(token)}/documents`,
      body: {
        file: {
          name: file.name,
          mime: file.mime,
          size_bytes: file.sizeBytes,
          sha256: file.sha256.toLowerCase(),
        },
      },
      allowAnonymous: true,
    });
    return {
      ok: true,
      ticket: { documentId: t.document_id, uploadUrl: t.upload_url, expiresAt: t.expires_at },
    };
  } catch (e) {
    if (e instanceof V2Error) return { ok: false, code: e.code, message: uploadBannerFor(e) };
    return { ok: false, code: 'internal', message: 'That file did not upload. Try again.' };
  }
}

/** The outcome of completing an upload (step 3). */
export type CompleteResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * Step 3 — prove the bytes landed (the BE heads the object and checks the size;
 * the sha256 was already pinned into the PUT) and mark the attachment `stored`.
 * Idempotent. Only a `stored` id may then ride the submit's `document_ids`.
 */
export async function completeProposalDocument(
  token: string,
  documentId: string,
): Promise<CompleteResult> {
  try {
    await v2<unknown>({
      method: 'POST',
      path: `${base(token)}/documents/${encodeURIComponent(documentId)}:complete`,
      allowAnonymous: true,
    });
    return { ok: true };
  } catch (e) {
    if (e instanceof V2Error) return { ok: false, code: e.code, message: uploadBannerFor(e) };
    return { ok: false, code: 'internal', message: 'That file did not upload. Try again.' };
  }
}

// ── BIM model view-url (LINA-409 / doc 24) ───────────────────────────────────
// The tokened bidder views the attached 3D model before pricing. The token in
// the path is the whole credential (security: []); the BE mints a short-TTL
// presigned INLINE GET server-side and returns only the URL — the token never
// reaches R2. Called lazily (on "Load 3D model"), not on page load, so the URL
// is fresh when the browser fetches the bytes.

/** A minted, short-TTL presigned inline GET for a model, or a refusal. */
export type ModelUrlResult =
  | { ok: true; url: string; expiresAt: string }
  | { ok: false; code: string; message: string };

export async function modelViewUrlByToken(token: string, documentId: string): Promise<ModelUrlResult> {
  try {
    const r = await v2<{ url: string; expiresAt: string }>({
      method: 'GET',
      path: `${base(token)}/model/${encodeURIComponent(documentId)}:view-url`,
      allowAnonymous: true,
    });
    return { ok: true, url: r.url, expiresAt: r.expiresAt };
  } catch (e) {
    if (e instanceof V2Error) return { ok: false, code: e.code, message: uploadBannerFor(e) };
    return { ok: false, code: 'internal', message: 'The 3D model could not be opened. Try again.' };
  }
}

/** Per-file copy for the upload steps — distinct from the submit's sentences. */
function uploadBannerFor(e: V2Error): string {
  switch (e.code) {
    case 'invalid_transition':
      return 'This request is no longer accepting proposals, so files cannot be attached.';
    case 'not_found':
      return 'This link is not valid. Ask whoever invited you to send a new one.';
    case 'validation_failed':
      return e.detail || 'That file was not accepted. Check the type and size and try again.';
    default:
      return e.detail || 'That file did not upload. Try again.';
  }
}
