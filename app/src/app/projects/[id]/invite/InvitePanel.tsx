'use client';

// The invite form and the one-time code it returns (LINA-57; email added LINA-84).
//
// A client component only because the code has to appear in place, without a
// navigation that would lose it. It holds the token in React state and nowhere
// else — not in the URL, not in localStorage, not in a log. The token is a
// bearer credential for joining someone's record: anywhere it is persisted is
// somewhere it can be replayed from.
//
// The email field is OPTIONAL by design. Filled in, we mail the GC the accept
// link. Left blank, this is the original copy-the-code flow, which still has to
// work: on a jobsite the GC's address is often not the thing the owner has to
// hand, and WhatsApp is.
//
// THE rule for the result state: the code is shown whether or not the email
// went out. "We emailed them" is an additional reassurance, never a replacement
// for the owner holding a link — if delivery silently failed, an owner with no
// code is an owner who cannot onboard their GC at all.
import Link from 'next/link';
import { ActionForm } from '@/components/ActionForm';
import { inviteAction } from '@/app/actions';

export function InvitePanel({ projectId }: { projectId: string }) {
  return (
    <ActionForm
      action={inviteAction}
      submitLabel="Create invitation"
      pendingLabel="Creating…"
      render={(state) =>
        state.token ? (
          <div className="stack" style={{ marginTop: 12 }}>
            {state.sentTo && state.emailed && (
              <p className="cap" role="status">
                <span aria-hidden="true">✓ </span>
                Invitation emailed to <strong>{state.sentTo}</strong>. They can accept straight from
                that email.
              </p>
            )}
            {state.sentTo && !state.emailed && (
              <p className="cap" role="alert">
                <span aria-hidden="true">⚠ </span>
                We could not email <strong>{state.sentTo}</strong>. The invitation is still valid —
                send them the code below instead.
              </p>
            )}
            <p className="metric-lbl">
              {state.emailed ? 'Or send this code directly' : 'Send this code to your GC'}
            </p>
            {/* readOnly rather than plain text: selectable and copyable on a
                phone, which is where this actually gets used. */}
            <input
              className="token"
              readOnly
              value={state.token}
              aria-label="Single-use invitation code"
              onFocus={(e) => e.currentTarget.select()}
            />
            <p className="cap" role="note">
              <span aria-hidden="true">⚠ </span>
              Shown once. We store only a hash of it, so it cannot be shown again — if it is lost,
              create a new invitation.
            </p>
            <Link className="btn" href={`/projects/${projectId}`}>
              Go to the project
            </Link>
          </div>
        ) : (
          <p className="cap">
            Add their email and we will send the invitation for you. Leave it blank and you will get
            a single-use code to pass on yourself — they enter it under “Join with an invitation”.
          </p>
        )
      }
    >
      <input type="hidden" name="projectId" value={projectId} />
      <label className="field">
        <span className="metric-lbl">Your GC’s email (optional)</span>
        <input
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          placeholder="gc@example.com"
          aria-describedby="invite-email-help"
        />
      </label>
      <p className="cap" id="invite-email-help">
        We only use this to send the invitation.
      </p>
    </ActionForm>
  );
}
