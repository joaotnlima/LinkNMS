// The "a question was answered" notice — pure render, no I/O (PRD-08 H-8).
//
// Sent to each TOKEN-ONLY bidder of the RFP (a recipient with no platform org,
// so no notification centre to land in) when the issuer answers a question.
// Same MailSender port and the same `{ subject, html, text }` shape as the
// invite (invite-email.mjs).
//
// DELIBERATELY NO LINK. A personal link is a bearer credential stored only as
// its sha256 (gap S1, LINA-373): the raw token cannot be recovered to put in
// this mail, and minting a fresh one would revoke the link the bidder already
// holds. So the notice names the RFP, quotes the question and the answer
// (public to every bidder — the asker is never named), and tells the bidder to
// reopen the personal link from their invitation email.

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * @param {{ rfp: { title?: string, project_name?: string },
 *           question: string, answer: string }} args
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderClarificationAnsweredEmail({ rfp = {}, question, answer } = {}) {
  const title = rfp.title || 'pedido de proposta';
  const project = rfp.project_name ? ` (projeto ${rfp.project_name})` : '';
  const subject = `Esclarecimento publicado — ${title}`;
  const intro = `Foi publicado um esclarecimento no pedido de proposta "${title}"${project}. `
    + 'É enviado a todos os concorrentes; quem perguntou não é identificado.';
  const reopen = 'Para ver todos os esclarecimentos, abra o link pessoal do email de convite.';

  const text = [
    intro,
    `\nPergunta:\n${question}`,
    `\nResposta:\n${answer}`,
    `\n${reopen}`,
  ].join('\n');

  const html = [
    '<!doctype html><html><body style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#1a1a1a;line-height:1.5">',
    `<p>${esc(intro)}</p>`,
    `<p><strong>Pergunta:</strong><br>${esc(question).replaceAll('\n', '<br>')}</p>`,
    `<p><strong>Resposta:</strong><br>${esc(answer).replaceAll('\n', '<br>')}</p>`,
    `<p style="font-size:12px;color:#666">${esc(reopen)}</p>`,
    '</body></html>',
  ].join('');

  return { subject, html, text };
}
