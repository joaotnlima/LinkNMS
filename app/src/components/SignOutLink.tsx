// Sign out — Clerk's, and only Clerk's (LINA-124).
//
// The old `signOutAction` server action deleted the `lnms_session` cookie. There
// is no such cookie any more, and a server action that cleared a session would
// be a second authority on whether one exists. Clerk's `signOut()` ends the
// session everywhere it is known — including its own refresh token — which a
// cookie delete never did.
'use client';

import { useClerk } from '@clerk/nextjs';

export function SignOutLink({ redirectUrl = '/sign-in' }: { redirectUrl?: string }) {
  const { signOut } = useClerk();
  return (
    <button type="button" className="linkish" onClick={() => signOut({ redirectUrl })}>
      Sign out and use another
    </button>
  );
}
