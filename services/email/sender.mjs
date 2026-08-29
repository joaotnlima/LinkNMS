// The shared transactional email sender (LINA-76; ADR-0007 §5).
//
// One provider — Resend — reached over its REST API with `fetch`, so the sender
// carries ZERO npm dependencies and runs unchanged in a Next serverless route
// and in any service. It is the single client every caller uses: magic-link
// sign-in here, and the marketing-site waitlist should adopt it in place of its
// own `Resend` SDK instance (marketing-site/src/lib/email.ts) so there is one
// place the provider, the from-address discipline, and the failure contract live.
//
// FAIL CLOSED, LOUDLY (ADR-0007 §5). If `RESEND_API_KEY` is absent, `sendEmail`
// THROWS a 503 — it never falls back to logging the link or returning it, because
// a "dev convenience" that reaches production is an open sign-in with extra
// steps. The caller for the waitlist may choose to catch and degrade (a missed
// waitlist confirmation is not a security event); the sign-in path must NOT — a
// 503 there is correct, an emailed-nobody 202 is a silent open door.
//
// It never logs the message body or any link: a magic link in a log line is a
// bearer credential sitting in log storage.

// A typed error the HTTP layer maps straight to a status, same shape as the
// identity service's errors (services/identity/errors.mjs): `{ status, code }`.
function emailError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/** True when Resend is configured. Callers that degrade (waitlist) check this. */
export function isEmailConfigured(env = process.env) {
  return Boolean(env.RESEND_API_KEY);
}

/**
 * Send one transactional email through Resend.
 *
 * @param {{ to: string|string[], subject: string, html: string, from?: string }} msg
 * @param {{ env?: Object, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ id: string|null }>}  Resend's message id when it returns one.
 * @throws  503 `email_unconfigured` when RESEND_API_KEY is unset (fails closed);
 *          502 `email_send_failed`  when Resend rejects or the request errors.
 */
export async function sendEmail({ to, subject, html, from }, { env = process.env, fetchImpl = fetch } = {}) {
  const key = env.RESEND_API_KEY;
  if (!key) {
    // Loud, closed, and NEVER a link in the log — the whole point of ADR-0007 §5.
    throw emailError(503, 'email_unconfigured', 'email delivery is not configured');
  }
  if (!to || !subject || !html) {
    throw emailError(500, 'email_bad_message', 'sendEmail requires { to, subject, html }');
  }

  const sender = from || env.RESEND_FROM || 'LinkNMS <no-reply@linknms.com>';

  let res;
  try {
    res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: sender, to, subject, html }),
    });
  } catch (cause) {
    // A network/DNS failure reaching Resend. Deliberately no body/link in scope.
    console.error('[email] transport error reaching Resend');
    throw emailError(502, 'email_send_failed', 'email transport failed');
  }

  if (!res.ok) {
    // Log the STATUS only — never the request body (it carries the link) and
    // never the response, which can echo the recipient address.
    console.error('[email] Resend rejected the send', res.status);
    throw emailError(502, 'email_send_failed', 'email provider rejected the send');
  }

  let id = null;
  try {
    const data = await res.json();
    id = data?.id ?? null;
  } catch {
    // A 2xx with an unparseable body still means accepted; the id is optional.
  }
  return { id };
}
