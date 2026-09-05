'use client';

// M4 (the invite form) and M5 (the invite-sent state) — Band B step 3
// (LINA-179; originally LINA-57, email added LINA-84).
//
// Both pen screens live in one component on purpose: the raw token comes back in
// the action's return value and must be shown WITHOUT a navigation, because it is
// returned exactly once and a redirect would lose it. It is held in React state
// and nowhere else — not in the URL, not in localStorage, not in a log, not in
// analytics. The token is a bearer credential for joining someone's record;
// anywhere it is persisted is somewhere it can be replayed from.
//
// WHAT BAND B ADDED over the R0 panel:
//   * The invited party is named by the build's operating model — "general
//     contractor" or "specialty contractor", never "counterparty" (a schema word
//     nobody says out loud). The model is posted back as a hidden field and
//     mapped to a role server-side; the form never posts a role.
//   * The result is a full accept LINK, not a bare code, with copy-to-clipboard.
//     ADR-0011 OQ-1 settles V1 on copy-link (no re-send CTA), and a deep link the
//     GC can tap is the difference between onboarding over WhatsApp in ten
//     seconds and reading a hex string down a phone.
//   * A PENDING banner, not a success one. The invite is out and the build is
//     committed, but the thing the owner is waiting for — someone joining — has
//     not happened.
//
// The email stays OPTIONAL. On a jobsite the address is often not what the owner
// has to hand, and WhatsApp is. The link is shown whether or not the email went
// out: if delivery silently failed, an owner with no link cannot onboard anyone.
import { useState } from 'react';
import Link from 'next/link';

import { ActionForm, type ActionState } from '@/components/ActionForm';
import { inviteAction } from '@/app/actions';
import { INVITE_ROLE_COPY, inviteRoleFor, type OperatingModel } from '@/lib/build-creation';

export function InvitePanel({
  projectId,
  operatingModel,
}: {
  projectId: string;
  operatingModel: OperatingModel | null;
}) {
  const role = inviteRoleFor(operatingModel);
  const copy = INVITE_ROLE_COPY[role];

  return (
    <ActionForm
      action={inviteAction}
      submitLabel="Send invitation"
      pendingLabel="Sending…"
      render={(state) =>
        state.token ? <InviteSent projectId={projectId} state={state} noun={copy.noun} /> : (
          <p className="cap">
            Add their email and we will send the invitation for you. Leave it blank and you will get
            a link to pass on yourself.
          </p>
        )
      }
    >
      <input type="hidden" name="projectId" value={projectId} />
      {/* The model, not the role: the server maps it. A tampered field can at
          worst name a different model, and the service then rejects a role the
          build does not admit. */}
      <input type="hidden" name="operatingModel" value={operatingModel ?? ''} />

      <label className="field">
        <span className="metric-lbl">Their email (optional)</span>
        <input
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          placeholder={copy.emailPlaceholder}
          aria-describedby="invite-email-help"
        />
        <span id="invite-email-help" className="hint">
          We only use this to send the invitation.
        </span>
      </label>
    </ActionForm>
  );
}

// ── M5/D5 — invite sent ─────────────────────────────────────────────────────

function InviteSent({
  projectId,
  state,
  noun,
}: {
  projectId: string;
  state: ActionState;
  noun: string;
}) {
  // Built in the browser rather than returned by the action: the origin is
  // whatever host the owner is actually on (preview, prod, a tunnel), and this
  // keeps the token out of one more server-side string that could be logged.
  const acceptUrl =
    typeof window === 'undefined'
      ? ''
      : `${window.location.origin}/invitations/${encodeURIComponent(state.token ?? '')}/accept`;

  return (
    <div className="bw-sent">
      <p className="bw-pending" role="status">
        <span aria-hidden="true">⏳</span>
        <span>
          Waiting for your {noun} to accept. The build is live and everything you record from now on
          is on the shared record — they will see all of it when they join.
        </span>
      </p>

      {state.sentTo && state.emailed && (
        <p className="cap">
          <span aria-hidden="true">✓ </span>
          Invitation emailed to <strong>{state.sentTo}</strong>. They can accept straight from that
          email.
        </p>
      )}
      {state.sentTo && !state.emailed && (
        <p className="cap" role="alert">
          <span aria-hidden="true">⚠ </span>
          We could not email <strong>{state.sentTo}</strong>. The invitation is still valid — send
          them the link below instead.
        </p>
      )}

      <p className="metric-lbl">
        {state.emailed ? 'Or send this link directly' : `Send this link to your ${noun}`}
      </p>
      <CopyLink url={acceptUrl} />

      <p className="cap" role="note">
        <span aria-hidden="true">⚠ </span>
        Shown once. We store only a hash of it, so it cannot be shown again — if it is lost, create
        a new invitation.
      </p>

      <Link className="btn" href={`/projects/${projectId}`}>
        Go to the build
      </Link>
    </div>
  );
}

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard denied, or an insecure origin. The input beside the button is
      // the fallback and is always present and selectable — so the failure mode
      // is "copy it by hand", not "the link is gone". Saying nothing here is
      // deliberate: a red error about the clipboard next to a perfectly usable
      // link is noise on the screen where the owner is trying to finish.
    }
  }

  return (
    <>
      <div className="bw-linkrow">
        {/* readOnly rather than plain text: selectable and copyable on a phone,
            which is where this actually gets used. */}
        <input
          className="token"
          readOnly
          value={url}
          aria-label="Single-use invitation link"
          onFocus={(e) => e.currentTarget.select()}
        />
        <button type="button" className="btn" onClick={copy}>
          Copy link
        </button>
      </div>
      {/* role="status" so the confirmation is announced, not just seen. */}
      <p className="bw-copied" role="status">
        {copied ? '✓ Link copied' : ''}
      </p>
    </>
  );
}
