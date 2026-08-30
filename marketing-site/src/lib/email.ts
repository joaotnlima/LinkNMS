import { Resend } from 'resend';

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
  // Hexes are literal because email clients do not support CSS custom
  // properties. Identity colours re-based at LINA-86 — keep in step with
  // design-system/tokens.json by hand.
  return `<!DOCTYPE html><html lang="${locale}"><body style="margin:0;background:#f4f3f0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#16181d">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fbfaf7;border:1px solid #dcdbd7;border-radius:12px;padding:32px">
      <tr><td style="font-weight:700;font-size:18px;letter-spacing:-.01em;padding-bottom:8px">LinkNMS <span style="color:#9a9a9a;font-weight:500;font-size:13px">Trust built-in.</span></td></tr>
      <tr><td style="font-size:20px;font-weight:600;padding:16px 0 8px">${c.heading}</td></tr>
      <tr><td style="font-size:15px;line-height:1.5;color:#5b5b58;padding-bottom:24px">${c.body}</td></tr>
      <tr><td><a href="${confirmUrl}" style="display:inline-block;background:#3e5c8a;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 26px;border-radius:36px">${c.cta}</a></td></tr>
      <tr><td style="font-size:12px;line-height:1.5;color:#9a9a9a;padding-top:28px;border-top:1px dashed #dcdbd7;margin-top:24px">${c.footer}</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

export function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

// Send the localized double opt-in email. Returns false (without throwing) when
// Resend isn't configured so the signup still succeeds in dev.
export async function sendConfirmationEmail(
  to: string,
  locale: Locale,
  confirmUrl: string
): Promise<boolean> {
  if (!isEmailConfigured()) {
    console.warn('[email] RESEND_API_KEY not set — confirmation link:', confirmUrl);
    return false;
  }
  const from = process.env.RESEND_FROM || 'LinkNMS <waitlist@linknms.com>';
  const c = COPY[locale] ?? COPY.pt;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from,
    to,
    subject: c.subject,
    html: template(locale, confirmUrl)
  });
  if (error) {
    console.error('[email] send failed:', error);
    return false;
  }
  return true;
}
