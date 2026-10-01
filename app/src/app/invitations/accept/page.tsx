// FR1 — the GC joins the record with the code the owner sent (LINA-57).
//
// The token proves the invitation; the SESSION says who is joining (ADR-0004).
// So this page requires a signed-in party first and then redeems the code — a
// code alone can never put an unauthenticated stranger on a record.
//
// ── LINA-225 ─────────────────────────────────────────────────────────────────
// The frame moved from the standalone `TopBar` (components/chrome.tsx, now
// deleted) to the split-screen `AuthShell` the two doors already wear. This is
// not a build, so PortalShell's BUILD mode never applied; but it IS a door —
// arrived at from an emailed link, it is the last step before someone is on a
// record — so it belongs with /sign-in and /sign-up rather than owning a
// one-consumer bar of its own. The body is still our form, not Clerk's.
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { AuthShell } from '@/components/AuthShell';
import { ActionForm } from '@/components/ActionForm';
import { acceptInviteAction } from '@/app/actions';
import { isSignedIn } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function AcceptInvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  // Signed out → prove the email by magic link first, then come straight back
  // HERE with the token intact (ADR-0007 §3/§5). Acceptance still requires a real
  // session — there is deliberately no "invite implies identity" shortcut.
  if (!(await isSignedIn())) {
    const back = `/invitations/accept${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    redirect(`/sign-in?next=${encodeURIComponent(back)}`);
  }

  return (
    <AuthShell
      title="Enter your invitation code"
      description="You will join as the general contractor. Everything either of you records from then on is attributed and time-stamped."
      promise="Join the record, and every decision after it is yours too."
      promiseShort="Join the record."
      // The TopBar carried a "‹ Home" link; the door has no nav, so the way out
      // ships as copy. Someone who opened the wrong link should not have to use
      // the browser's back button to leave a form they cannot fill in.
      legal={
        <>
          Don&rsquo;t have a code? <Link href="/">Go to your builds</Link>.
        </>
      }
    >
      <ActionForm action={acceptInviteAction} submitLabel="Join the project" pendingLabel="Joining…">
        <label className="field">
          <span className="metric-lbl">Invitation code</span>
          {/* Prefilled from ?token= so a pasted link works, but still a real
              form: accepting on GET would let any link the GC merely opens
              join them to a record. */}
          <input
            name="token"
            type="text"
            required
            defaultValue={token ?? ''}
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste the code your homeowner sent you"
          />
        </label>
      </ActionForm>
    </AuthShell>
  );
}
