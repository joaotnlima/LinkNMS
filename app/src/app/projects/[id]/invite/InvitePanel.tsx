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
import { WizardNav, ArrowRight } from '@/components/WizardNav';
import { inviteAction } from '@/app/actions';
import {
  inviteRoleOptions, inviteRoleIsChoice, type OperatingModel,
} from '@/lib/build-creation';

/** The subset of the role-copy tables this panel renders (INVITE_ROLE_COPY[x] or
 *  OWNER_INVITE_COPY — see the invite page, which resolves which). `access` is
 *  the "What they will be able to do" consent-callout copy (LINA-222). */
export interface InviteCopy {
  noun: string;
  nounPlural: string;
  emailPlaceholder: string;
  access: string;
}

/** Sentence-case a lowercase role noun for a field value ("general contractor"
 *  → "General contractor"), matching the pen — not title case. */
const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function InvitePanel({
  projectId,
  operatingModel,
  buildName,
  isDraft,
  inviteOwner,
  copy,
}: {
  projectId: string;
  operatingModel: OperatingModel | null;
  buildName: string;
  isDraft: boolean;
  /** True for a GC-created build whose first invite is the homeowner (ADR-0016
   *  §4): the target role inverts to `owner` and the copy addresses the owner. */
  inviteOwner: boolean;
  copy: InviteCopy;
}) {
  const title = inviteOwner ? `Invite the ${copy.noun}` : `Invite your ${copy.noun}`;

  return (
    <ActionForm
      action={inviteAction}
      submitLabel="Send invite"
      pendingLabel="Sending…"
      footer={({ pending }) => (
        <WizardNav back={{ href: `/projects/${projectId}/operating-model` }}>
          <button type="submit" className="btn primary" disabled={pending} aria-busy={pending}>
            {pending ? 'Sending…' : 'Send invite'}
            <ArrowRight />
          </button>
        </WizardNav>
      )}
      render={(state) =>
        state.token
          ? <InviteSent projectId={projectId} state={state} noun={copy.noun} inviteOwner={inviteOwner} />
          : null
      }
    >
      <input type="hidden" name="projectId" value={projectId} />
      {/* The model, not the role: the server maps it. A tampered field can at
          worst name a different model, and the service then rejects a role the
          build does not admit. */}
      <input type="hidden" name="operatingModel" value={operatingModel ?? ''} />
      {/* The inverted first invite (ADR-0016 §4): a flag, not a role. The service
          admits `owner` ONLY while the build has no owner member yet, so a
          tampered flag cannot mint a second owner. */}
      {inviteOwner ? <input type="hidden" name="inviteOwner" value="1" /> : null}

      <section className="bwx-card">
        <h1 className="bwx-card-title">{title}</h1>
        <p className="bwx-card-sub">
          {isDraft
            ? inviteOwner
              ? `They accept and get full visibility of the record. The moment you send it, ${buildName} becomes a shared record — everything either of you writes on it is attributed and time-stamped.`
              : `They accept, then upload or build the plan. The moment you send it, ${buildName} becomes a shared record — everything either of you writes on it is attributed and time-stamped.`
            : `They join the shared record for ${buildName}. Everything either of you writes on it is attributed and time-stamped.`}
        </p>

        {/* Name + Role — the pen's 2-col row (screen 04): who you're inviting and
            as what. Both stack on a phone, share a row ≥720px (.bwx-row2). */}
        <div className="bwx-row2">
          <label className="field">
            <span className="metric-lbl">Name or company</span>
            <input
              type="text"
              name="inviteeName"
              maxLength={200}
              autoComplete="off"
              placeholder={inviteOwner ? 'Their name' : 'Their name or company'}
            />
          </label>

          <div className="field">
            <span className="metric-lbl" id="invite-role-lbl">Role</span>
            <RoleControl
              operatingModel={operatingModel}
              inviteOwner={inviteOwner}
              noun={copy.noun}
            />
          </div>
        </div>

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
            Add their email and we will send the invitation. Leave it blank and you will get a link
            to pass on yourself.
          </span>
        </label>

        <label className="field">
          <span className="metric-lbl">Scope note (optional)</span>
          <textarea
            name="scopeNote"
            maxLength={1000}
            rows={3}
            placeholder={
              inviteOwner
                ? 'Anything you want them to know before they join.'
                : 'What are they responsible for? e.g. Full build, foundations through finishes.'
            }
          />
        </label>

        {/* Consent before access (pen callout): what the invited party can DO
            once they accept, stated plainly rather than buried in a settings
            permissions table. Copy is role-aware and V1-honest (see access in
            @/lib/build-creation — no per-contract isolation promise). */}
        <aside className="bwx-callout" role="note">
          <EyeIcon />
          <div className="bwx-callout-body">
            <p className="bwx-callout-title">What they will be able to do</p>
            <p className="bwx-callout-text">{copy.access}</p>
          </div>
        </aside>
      </section>
    </ActionForm>
  );
}

// ── Role control — read-only for the model-derived roles, a real <select> only
//    for Hybrid (ADR-0011 OQ-3) and never for the inverted homeowner invite ────
function RoleControl({
  operatingModel,
  inviteOwner,
  noun,
}: {
  operatingModel: OperatingModel | null;
  inviteOwner: boolean;
  noun: string;
}) {
  // The homeowner invite and the single-role models show a fixed, non-editable
  // value: the role is decided by the flow, not chosen here. Presentational only
  // (no form field) — the action derives `owner` from the inviteOwner flag and
  // the single role from the operating model, and the service is the authority.
  if (inviteOwner || !inviteRoleIsChoice(operatingModel)) {
    return (
      <div className="bwx-rolefixed" aria-labelledby="invite-role-lbl">
        {sentence(noun)}
      </div>
    );
  }
  // Hybrid: a genuine choice between the GC and a specialty. The service still
  // rules on which the build admits, so this can only pick among allowed roles.
  return (
    <select name="role" defaultValue="counterparty" aria-labelledby="invite-role-lbl">
      {inviteRoleOptions(operatingModel).map((o) => (
        <option key={o.value} value={o.value}>
          {sentence(o.label)}
        </option>
      ))}
    </select>
  );
}

function EyeIcon() {
  return (
    <svg
      className="bwx-callout-icon"
      viewBox="0 0 20 20"
      width="17"
      height="17"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1.5 10S4.5 4 10 4s8.5 6 8.5 6-3 6-8.5 6-8.5-6-8.5-6Z" />
      <circle cx="10" cy="10" r="2.5" />
    </svg>
  );
}

// ── M5/D5 — invite sent ─────────────────────────────────────────────────────

function InviteSent({
  projectId,
  state,
  noun,
  inviteOwner,
}: {
  projectId: string;
  state: ActionState;
  noun: string;
  inviteOwner: boolean;
}) {
  // "your general contractor" reads right; "your homeowner" does not — the owner
  // is the counterparty's principal, not their possession.
  const theNoun = inviteOwner ? `the ${noun}` : `your ${noun}`;
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
          Waiting for {theNoun} to accept. The build is live and everything you record from now on
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
        {state.emailed ? 'Or send this link directly' : `Send this link to ${theNoun}`}
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
