// Share links (flow D21, PRD-12 N-12) — pure: a link's state, the rules of its
// scope at creation, the wire bodies. No I/O.
//
// A share link is for someone with NO account (a licensing authority): a
// bearer token, scoped to named documents, that expires. Its state is derived,
// never stored: revoked wins over expired, so the owner's list says who closed
// it even when it would have lapsed anyway.

export const MAX_SHARE_DAYS = 90;
export const MAX_SHARED_DOCUMENTS = 50;

/** active | expired | revoked at `now`. */
export function shareLinkStatus(link, now = new Date()) {
  if (link.revoked_at) return 'revoked';
  return new Date(link.expires_at).getTime() <= now.getTime() ? 'expired' : 'active';
}

/**
 * Validate a create body (owner side). Answers field errors and the
 * normalised command; the documents' membership of the build is the caller's
 * second check (it needs the documents port).
 */
export function parseShareLinkCreate(body, now = new Date()) {
  const errors = {};
  const audience = typeof body?.audience === 'string' ? body.audience.trim() : '';
  if (!audience) errors.audience = 'required — who this link is for';
  else if (audience.length > 200) errors.audience = 'at most 200 characters';

  const expiresAt = body?.expires_at ? new Date(body.expires_at) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    errors.expires_at = 'a future date-time';
  } else if (expiresAt.getTime() > now.getTime() + MAX_SHARE_DAYS * 24 * 3600 * 1000) {
    errors.expires_at = `at most ${MAX_SHARE_DAYS} days out`;
  }

  const documentIds = body?.document_ids ?? [];
  if (!Array.isArray(documentIds) || documentIds.some((d) => !UUID.test(d ?? ''))) {
    errors.document_ids = 'a list of document ids';
  } else if (!documentIds.length) {
    errors.document_ids = 'pick at least one document to share';
  } else if (new Set(documentIds).size > MAX_SHARED_DOCUMENTS) {
    errors.document_ids = `at most ${MAX_SHARED_DOCUMENTS} documents`;
  }

  const taskIds = body?.task_ids ?? [];
  if (!Array.isArray(taskIds) || taskIds.some((t) => !UUID.test(t ?? ''))) errors.task_ids = 'a list of task ids';

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      audience,
      expiresAt: expiresAt.toISOString(),
      documentIds: [...new Set(documentIds)],
      taskIds: [...new Set(taskIds)],
    },
  };
}

/** #/components/schemas/ShareLink (never the url — only createShareLink answers it). */
export function shareLinkBody(row, now = new Date()) {
  return {
    id: row.id,
    audience: row.audience,
    document_ids: row.document_ids ?? [],
    task_ids: row.task_ids ?? [],
    expires_at: iso(row.expires_at),
    status: shareLinkStatus(row, now),
    created_at: iso(row.created_at),
    ...(row.revoked_at ? { revoked_at: iso(row.revoked_at) } : {}),
    access_count: Number(row.access_count ?? 0),
    ...(row.last_accessed_at ? { last_accessed_at: iso(row.last_accessed_at) } : {}),
  };
}

/** #/components/schemas/ShareLinkAccess. */
export function shareLinkAccessBody(row) {
  return {
    id: row.id,
    at: iso(row.at),
    action: row.action,
    ...(row.document_id ? { document_id: row.document_id } : {}),
    ...(row.ip ? { ip: row.ip } : {}),
    ...(row.user_agent ? { user_agent: row.user_agent } : {}),
  };
}

/**
 * The requester as the public edge saw it, bounded to the columns' limits.
 * The first X-Forwarded-For hop is the client behind the platform proxy.
 */
export function requesterOf(headers = {}) {
  const forwarded = String(headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  const ip = forwarded || String(headers['x-real-ip'] ?? '').trim() || null;
  const ua = String(headers['user-agent'] ?? '').trim() || null;
  return { ip: ip ? ip.slice(0, 64) : null, userAgent: ua ? ua.slice(0, 300) : null };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function iso(value) {
  if (value == null) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}
