// FR1 — the GC joins the record with the code the owner sent (LINA-57).
//
// The token proves the invitation; the SESSION says who is joining (ADR-0004).
// So this page requires a signed-in party first and then redeems the code — a
// code alone can never put an unauthenticated stranger on a record.
import { redirect } from 'next/navigation';
import { TopBar } from '@/components/chrome';
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
    <>
      <TopBar back={{ href: '/', label: 'Home' }} />
      <main className="screen">
        <div>
          <div className="crumbs">Join a shared record</div>
          <h1 className="scr">Enter your invitation code</h1>
          <p className="sub">
            You will join as the general contractor. Everything either of you records from then on is
            attributed and time-stamped.
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
        </section>
      </main>
    </>
  );
}
