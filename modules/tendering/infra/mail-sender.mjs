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

/**
 * Select a MailSender by flag. Dev/test default is `noop`; `log` is the same
 * no-op plus a one-line metadata breadcrumb (never the body). A real provider
 * name throws until its adapter is wired (LINA-406, founder-gated) — a loud
 * error at startup beats a silent drop of an invite.
 *
 * @param {{ provider?: string, logger?: object }} [opts]
 * @returns {{ provider: string, send: (m: object) => Promise<{id: string}> }}
 */
export function createMailSender({
  provider = process.env.TENDERING_MAIL_PROVIDER ?? process.env.MAIL_PROVIDER ?? 'noop',
  logger = console,
} = {}) {
  switch (String(provider || 'noop').toLowerCase()) {
    case 'noop':
      return createNoopMailSender();
    case 'log':
      return createLogMailSender({ logger });
    // Real transactional providers (e.g. Resend, LINA-406) land here behind the
    // flag once the founder picks one. Until then, asking for one is a loud
    // config error, not a silent no-op that looks like a sent invite.
    default:
      throw new Error(
        `unknown mail provider "${provider}" — set MAIL_PROVIDER to noop|log `
        + '(a real transactional provider is LINA-406, founder-gated)',
      );
  }
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
