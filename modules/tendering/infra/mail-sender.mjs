// MailSender — the one port the tendering dispatch sends a recipient's secure
// personal link through (LINA-412, slice E of LINA-407). The contract is a
// single method:
//
//   send({ to, subject, html, text, headers }) -> { id }
//
// WHY A PORT, SHIPPABLE WITHOUT A PROVIDER DECISION
// The transactional email provider is a founder decision (LINA-406) that has
// not landed. Rather than block the invite flow on it, the dispatch is wired to
// THIS interface and the dev default is a no-op/log adapter: `addRecipients` and
// `reissueRecipientLink` already "send" (and record delivery breadcrumbs) with
// nothing on the wire. When the provider is chosen, a real adapter plugs in
// behind the `MAIL_PROVIDER` flag — the callers never change.
//
// SECURITY — THE TOKEN LIVES ONLY IN THE BODY (LINA-373/LINA-294)
// A personal RFP link is an anonymous bearer credential: whoever holds the URL
// can bid. So the secure link (and its token) is placed ONLY in `html`/`text`,
// never in a path, a header, or a log line. The log adapter below logs the
// delivery metadata (recipient, subject, message id) and NEVER the body or
// headers, so a token cannot leak into logs the way it never leaks into a URL.
import { randomUUID } from 'node:crypto';

import { sendEmail } from '../../../services/email/sender.mjs';

/**
 * Select a MailSender by flag. The provider resolves, in order, from
 * `TENDERING_MAIL_PROVIDER`, then `MAIL_PROVIDER`, then an env gate: when a
 * `RESEND_API_KEY` is present we default to the real `resend` adapter, otherwise
 * to `noop`. This is the LINA-417 go-live flip — provision the key in Vercel and
 * the invite flow sends for real, no code or flag change required. `log` is the
 * no-op plus a one-line metadata breadcrumb (never the body). An unknown
 * provider name throws — a loud config error at startup beats a silent drop of
 * an invite.
 *
 * @param {{ provider?: string, logger?: object, env?: object, fetchImpl?: typeof fetch }} [opts]
 * @returns {{ provider: string, send: (m: object) => Promise<{id: string}> }}
 */
export function createMailSender({
  provider = process.env.TENDERING_MAIL_PROVIDER
    ?? process.env.MAIL_PROVIDER
    ?? (process.env.RESEND_API_KEY ? 'resend' : 'noop'),
  logger = console,
  env = process.env,
  fetchImpl,
} = {}) {
  switch (String(provider || 'noop').toLowerCase()) {
    case 'noop':
      return createNoopMailSender();
    case 'log':
      return createLogMailSender({ logger });
    case 'resend':
      return createResendMailSender({ env, fetchImpl });
    default:
      throw new Error(
        `unknown mail provider "${provider}" — set MAIL_PROVIDER to noop|log|resend`,
      );
  }
}

/**
 * Resend adapter (LINA-412 port → LINA-417 go-live). It owns NO transport of its
 * own: it delegates to the one shared, dependency-free Resend client in
 * `services/email/sender.mjs` (ADR-0007 §5), so the API key handling, the
 * from-address discipline, and the "never log the body/link" rule live in
 * exactly one place for sign-in, the waitlist, and tendering alike.
 *
 * FAILS CLOSED on selection: choosing `resend` without a `RESEND_API_KEY` throws
 * here, not on the first send — a misconfigured go-live is caught at startup.
 * The sender identity is `TENDERING_MAIL_FROM` when set, else the shared
 * `RESEND_FROM` default, so tendering invites can carry their own From without
 * forking the client.
 *
 * @param {{ env?: object, fetchImpl?: typeof fetch }} [opts]
 */
export function createResendMailSender({ env = process.env, fetchImpl } = {}) {
  if (!env.RESEND_API_KEY) {
    throw new Error(
      'mail provider "resend" selected but RESEND_API_KEY is not set — '
      + 'provision it (LINA-417) or set MAIL_PROVIDER to log|noop',
    );
  }
  const from = env.TENDERING_MAIL_FROM || undefined;
  return {
    provider: 'resend',
    async send({ to, subject, html, text }) {
      // The token-bearing link is in html/text only; the shared sender logs the
      // STATUS of a failure, never the payload. On failure it throws, which the
      // invite dispatch catches and swallows (leaving the lane re-issuable) so
      // the body is never surfaced on an error path either.
      const { id } = await sendEmail(
        { to, subject, html, text, ...(from ? { from } : {}) },
        { env, ...(fetchImpl ? { fetchImpl } : {}) },
      );
      return { id: id ?? `resend-${randomUUID()}` };
    },
  };
}

/** No-op sender: accepts a message, returns a synthetic id, sends nothing. */
export function createNoopMailSender() {
  return {
    provider: 'noop',
    async send() {
      return { id: `noop-${randomUUID()}` };
    },
  };
}

/**
 * Log sender: the no-op plus a single metadata line. Logs `to`, `subject`, and
 * the message id ONLY — never `html`/`text`/`headers`, which carry the secure
 * link. This is the invariant the token-never-in-logs test guards (LINA-373).
 */
export function createLogMailSender({ logger = console } = {}) {
  const write = (logger.info ?? logger.log ?? (() => {})).bind(logger);
  return {
    provider: 'log',
    async send({ to, subject }) {
      const id = `log-${randomUUID()}`;
      // Deliberately NOT the body/headers: the token lives there (LINA-294).
      write('[tendering.mail] send', { id, to, subject });
      return { id };
    },
  };
}

/**
 * Test/local double: captures every message in `sent` so a test can assert the
 * dispatch called it and inspect the (token-bearing) body. Not for production.
 */
export function createCapturingMailSender() {
  const sent = [];
  return {
    provider: 'memory',
    sent,
    async send(message) {
      const id = `mem-${sent.length + 1}`;
      sent.push({ id, ...message });
      return { id };
    },
  };
}
