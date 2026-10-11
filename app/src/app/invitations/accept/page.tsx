// FR1 — an invited party joins the record with the code they were sent (LINA-57).
//
// The token proves the invitation; the SESSION says who is joining (ADR-0004).
// So this page requires a signed-in party first and then redeems the code — a
// code alone can never put an unauthenticated stranger on a record.
//
// THE ROLE IS THE INVITATION'S, NOT A GUESS (PRD-01 bug batch). This page used to
// promise "you will join as the general contractor" to everyone. When the code
// arrives in the link (?token=), the same unauthenticated preview the deep-link
// landing uses names the role the invitation actually carries — its trade when
// it names one ("join as Electrical contractor", PRD-09 O-5); with no code yet
// (typed by hand) the copy stays role-neutral rather than inventing one.
import { redirect } from 'next/navigation';
import { TopBar } from '@/components/chrome';
import { ActionForm } from '@/components/ActionForm';
import { acceptInviteAction } from '@/app/actions';
import { isSignedIn } from '@/server/session';
import { getInvitationPreview } from '@/lib/v2/invitations';

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

  // A 404/limit on the preview is the generic copy, never an error — the accept
  // POST re-verifies the token regardless (invitations.ts).
  const preview = token ? await getInvitationPreview(token).catch(() => null) : null;
  const joinAs = preview
    ? `You will join${preview.projectName ? ` ${preview.projectName}` : ' the build'} as ${preview.roleLabel}.`
    : 'You will join in the role your invitation names.';

  return (
    <>
      <TopBar back={{ href: '/', label: 'Home' }} />
      <main className="screen">
        <div>
          <div className="crumbs">Join a shared record</div>
          <h1 className="scr">Enter your invitation code</h1>
          <p className="sub">
            {joinAs} Everything anyone on the build records from then on is attributed and
            time-stamped.
          </p>
        </div>

        <section className="card">
          <ActionForm
            action={acceptInviteAction}
            submitLabel="Join the project"
            pendingLabel="Joining…"
          >
            <label className="field">
              <span className="metric-lbl">Invitation code</span>
              {/* Prefilled from ?token= so a pasted link works, but still a real
                  form: accepting on GET would let any link the invitee merely
                  opens join them to a record. */}
              <input
                name="token"
                type="text"
                required
                defaultValue={token ?? ''}
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste the code you were sent"
              />
            </label>
          </ActionForm>
        </section>
      </main>
    </>
  );
}
