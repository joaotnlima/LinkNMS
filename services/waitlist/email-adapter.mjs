// Waitlist — the Postgres-backed welcome-email port for the deployed target
// (LINA-127; ADR-0007 §5).
//
// The sender is shared (services/email/sender.mjs) and FAILS CLOSED — it throws
// when Resend is unconfigured or the send is rejected, which is correct for
// sign-in where a swallowed failure is a silent open door. It is WRONG here: a
// missed D-2 welcome email is a lost follow-up, never a security event, and a
// dev/preview deploy with no RESEND_API_KEY should still let the funnel be
// exercised end to end.
//
// So the catch lives HERE, at the waitlist's call site, and NOT inside the shared
// sender — the same asymmetry note as the marketing-site confirmation email
// (marketing-site/src/lib/email.ts). The waiter resolves to a boolean
// (`welcomeEmailSent`), never a throw, so a committed signup can never be turned
// into a 500 by email delivery.
import { sendEmail as send } from '../email/sender.mjs';

const DEFAULT_FROM = 'LinkNMS <waitlist@linknms.com>';

// A minimal D-2 welcome template. The full branded template is the Frontend/
// product designer's D-2 artifact (linkNMS.pen); this is a working, honest
// placeholder so the trigger can be proven end to end before the brand lands.
function welcomeHtml(locale) {
  const t = {
    en: { heading: "You're on the LinkNMS waitlist", body: "Thanks for reserving your seat. We'll be in touch the moment there's something real to try." },
    pt: { heading: 'Estás na lista de espera do LinkNMS', body: 'Obrigado por reservares o teu lugar. Avisamos-te assim que houver algo real para experimentar.' },
    es: { heading: 'Estás en la lista de espera de LinkNMS', body: 'Gracias por reservar tu lugar. Te avisamos en cuanto haya algo real que probar.' },
  }[locale] ?? {
    heading: "You're on the LinkNMS waitlist",
    body: "Thanks for reserving your seat. We'll be in touch the moment there's something real to try.",
  };
  return `<!DOCTYPE html><html><body style="margin:0;background:#f4f3f0;font-family:system-ui,sans-serif;color:#16181d;padding:32px">
  <p style="font-weight:700;margin:0 0 16px">LinkNMS</p>
  <h1 style="font-size:20px;margin:0 0 8px">${t.heading}</h1>
  <p style="color:#5b5b58;line-height:1.5">${t.body}</p>
</body></html>`;
}

const SUBJECT = {
  en: "You're on the LinkNMS waitlist",
  pt: 'Estás na lista de espera do LinkNMS',
  es: 'Estás en la lista de espera de LinkNMS',
};

/**
 * Send the D-2 welcome email. Returns `true` on accepted delivery, `false`
 * otherwise — never throws, so a signup can never be failed by email.
 * @param {string} to
 * @param {Object} [opts]
 * @param {'en'|'pt'|'es'} [opts.locale]
 * @param {string|null} [opts.url]  Optional reserved link (unused in v1).
 * @param {Object} [deps] { env, fetchImpl } passed to the shared sender.
 */
export async function sendWelcome(to, { locale = 'en', url = null } = {}, deps = {}) {
  void url; // reserved for a future confirmation/link stage; not in Phase 1.
  if (!to) return false;
  try {
    await send({
      to,
      subject: SUBJECT[locale] ?? SUBJECT.en,
      html: welcomeHtml(locale),
      from: DEFAULT_FROM,
    }, deps);
    return true;
  } catch (err) {
    // Status/code only — the sender never logs a body, and neither do we. A
    // missed welcome email is not a security event (ADR-0007 §5): degrade.
    console.error('[waitlist] welcome email send failed:', (err && err.code) ?? 'unknown');
    return false;
  }
}
