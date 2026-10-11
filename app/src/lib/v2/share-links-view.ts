// Pure v2-wire → view transforms for share links (PRD-12 N-12, flow D21): the
// owner's list and access log at `/projects/{id}/documents/share`, and the
// holder's page at `/share/{token}`. The link's state and what it may serve are
// the server's answers; this names them and validates the create form.

export interface V2ShareLink {
  id: string;
  audience: string;
  document_ids: string[];
  task_ids?: string[];
  url?: string;
  expires_at: string;
  status: 'active' | 'expired' | 'revoked';
  created_at?: string;
  revoked_at?: string;
  access_count?: number;
  last_accessed_at?: string;
}

export interface V2ShareLinkAccess {
  id: string;
  at: string;
  action: 'view' | 'download';
  document_id?: string;
  ip?: string;
  user_agent?: string;
}

export interface V2SharedDocument {
  id: string;
  title: string;
  kind?: string;
  file_type?: string;
  mime?: string;
  version_no: number;
  size_bytes?: number;
  sha256?: string;
  uploaded_at?: string;
}

export interface V2SharedView {
  project_name: string;
  municipality_code?: string;
  audience: string;
  expires_at: string;
  documents: V2SharedDocument[];
}

/** The holder's page: a live link, a closed one (with why), or a dead token. */
export type SharedLoad =
  | { state: 'ready'; view: V2SharedView }
  | { state: 'closed'; reason: 'expired' | 'revoked'; expiresAt: string | null }
  | { state: 'dead' }
  | { state: 'error' };

export function statusWords(link: Pick<V2ShareLink, 'status' | 'expires_at' | 'revoked_at'>): string {
  if (link.status === 'revoked') return `Revoked${link.revoked_at ? ` on ${link.revoked_at.slice(0, 10)}` : ''}`;
  if (link.status === 'expired') return `Expired on ${link.expires_at.slice(0, 10)}`;
  return `Open until ${link.expires_at.slice(0, 10)}`;
}

export function usageWords(link: Pick<V2ShareLink, 'access_count' | 'last_accessed_at'>): string {
  const n = link.access_count ?? 0;
  if (!n) return 'Not opened yet';
  return `${n} access${n === 1 ? '' : 'es'}${link.last_accessed_at ? `, last ${link.last_accessed_at.slice(0, 16).replace('T', ' ')}` : ''}`;
}

export function accessWords(a: V2ShareLinkAccess, titles: Map<string, string>): string {
  const what = a.action === 'view' ? 'Opened the list' : `Downloaded ${titles.get(a.document_id ?? '') ?? 'a document'}`;
  return `${a.at.slice(0, 16).replace('T', ' ')} — ${what}${a.ip ? ` · ${a.ip}` : ''}`;
}

export interface ShareForm { audience: string; expiresOn: string; documentIds: string[] }

/** The createShareLink body (expiry at the end of the chosen day, UTC), or the first thing to fix. */
export function shareBody(form: ShareForm, today: string): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  const audience = form.audience.trim();
  if (!audience) return { ok: false, message: 'Say who the link is for (e.g. the municipality).' };
  if (!form.documentIds.length) return { ok: false, message: 'Pick the documents to share.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.expiresOn) || form.expiresOn < today) return { ok: false, message: 'Pick an expiry date from today on.' };
  // The 90-day limit is the server's (createShareLink answers 422; the date input's max reads max_expires_at).
  return { ok: true, body: { audience, document_ids: form.documentIds, expires_at: `${form.expiresOn}T23:59:59Z` } };
}

export function sizeWords(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Where the holder's browser opens or downloads one shared document (a page route, never the API). */
export function sharedDocumentPath(token: string, documentId: string, inline = false): string {
  return `/share/${encodeURIComponent(token)}/${encodeURIComponent(documentId)}${inline ? '?disposition=inline' : ''}`;
}

/** PDFs and images open in the browser; everything else downloads. */
export function opensInline(doc: Pick<V2SharedDocument, 'mime' | 'file_type'>): boolean {
  return doc.file_type === 'pdf' || doc.file_type === 'image' || /^(application\/pdf|image\/)/.test(doc.mime ?? '');
}
