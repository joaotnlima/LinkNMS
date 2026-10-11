// Share links on `/api/v2` (PRD-12 N-12, flow D21). I/O only; naming lives in
// `./share-links-view.ts`.
//
// The owner side is members-only. The holder side is the `security: []` pair:
// dispatched IN PROCESS with `allowAnonymous` (client.ts §callInProcess), so the
// API path with the token is never a wire URL or an access-log line (gap S1) —
// the only token-bearing URL a browser holds is the page route `/share/{token}`.
// The request's own headers travel with the in-process call, so the module logs
// the holder's address and user agent.
import 'server-only';

import { v2, v2Redirect, V2Error } from './client';
import type { SharedLoad, V2ShareLink, V2ShareLinkAccess, V2SharedView } from './share-links-view';

const enc = encodeURIComponent;

export async function listShareLinksV2(projectId: string): Promise<V2ShareLink[]> {
  const res = await v2<{ items: V2ShareLink[] }>({ method: 'GET', path: `/projects/${enc(projectId)}/share-links`, query: { limit: 100 } });
  return res.items ?? [];
}

export async function listShareLinkAccessesV2(linkId: string): Promise<V2ShareLinkAccess[]> {
  const res = await v2<{ items: V2ShareLinkAccess[] }>({ method: 'GET', path: `/share-links/${enc(linkId)}/accesses`, query: { limit: 200 } });
  return res.items ?? [];
}

export function createShareLinkV2(projectId: string, body: Record<string, unknown>): Promise<V2ShareLink> {
  return v2<V2ShareLink>({ method: 'POST', path: `/projects/${enc(projectId)}/share-links`, body });
}

export function revokeShareLinkV2(linkId: string): Promise<V2ShareLink> {
  return v2<V2ShareLink>({ method: 'POST', path: `/share-links/${enc(linkId)}:revoke` });
}

export async function loadSharedV2(token: string): Promise<SharedLoad> {
  try {
    const view = await v2<V2SharedView>({ method: 'GET', path: `/shared/${enc(token)}`, allowAnonymous: true });
    return { state: 'ready', view };
  } catch (err) {
    if (err instanceof V2Error && err.status === 410) {
      const reason = err.problem?.reason === 'revoked' ? 'revoked' : 'expired';
      const expiresAt = typeof err.problem?.expires_at === 'string' ? err.problem.expires_at : null;
      return { state: 'closed', reason, expiresAt };
    }
    if (err instanceof V2Error && err.status === 404) return { state: 'dead' };
    return { state: 'error' };
  }
}

/** The signed URL of one shared document, or why not (`gone` / `not_found`). */
export async function sharedDocumentLocationV2(
  token: string, documentId: string, disposition: 'inline' | 'attachment',
): Promise<{ ok: true; url: string } | { ok: false; status: number }> {
  try {
    const url = await v2Redirect({
      method: 'GET', path: `/shared/${enc(token)}/documents/${enc(documentId)}:download`, query: { disposition }, allowAnonymous: true,
    });
    return { ok: true, url };
  } catch (err) {
    if (err instanceof V2Error) return { ok: false, status: err.status };
    throw err;
  }
}
