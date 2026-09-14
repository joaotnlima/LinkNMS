// RFP procurement loop (LINA-279; ADR-0023 §2, §4, §5, §7) — the LINA-294
// ratified surface.
//
// The FE contracts shipped first (LINA-283 procurement page, LINA-284 token
// page). This service implements the OTHER half of that contract exactly:
//
//   /projects/:projectId/procurement                      GET  the procurement view
//   /projects/:projectId/procurement/rfp                  PUT  upsert the live draft
//   /projects/:projectId/procurement/rfp/attachments      POST append a FileRef
//   /projects/:projectId/procurement/rfp/recipients       POST add invitees
//   /projects/:projectId/procurement/rfp/recipients/:id   DELETE remove an invitee
//   /projects/:projectId/procurement/rfp:send             POST mail links (→ view)
//   /rfp/token/:token                                     GET  public preview
//   /rfp/token/:token/portfolio-images                    POST public image upload
//   /rfp/token/:token/proposal                            POST public submit
//
// Orchestration over three seams (see ports.mjs / blob-store.mjs):
//
//   ScheduleStore — schedule.rfp / rfp_recipient / rfp_proposal / project_phase.
//                   The dynamic-token rule lives here: a token is valid iff its
//                   RFP's procurement phase is still `active` (ADR-0023 §5,
//                   Option A) — one join holds the whole answer, no stored
//                   expiry to drift.
//   IdentityPort  — the sole authorizer (ADR-0004): reads gate on VIEW_RFP,
//                   writes on MANAGE_RFP. Token guests are NOT authorizers — the
//                   token IS the credential.
//   BlobStore     — the upload idiom shared with task-workspace: magic-byte
//                   sniffing + a 10 MB cap; `putRef` returns the FileRef's
//                   { key, url }.
//
// TOKEN LIFECYCLE (ADR-0023 §5, ratified LINA-294):
//   * Only SHA-256 of the raw token is stored. The RAW token exists only in the
//     emailed link — never in a log, a response, or the DB.
//   * Unknown token and revoked (declined) recipient → uniform 404 `not_found`
//     (no enumeration oracle).
//   * Submitted token → GET 200 WITH the proposal (the confirmation page
//     re-reads this endpoint even after the phase closes) and POST 409
//     `already_submitted`.
//   * Valid token but procurement no longer active → 410 `rfp_closed` (a
//     genuinely different state the FE types with a distinct page).
//   * A successful GET on a fresh token flips invited→viewed so the owner's
//     inbox is honest.
//   * There is NO token_expires_at; validity is derived per request from
//     project_phase.status (the single source of truth).
//
// EMAIL (ADR-0023 §7, ADR-0007 §5): send is fail-closed BEFORE minting — an
// unconfigured deploy is a loud 503 and mints nothing (a "sent" RFP whose
// invitees hold no link is the RFP equivalent of an open sign-in).

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sendEmail, isEmailConfigured } from '../email/sender.mjs';
import { DomainError } from './ports.mjs';
import { validateUpload, sniffContentType, sanitizeFileName, MAX_ATTACHMENT_BYTES } from './task-workspace.mjs';

export const RFP_STATUSES = Object.freeze(['draft', 'sent', 'closed']);
export const RECIPIENT_STATUSES = Object.freeze(['invited', 'viewed', 'submitted', 'declined']);
// Proposal limits shared with the FE (token.md / rfp-proposal.ts).
export const PORTFOLIO_MAX = 8;
export const PORTFOLIO_COMMENT_MAX = 4000;

const RFP_STATUS_SET = new Set(RFP_STATUSES);
const RECIPIENT_STATUS_SET = new Set(RECIPIENT_STATUSES);
const DESCRIPTION_MAX = 6000;
const SPECIALTIES_MAX = 20;
const SPECIALTY_MAX = 100;
// Portfolio images: sniffed JPEG/PNG/WebP/HEIC only — GIF and SVG have no
// place in a construction credential.
const PORTFOLIO_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'heif', 'mif1']);

const badRequest = (message, code = 'bad_request') => new DomainError(400, code, message);
const invalidProposal = (message) => new DomainError(400, 'invalid_proposal', message);
const notFound = (message = 'not found') => new DomainError(404, 'not_found', message);
const conflict = (code, message) => new DomainError(409, code, message);
const gone = (message) => new DomainError(410, 'rfp_closed', message);

export function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

const now = () => new Date().toISOString();
const defaultIds = { uuid: () => randomUUID(), token: () => randomBytes(32).toString('base64url') };

// Where the invited contractor lands — the token-scoped proposal form
// (ADR-0023 §4: /rfp/[token]). Base URL is derived by the HTTP seam (never the
// body) exactly like identity's invitation link (LINA-84 rule).
export function buildRfpLink(baseUrl, rawToken) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return `${base}/rfp/${encodeURIComponent(rawToken)}`;
}

// The rfp-invitation email (ADR-0023 §7). Shares the invitation card's visual
// language. `projectName` is dereferenced through Identity (ADR-0006) — never
// stored in schedule.
export function rfpInvitationEmailHtml({ link, projectName, description }) {
  const what = projectName ? `<strong>${escapeHtml(projectName)}</strong>` : 'your build';
  const body = description
    ? `<tr><td style="font-size:15px;line-height:1.6;color:#0b0b0b;padding:8px 0 24px"><span style="color:#9a9a9a;font-size:13px">About this build:</span><br>${escapeHtml(clip(description, 600))}</td></tr>`
    : '';
  return `<!DOCTYPE html><html lang="en"><body style="margin:0;background:#f4f3f0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#0b0b0b">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fcfcfb;border:1px solid #dcdbd7;border-radius:12px;padding:32px">
      <tr><td style="font-weight:700;font-size:18px;letter-spacing:-.01em;padding-bottom:8px">LinkNMS <span style="color:#9a9a9a;font-weight:500;font-size:13px">Trust built-in.</span></td></tr>
      <tr><td style="font-size:20px;font-weight:600;padding:16px 0 8px">You're invited to submit a proposal for ${what}</td></tr>
      ${body}
      <tr><td><a href="${link}" style="display:inline-block;background:#2a78d6;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 26px;border-radius:36px">Submit a proposal</a></td></tr>
      <tr><td style="font-size:12px;line-height:1.5;color:#9a9a9a;padding-top:28px;border-top:1px dashed #dcdbd7">This link is for one proposal, valid while the procurement phase is open. If you weren't expecting this, ignore the email.</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function clip(s, n) {
  const text = String(s);
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

// ── HTTP seam helper shared with other schedule services ─────────────────────
// The public origin RFP email links are built against. Derived from the ENV
// override or the request's forwarded headers — NEVER from the request body (a
// body-supplied origin would let any authenticated owner mint an RFP email whose
// "Submit" button points at a host they chose: a credential-phishing primitive
// wearing our brand — the same rule identity's originOf applies to invites).
export function rfpOriginOf(headers = {}, env = process.env) {
  if (env.APP_BASE_URL) return env.APP_BASE_URL.replace(/\/+$/, '');
  const h = (k) => headers?.[k] ?? headers?.[k.toLowerCase()] ?? null;
  const proto = h('x-forwarded-proto') ?? 'https';
  const host = h('x-forwarded-host') ?? h('host') ?? 'localhost:3000';
  return `${proto}://${host}`;
}

// ── Input validation (server-side re-validation; the FE validates first) ─────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return email && EMAIL_RE.test(email) ? email : null;
}

function stringCoerce(value, label, max) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw badRequest(`${label} must be text`);
  const clean = value.trim();
  if (clean.length > max) throw badRequest(`${label} is too long (max ${max} chars)`);
  return clean;
}

function assertOptionalText(value, context, max = 3000) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw badRequest(`${context} must be text`);
  const clean = value.trim();
  if (clean.length > max) throw badRequest(`${context} is too long (max ${max} chars)`);
  return clean === '' ? null : clean;
}

function assertSpecialties(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest('specialties must be an array of tags');
  if (value.length > SPECIALTIES_MAX) throw badRequest(`specialties can have up to ${SPECIALTIES_MAX} tags`);
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') throw badRequest('each specialty must be a tag (a string)');
    const tag = raw.trim();
    if (!tag) throw badRequest('specialties must not contain empty tags');
    if (tag.length > SPECIALTY_MAX) throw badRequest(`a specialty tag is too long (max ${SPECIALTY_MAX} chars)`);
    out.push(tag);
  }
  return out;
}

function assertNonNegativeCents(value, context, code = 'bad_request') {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(400, code, `${context} must be a non-negative integer number of cents`);
  }
  return value;
}

function assertPositiveDays(value, { code = 'bad_request', max = null } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new DomainError(400, code, 'timelineDays must be a positive integer number of days');
  }
  if (max !== null && value > max) throw new DomainError(400, code, `timelineDays cannot exceed ${max} days`);
  return value;
}

function normalizeWebsite(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw invalidProposal('websiteUrl must be an http(s) URL or be omitted');
  let url;
  try { url = new URL(value); } catch { throw invalidProposal('websiteUrl must be an http(s) URL or be omitted'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalidProposal('websiteUrl must be an http(s) URL or be omitted');
  }
  if (!url.hostname.includes('.') || url.hostname.endsWith('.')) {
    throw invalidProposal('websiteUrl must reference a real host');
  }
  return url.toString();
}

// Proposals arrive with FileRefs on the wire (camelCase contentType); the DB
// jsonb uses content_type — convert exactly here, one place, both directions.
function toStoreRef(a) {
  if (!a || typeof a !== 'object'
      || typeof a.key !== 'string' || typeof a.filename !== 'string'
      || !Number.isInteger(a.size) || typeof a.contentType !== 'string'
      || typeof a.url !== 'string') {
    throw invalidProposal('each portfolio image needs { key, filename, size, contentType, url }');
  }
  return { key: a.key, filename: a.filename, size: a.size, content_type: a.contentType, url: a.url };
}

function fileRefToWire(ref) {
  return {
    key: ref.key, filename: ref.filename, size: ref.size,
    contentType: ref.content_type ?? ref.contentType ?? null,
    url: ref.url,
  };
}

function assertPortfolioImages(value) {
  if (value === undefined || value === null || value.length === 0) return [];
  if (!Array.isArray(value)) throw invalidProposal('portfolioImages must be an array of file refs');
  if (value.length > PORTFOLIO_MAX) {
    throw new DomainError(400, 'too_many_images', `a proposal can reference up to ${PORTFOLIO_MAX} portfolio images`);
  }
  return value.map(toStoreRef);
}

// ── Portfolio image upload (token.md §3, route 2) ────────────────────────────
// The shared sniffer proves JPEG/PNG/WebP/GIF/SVG/PDF/OOXML. Portfolio keeps the
// image subset, plus a custom HEIC sniff (not in the shared sniffer). Filing
// errors stay shaped like task-workspace's validateUpload so the FE handles one
// same-shaped set of codes.
function isHeic(buffer) {
  if (buffer.length < 12 || buffer.toString('latin1', 4, 8) !== 'ftyp') return false;
  return HEIC_BRANDS.has(buffer.toString('latin1', 8, 12));
}

function sniffPortfolioImage(buffer, filename) {
  const sniffed = sniffContentType(buffer, filename);
  if (PORTFOLIO_IMAGE_MIMES.has(sniffed)) return sniffed;
  return isHeic(buffer) ? 'image/heic' : null;
}

function validatePortfolioImage(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.byteLength === 0) {
    throw new DomainError(400, 'empty_file', 'portfolio-images:multipart expects a non-empty image part');
  }
  if (file.buffer.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new DomainError(413, 'attachment_too_large', `image exceeds the 10 MB cap (${file.buffer.byteLength} bytes)`);
  }
  const fileName = sanitizeFileName(file.filename);
  if (!fileName) throw new DomainError(400, 'invalid_filename', 'file part must carry a valid file name (≤ 255 chars)');
  const contentType = sniffPortfolioImage(file.buffer, fileName);
  if (!contentType) {
    throw new DomainError(415, 'unsupported_content_type', 'only JPEG, PNG, WebP and HEIC images can be uploaded');
  }
  return { fileName, contentType, buffer: file.buffer };
}

/**
 * @param {Object} deps
 * @param {ReturnType<import('./ports.mjs').createInMemoryStore>|ReturnType<typeof import('./pg-store.mjs').createPgStore>} deps.store
 * @param {ReturnType<typeof import('./ports.mjs').createInMemoryIdentity>|ReturnType<typeof import('../identity/identity.mjs').createIdentityService>} deps.identity
 * @param {{ put(input):Promise<string>, putRef(input):Promise<{key,url}> }} deps.blob   upload port (shared with task-workspace)
 * @param {{ send(msg,opts):Promise<any>, isConfigured(env):boolean }} [deps.sender]  email port (mirrors LINA-84)
 * @param {{ uuid():string, token():string }} [deps.ids]  id/token providers (token → raw 32-byte base64url)
 * @param {{ now():string }} [deps.clock]
 */
export function createRfpService({
  store, identity, blob, sender = { send: sendEmail, isConfigured: isEmailConfigured },
  ids = defaultIds, clock = { now },
}) {
  if (!store) throw new Error('createRfpService requires { store }');
  if (!identity) throw new Error('createRfpService requires { identity }');
  if (!blob || typeof blob.put !== 'function' || typeof blob.putRef !== 'function') {
    throw new Error('createRfpService requires a { put, putRef } blob port');
  }
  if (!sender || typeof sender.send !== 'function' || typeof sender.isConfigured !== 'function') {
    throw new Error('createRfpService requires a { send, isConfigured } sender port');
  }

  // ── Shared guards ───────────────────────────────────────────────────────────
  async function procurementPhaseFor(projectId) {
    const phase = await store.getPhaseByProjectAndKind(projectId, 'procurement');
    if (!phase) throw notFound('this project has no procurement phase');
    return phase;
  }

  // Drafting (PUT, attachments, recipients) is allowed while the phase is
  // pending or active; once procurement has closed (a constructor was chosen or
  // the build archived), the RFP is historical and nothing drafts any more.
  function assertDraftWindow(phase) {
    if (phase.kind !== 'procurement') throw conflict('phase_not_active', 'rfp only applies to a procurement phase');
    if (phase.status === 'signed_off' || phase.status === 'archived') {
      throw conflict('phase_not_active', 'procurement is closed on this build');
    }
  }

  // The live draft RFP against the procurement phase — CREATED on first use so
  // the upsert (PUT) and its friend routes (attachments / recipients) all start
  // the draft lazily. Once sent, the RFP is sealed: no draft mutation lands.
  async function liveDraftFor(phase) {
    const live = await store.getLiveRfpByPhase(phase.id);
    if (live) {
      if (live.status !== 'draft') throw conflict('rfp_already_sent', 'this RFP has gone out already; drafts only change while unsent');
      return live;
    }
    const at = clock.now();
    return store.transaction(async (tx) => {
      const rfp = {
        id: ids.uuid(), phase_id: phase.id, description: '',
        attachments: [], specialties: [], selected_proposal_id: null,
        status: 'draft', created_at: at, updated_at: at,
      };
      await store.insertRfp(tx, rfp);
      return rfp;
    });
  }

  // The procurement read model (FE procurement.ts). Assumes authorization
  // already happened in the public entry point.
  async function readView(projectId) {
    const phase = await procurementPhaseFor(projectId);
    const live = await store.getLiveRfpByPhase(phase.id);
    const rfp = live ?? null;
    const recipients = rfp ? await store.listRfpRecipients(rfp.id) : [];
    const proposals = rfp ? await store.listRfpProposals(rfp.id) : [];
    return {
      phase: shapePhase(phase),
      rfp: rfp ? shapeRfp(rfp) : null,
      recipients: recipients.map(shapeRecipient),
      proposals: proposals.map(shapeProposal),
      selectedProposalId: rfp?.selected_proposal_id ?? null,
    };
  }

  // ── GET /projects/:projectId/procurement ────────────────────────────────────
  async function getProcurement({ actorPartyId, projectId }) {
    await identity.authorize({ actorPartyId, action: 'view_rfp', projectId });
    return readView(projectId);
  }

  // ── PUT /projects/:projectId/procurement/rfp — the upsert ───────────────────
  // { description, specialties } is the whole mutable draft core (the FE's save
  // keystrokes the box). Attachments and recipients are appended by their own
  // routes, so this PUT never re-publishes what other drafts already appended.
  async function saveRfpDraft({ actorPartyId, projectId, body }) {
    await identity.authorize({ actorPartyId, action: 'manage_rfp', projectId });
    const phase = await procurementPhaseFor(projectId);
    assertDraftWindow(phase);
    const b = body ?? {};
    const description = stringCoerce(b.description, 'description', DESCRIPTION_MAX);
    const specialties = assertSpecialties(b.specialties);
    const live = await store.getLiveRfpByPhase(phase.id);
    let rfp;
    if (live) {
      if (live.status !== 'draft') throw conflict('rfp_already_sent', 'this RFP has gone out already; drafts only change while unsent');
      rfp = await store.transaction(async (tx) =>
        await store.updateRfp(tx, live.id, { description, specialties }));
    } else {
      const at = clock.now();
      rfp = await store.transaction(async (tx) => {
        const created = {
          id: ids.uuid(), phase_id: phase.id, description,
          attachments: [], specialties, selected_proposal_id: null,
          status: 'draft', created_at: at, updated_at: at,
        };
        await store.insertRfp(tx, created);
        return created;
      });
    }
    if (!rfp) throw notFound('rfp');
    return { rfp: shapeRfp(rfp) };
  }

  // ── POST /projects/:projectId/procurement/rfp/attachments ───────────────────
  // One-file multipart; appends the stored FileRef to the live draft and
  // returns the FileRef the FE can immediately render. Reuses the shared upload
  // idiom (magic-byte sniffing + 10 MB cap) from task-workspace.mjs.
  async function addRfpAttachment({ actorPartyId, projectId, file }) {
    await identity.authorize({ actorPartyId, action: 'manage_rfp', projectId });
    const phase = await procurementPhaseFor(projectId);
    assertDraftWindow(phase);
    const rfp = await liveDraftFor(phase);
    const { fileName, contentType, buffer } = validateUpload(file);
    const { key, url } = await blob.putRef({ fileName, contentType, buffer });
    const attachment = { key, filename: fileName, size: buffer.byteLength, content_type: contentType, url };
    const updated = await store.transaction(async (tx) =>
      await store.updateRfp(tx, rfp.id, { attachments: [...(rfp.attachments ?? []), attachment] }));
    if (!updated) throw notFound('rfp');
    return { attachment: fileRefToWire(attachment) };
  }

  // ── POST /projects/:projectId/procurement/rfp/recipients ────────────────────
  // Emails are normalised + deduped server-side; the response is the FULL
  // recipient list (FE AddFn) so the page re-renders from one payload. Raw
  // tokens are never minted here — send() mints the deliverable link.
  async function addRecipients({ actorPartyId, projectId, emails }) {
    await identity.authorize({ actorPartyId, action: 'manage_rfp', projectId });
    const phase = await procurementPhaseFor(projectId);
    assertDraftWindow(phase);
    const rfp = await liveDraftFor(phase);
    const list = Array.isArray(emails) ? emails : [];
    if (list.length === 0) throw badRequest('emails is required');
    const existing = new Set((await store.listRfpRecipients(rfp.id)).map((r) => r.email));
    const fresh = [];
    for (const raw of list) {
      const email = normalizeEmail(raw);
      if (!email) throw badRequest('that does not look like an email address');
      if (!existing.has(email)) { existing.add(email); fresh.push(email); }
    }
    if (fresh.length) {
      const at = clock.now();
      const rows = fresh.map((email) => ({
        id: ids.uuid(), rfp_id: rfp.id, email,
        // Only SHA-256 lives here; liveness is send()'s rotation.
        token_hash: sha256Hex(ids.token()),
        status: 'invited', created_at: at,
      }));
      await store.transaction(async (tx) => {
        for (const row of rows) await store.insertRfpRecipient(tx, row);
      });
    }
    return { recipients: (await store.listRfpRecipients(rfp.id)).map(shapeRecipient) };
  }

  // ── DELETE /projects/:projectId/procurement/rfp/recipients/:recipientId ─────
  // Draft-era correction only (migration 0013 delegates rfp_recipient to the
  // app exactly for this); a sent RFP's recipients hold live tokens, so the
  // invite list is sealed once sent.
  async function removeRecipient({ actorPartyId, projectId, recipientId }) {
    await identity.authorize({ actorPartyId, action: 'manage_rfp', projectId });
    const phase = await procurementPhaseFor(projectId);
    assertDraftWindow(phase);
    const rfp = await store.getLiveRfpByPhase(phase.id);
    if (!rfp) throw notFound('recipient');
    if (rfp.status !== 'draft') throw conflict('rfp_already_sent', 'recipients are sealed once the RFP has gone out');
    const has = (await store.listRfpRecipients(rfp.id)).some((r) => r.id === recipientId);
    if (!has) throw notFound('recipient');
    const removed = await store.transaction((tx) => store.deleteRfpRecipient(tx, recipientId));
    if (!removed) throw notFound('recipient');
  }

  // ── POST /projects/:projectId/procurement/rfp:send ──────────────────────────
  // Fail-closed BEFORE minting (ADR-0007 §5): an unconfigured deploy is a loud
  // 503 and mints nothing. Each recipient rotates to a FRESH raw token so a
  // re-send defeats a captured older link; the raw value exists only in the
  // outgoing email. draft→sent is one-way; re-send works from `sent`. Returns
  // the full procurement view the FE swaps in (SendFn).
  async function sendRfp({ actorPartyId, projectId, baseUrl, env = process.env }) {
    await identity.authorize({ actorPartyId, action: 'manage_rfp', projectId });
    const phase = await procurementPhaseFor(projectId);
    if (phase.kind !== 'procurement' || phase.status !== 'active') {
      throw conflict('phase_not_active', 'procurement is not open on this build (a constructor may already be chosen)');
    }
    const rfp = await store.getLiveRfpByPhase(phase.id);
    if (!rfp) throw badRequest('start the RFP before sending it', 'rfp_empty');
    const description = (rfp.description ?? '').trim();
    if (!description) throw badRequest('describe the work before sending the RFP', 'rfp_empty');
    const recipients = (await store.listRfpRecipients(rfp.id))
      .filter((r) => r.status !== 'submitted' && r.status !== 'declined');
    if (recipients.length === 0) throw badRequest('add at least one contractor before sending', 'no_recipients');
    if (!sender.isConfigured(env)) {
      throw new DomainError(503, 'email_unconfigured', 'email delivery is not configured');
    }

    // Project name dereferenced through Identity (ADR-0006); never stored here.
    let projectName = null;
    try {
      const project = await identity.getProject({ actorPartyId, projectId });
      projectName = project?.name ?? null;
    } catch { /* non-fatal: the email degrades to "your build" */ }

    await store.transaction(async (tx) => {
      if (rfp.status === 'draft') await store.updateRfp(tx, rfp.id, { status: 'sent' });
      for (const r of recipients) {
        const rawToken = ids.token();
        await store.rotateRfpRecipientToken(tx, r.id, sha256Hex(rawToken));
        const link = buildRfpLink(baseUrl, rawToken);
        try {
          await sender.send({
            to: r.email,
            subject: `You're invited to submit a proposal for ${projectName || 'your build'} on LinkNMS`,
            html: rfpInvitationEmailHtml({ link, projectName, description: rfp.description }),
          }, { env });
        } catch (err) {
          // Never log the raw token or the body — only that delivery failed.
          console.error(`[schedule] rfp-invitation email failed for ${r.id}`, err?.code ?? err?.message ?? 'unknown');
        }
      }
    });

    return readView(projectId);
  }

  // ── Token plumbing (no session; the token IS the credential) ────────────────
  async function tokenHit(token) {
    if (!token || typeof token !== 'string') throw badRequest('token is required');
    const hit = await store.getRfpRecipientByTokenHash(sha256Hex(token));
    if (!hit || hit.recipient.status === 'declined') throw notFound('token');
    return hit;
  }

  async function ownProposal(hit) {
    const proposals = await store.listRfpProposals(hit.rfp.id);
    return proposals.find((p) => p.rfp_recipient_id === hit.recipient.id) ?? null;
  }

  // The token page's project face. Deliberately a party-less read (the guest
  // holds the token, not a session — never a MemberAvailability check) — but
  // NOT an oracle: this is only reached AFTER the store resolved a real token
  // hash. `location` is reserved-null until the project gains a locality
  // column (FE types it string|null).
  async function projectPreview(projectId) {
    const project = await identity.getProjectPreview({ projectId });
    return { name: project?.name ?? null, location: project?.location ?? null };
  }

  // ── GET /rfp/token/:token — public preview (no session) ─────────────────────
  // LINA-294-ratified decision order:
  //   unknown / declined        → 404 `not_found`
  //   submitted                 → 200 WITH the proposal (the confirmation page
  //                               re-reads this endpoint even post-close)
  //   phase no longer active    → 410 `rfp_closed`
  //   otherwise                 → 200 { proposal: null }, invited→viewed
  async function previewToken({ token }) {
    const hit = await tokenHit(token);
    if (hit.recipient.status === 'submitted') {
      return {
        project: await projectPreview(hit.phase.project_id),
        recipientEmail: hit.recipient.email,
        rfp: shapeTokenRfp(hit.rfp),
        proposal: shapeProposalToken(await ownProposal(hit)),
      };
    }
    if (hit.phase.status !== 'active') throw gone('this RFP is no longer accepting proposals');
    if (hit.recipient.status === 'invited') {
      await store.transaction(async (tx) => {
        await store.updateRfpRecipientStatus(tx, hit.recipient.id, 'viewed');
      });
    }
    return {
      project: await projectPreview(hit.phase.project_id),
      recipientEmail: hit.recipient.email,
      rfp: shapeTokenRfp(hit.rfp),
      proposal: null,
    };
  }

  // ── POST /rfp/token/:token/portfolio-images — public upload (no session) ────
  // Same token ladder as submit; the uploaded object returns immediately as a
  // FileRef the page attaches to the still-editable proposal. Nothing lands on
  // the draft model — the FileRef becomes part of the proposal on submit only.
  async function uploadPortfolioImage({ token, file }) {
    const hit = await tokenHit(token);
    if (hit.recipient.status === 'submitted') throw conflict('already_submitted', 'a proposal is already submitted for this token');
    if (hit.phase.status !== 'active') throw gone('this RFP is no longer accepting proposals');
    const { fileName, contentType, buffer } = validatePortfolioImage(file);
    const { key, url } = await blob.putRef({ fileName, contentType, buffer });
    return { image: fileRefToWire({ key, filename: fileName, size: buffer.byteLength, contentType, url }) };
  }

  // ── POST /rfp/token/:token/proposal — public submit (no session) ────────────
  // LINA-294 decision order: 404 unknown/declined → 409 already_submitted →
  // 410 rfp_closed → 400 invalid_proposal (or too_many_images) → 201.
  // Append-only: ONE proposal per recipient (DB UNIQUE rfp_recipient_id is the
  // backstop); the INSERT and the recipient status flip commit in one
  // transaction (ADR-0023 §5).
  async function submitProposal({ token, body }) {
    const hit = await tokenHit(token);
    if (hit.recipient.status === 'submitted') throw conflict('already_submitted', 'a proposal is already submitted for this token');
    if (hit.phase.status !== 'active') throw gone('this RFP is no longer accepting proposals');

    const b = body ?? {};
    const companyName = assertOptionalText(b.companyName, 'companyName', 200);
    if (!companyName) throw invalidProposal('companyName is required');
    const websiteUrl = normalizeWebsite(b.websiteUrl);
    const portfolioImages = assertPortfolioImages(b.portfolioImages);
    assertNonNegativeCents(b.budgetMinCents, 'budgetMinCents', 'invalid_proposal');
    assertNonNegativeCents(b.budgetMaxCents, 'budgetMaxCents', 'invalid_proposal');
    if (b.budgetMaxCents < b.budgetMinCents) throw invalidProposal('budgetMaxCents must be >= budgetMinCents');
    assertPositiveDays(b.timelineDays, { code: 'invalid_proposal', max: 3650 });
    const comment = assertOptionalText(b.comment, 'comment', PORTFOLIO_COMMENT_MAX);

    const at = clock.now();
    const proposal = {
      id: ids.uuid(), rfp_id: hit.rfp.id, rfp_recipient_id: hit.recipient.id,
      company_name: companyName, website_url: websiteUrl,
      portfolio_images: portfolioImages,
      budget_min_cents: b.budgetMinCents, budget_max_cents: b.budgetMaxCents,
      timeline_days: b.timelineDays, comment, submitted_at: at,
    };
    await store.transaction(async (tx) => {
      await store.insertRfpProposal(tx, proposal);
      await store.updateRfpRecipientStatus(tx, hit.recipient.id, 'submitted');
    });
    return { proposal: shapeProposalToken(proposal) };
  }

  return {
    getProcurement, saveRfpDraft, addRfpAttachment, addRecipients,
    removeRecipient, sendRfp, previewToken, uploadPortfolioImage, submitProposal,
  };
}

// ── Shapes (what crosses the API boundary; never a whole store row) ───────────
function shapePhase(p) {
  return { id: p.id, kind: p.kind, name: p.name, status: p.status, sequence: p.sequence };
}

// The owner's RfpView (FE procurement.ts) — FileRefs on the wire are camelCase.
function shapeRfp(r) {
  return {
    id: r.id, phaseId: r.phase_id, description: r.description,
    attachments: toFileRefs(r.attachments),
    specialties: r.specialties ?? [],
    status: r.status, updatedAt: r.updated_at,
  };
}

function shapeRecipient(x) {
  return { id: x.id, email: x.email, status: x.status };
}

// The owner's comparison inbox row: id + the unauthenticated submitter's public
// email face (proposals are never keyed to a session).
function shapeProposal(p) {
  return {
    id: p.id, rfpRecipientId: p.rfp_recipient_id,
    recipientEmail: p.recipient_email ?? null,
    companyName: p.company_name, websiteUrl: p.website_url ?? null,
    portfolioImages: toFileRefs(p.portfolio_images),
    budgetMinCents: p.budget_min_cents, budgetMaxCents: p.budget_max_cents,
    timelineDays: p.timeline_days, comment: p.comment ?? null,
    submittedAt: p.submitted_at,
  };
}

// The token page's ProposalView (FE rfp-proposal.ts) — deliberately id-less:
// the guest must not learn the IDs of the business objects they touch.
function shapeProposalToken(p) {
  return {
    companyName: p.company_name, websiteUrl: p.website_url ?? null,
    portfolioImages: toFileRefs(p.portfolio_images),
    budgetMinCents: p.budget_min_cents, budgetMaxCents: p.budget_max_cents,
    timelineDays: p.timeline_days, comment: p.comment ?? null,
    submittedAt: p.submitted_at,
  };
}

// The token page's RfpView slice — enough to re-render the invite without
// leaking rfp id / status.
function shapeTokenRfp(rfp) {
  return {
    description: rfp.description,
    attachments: toFileRefs(rfp.attachments),
    specialties: rfp.specialties ?? [],
  };
}

function toFileRefs(list) {
  return (list ?? []).map(fileRefToWire);
}