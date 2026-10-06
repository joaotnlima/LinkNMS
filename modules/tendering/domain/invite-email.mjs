// The invite email — pure render, no I/O (LINA-412). One function builds the
// `{ subject, html, text }` an RFP recipient receives, from the RFP facts plus
// the recipient's secure personal link. It is the SINGLE source of the email
// copy, shared by the dispatch (addRecipients / reissueRecipientLink) and by
// the issuer-facing preview (pen frame 986) — so what the issuer previews is
// byte-for-byte what the bidder gets.
//
// SECURITY: the secure link is interpolated ONLY into `html`/`text` (the body).
// Callers must never put it in a subject, a header, or a log (LINA-373/294).
// The preview passes a PLACEHOLDER link, never a real token.

/** Minimal HTML escape for the few interpolated, issuer-authored strings. */
function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** A date-only, locale-stable rendering (the deadline); '' when absent. */
function dateOnly(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/**
 * @param {{
 *   rfp: { title?: string, scope_text?: string, submission_deadline?: string|Date,
 *          project_name?: string },
 *   issuerName?: string,
 *   linkUrl: string,            // the secure personal link — body only
 *   reissue?: boolean,          // a re-issued (rotated) link vs a first invite
 * }} args
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderInviteEmail({ rfp = {}, issuerName, linkUrl, reissue = false } = {}) {
  const title = rfp.title || 'pedido de proposta';
  const project = rfp.project_name || '';
  const deadline = dateOnly(rfp.submission_deadline);
  const scope = (rfp.scope_text || '').trim();
  const from = issuerName || 'o promotor';

  const subject = reissue
    ? `Link atualizado — ${title}`
    : `Convite para proposta — ${title}`;

  const intro = reissue
    ? `O seu link de acesso ao pedido de proposta "${title}" foi atualizado. `
      + 'O link anterior deixou de funcionar; use o novo abaixo.'
    : `${from} convidou-o a apresentar uma proposta para "${title}"`
      + `${project ? ` (projeto ${project})` : ''}.`;

  const deadlineLine = deadline
    ? `Prazo de submissão: ${deadline}.`
    : '';

  // ── plain text ──────────────────────────────────────────────────────────
  const textParts = [
    intro,
    scope ? `\nÂmbito:\n${scope}` : '',
    deadlineLine ? `\n${deadlineLine}` : '',
    '\nAbra o seu link pessoal e seguro para ver o processo e submeter a sua proposta:',
    linkUrl,
    '\nEste link é pessoal. Não o reencaminhe — quem tiver o link pode submeter em seu nome.',
  ].filter(Boolean);
  const text = textParts.join('\n');

  // ── html ────────────────────────────────────────────────────────────────
  const html = [
    '<!doctype html><html><body style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#1a1a1a;line-height:1.5">',
    `<p>${esc(intro)}</p>`,
    scope ? `<p><strong>Âmbito:</strong><br>${esc(scope).replaceAll('\n', '<br>')}</p>` : '',
    deadlineLine ? `<p><strong>${esc(deadlineLine)}</strong></p>` : '',
    '<p>Abra o seu link pessoal e seguro para ver o processo e submeter a sua proposta:</p>',
    `<p><a href="${esc(linkUrl)}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;border-radius:6px;text-decoration:none">Ver pedido e submeter proposta</a></p>`,
    `<p style="font-size:12px;color:#666">Ou copie: ${esc(linkUrl)}</p>`,
    '<p style="font-size:12px;color:#666">Este link é pessoal. Não o reencaminhe — quem tiver o link pode submeter em seu nome.</p>',
    '</body></html>',
  ].filter(Boolean).join('');

  return { subject, html, text };
}

// A stable, non-secret placeholder the preview uses in place of a real token,
// so a previewed email never carries a live credential (LINA-373).
export const PREVIEW_LINK_PLACEHOLDER_TOKEN = 'LINK-PESSOAL-E-SEGURO';
