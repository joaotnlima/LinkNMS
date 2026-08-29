// Waitlist double opt-in email.
//
// The PROVIDER lives in `services/email/sender.mjs` (ADR-0007 §5) — one
// fetch-based, dependency-free Resend client shared with magic-link sign-in, so
// the API key handling, the from-address discipline, and the "never log the
// body" rule exist in exactly one place. This file owns only what is specific to
// the waitlist: the localized copy, the template, and the failure policy.
//
// ── THE ONE DELIBERATE DIFFERENCE ────────────────────────────────────────────
// The shared sender FAILS CLOSED: it throws when Resend is unconfigured or the
// send is rejected. That is correct for sign-in, where a swallowed failure is a
// silent open door. It is wrong here: a missed waitlist confirmation is a lost
// signup, not a security event, and a dev/preview deploy with no RESEND_API_KEY
// should still let the funnel be exercised end to end.
//
// So the catch lives HERE, at the call site, and NOT inside the sender — the
// asymmetry is the waitlist's choice to make, and burying a degrade branch in
// the shared client is exactly how it would one day reach sign-in.
import { sendEmail, isEmailConfigured as senderConfigured } from '@services/email/sender.mjs';

type Locale = 'pt' | 'en' | 'es';

// Localized double opt-in copy. Kept here (not in the page catalogs) because it
// is transactional email content, not page UI.
const COPY: Record<Locale, {
  subject: string;
  heading: string;
  body: string;
  cta: string;
  footer: string;
}> = {
  pt: {
    subject: 'Confirma o teu lugar na lista de espera do LinkNMS',
    heading: 'Confirma o teu email',
    body: 'Falta um passo para ficares na lista de espera do LinkNMS. Confirma que este email é teu — avisamos-te assim que houver algo real para experimentar.',
    cta: 'Confirmar email',
    footer: 'Se não foste tu, ignora este email — não te inscrevemos sem esta confirmação.'
  },
  en: {
    subject: 'Confirm your place on the LinkNMS waitlist',
    heading: 'Confirm your email',
    body: "One step left to join the LinkNMS waitlist. Confirm this email is yours — we'll tell you the moment there's something real to try.",
    cta: 'Confirm email',
    footer: "If this wasn't you, ignore this email — we don't add you without this confirmation."
  },
  es: {
    subject: 'Confirma tu lugar en la lista de espera de LinkNMS',
    heading: 'Confirma tu email',
    body: 'Falta un paso para entrar en la lista de espera de LinkNMS. Confirma que este email es tuyo — te avisamos en cuanto haya algo real que probar.',
    cta: 'Confirmar email',
    footer: 'Si no fuiste tú, ignora este email — no te inscribimos sin esta confirmación.'
  }
};

function template(locale: Locale, confirmUrl: string): string {
  const c = COPY[locale] ?? COPY.pt;
  return `<!DOCTYPE html><html lang="${locale}"><body style="margin:0;background:#f4f3f0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#0b0b0b">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fcfcfb;border:1px solid #dcdbd7;border-radius:12px;padding:32px">
      <tr><td style="font-weight:700;font-size:18px;letter-spacing:-.01em;padding-bottom:8px">LinkNMS <span style="color:#9a9a9a;font-weight:500;font-size:13px">Trust built-in.</span></td></tr>
      <tr><td style="font-size:20px;font-weight:600;padding:16px 0 8px">${c.heading}</td></tr>
      <tr><td style="font-size:15px;line-height:1.5;color:#5b5b58;padding-bottom:24px">${c.body}</td></tr>
      <tr><td><a href="${confirmUrl}" style="display:inline-block;background:#2a78d6;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 26px;border-radius:36px">${c.cta}</a></td></tr>
      <tr><td style="font-size:12px;line-height:1.5;color:#9a9a9a;padding-top:28px;border-top:1px dashed #dcdbd7;margin-top:24px">${c.footer}</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

export function isEmailConfigured() {
  return senderConfigured();
}

// Send the localized double opt-in email. Returns false (without throwing) when
// Resend isn't configured or the send fails, so the signup still succeeds in dev
// — see the asymmetry note at the top of this file.
export async function sendConfirmationEmail(
  to: string,
  locale: Locale,
  confirmUrl: string
): Promise<boolean> {
  if (!isEmailConfigured()) {
    console.warn('[email] RESEND_API_KEY not set — confirmation link:', confirmUrl);
    return false;
  }
  const c = COPY[locale] ?? COPY.pt;
  try {
    await sendEmail({
      to,
      subject: c.subject,
      html: template(locale, confirmUrl),
      // The waitlist keeps its own from-address; the sender's default is the
      // sign-in one. RESEND_FROM stays the deploy-level override it always was.
      from: process.env.RESEND_FROM || 'LinkNMS <waitlist@linknms.com>'
    });
    return true;
  } catch (err) {
    // Status/code only — the sender never logs a body, and neither do we: the
    // confirmation link in it is a bearer credential.
    console.error('[email] send failed:', (err as { code?: string })?.code ?? 'unknown');
    return false;
  }
}
