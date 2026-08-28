'use client';

// The invite button and the one-time code it returns (LINA-57).
//
// A client component only because the code has to appear in place, without a
// navigation that would lose it. It holds the token in React state and nowhere
// else — not in the URL, not in localStorage, not in a log. The token is a
// bearer credential for joining someone's record: anywhere it is persisted is
// somewhere it can be replayed from.
import Link from 'next/link';
import { ActionForm } from '@/components/ActionForm';
import { inviteAction } from '@/app/actions';

export function InvitePanel({ projectId }: { projectId: string }) {
  return (
    <ActionForm
      action={inviteAction}
      submitLabel="Create invitation code"
      pendingLabel="Creating…"
      render={(state) =>
        state.token ? (
          <div className="stack" style={{ marginTop: 12 }}>
            <p className="metric-lbl">Send this code to your GC</p>
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
            You will get a single-use code to pass to your GC. They enter it under “Join with an
            invitation”.
          </p>
        )
      }
    >
      <input type="hidden" name="projectId" value={projectId} />
    </ActionForm>
  );
}
