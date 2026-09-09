// AccountMenu — the seated user's identity + sign-out, in the portal shell
// (LINA-219). Before this, the shell drew an account glyph and a rail user
// footer but both were inert: there was no way to sign out anywhere in the
// seated app. The founder's report ("i cannot logout") is that gap.
//
// It is a native <details> popover — the same server-friendly pattern the record
// bottom-nav "More" menu uses (components/chrome.tsx) — so the shell stays a
// server component and only this leaf is a client island. The one thing that
// genuinely needs the client is Clerk's `signOut()`: it ends the session
// everywhere it is known, including the refresh token (see SignOutLink), which a
// cookie delete never did.
//
// Two variants for the shell's two account touchpoints: `bar` is the mobile top
// bar glyph; `rail` is the desktop left-rail footer with the name and role. Only
// one is visible at a time (portal-shell.css show/hides by breakpoint), so both
// render and CSS picks.
'use client';

import { useClerk } from '@clerk/nextjs';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function AccountMenu({
  displayName,
  roleLabel,
  variant,
}: {
  displayName: string;
  roleLabel: string;
  variant: 'bar' | 'rail';
}) {
  const { signOut } = useClerk();

  return (
    <details className={`psh-acct psh-acct--${variant}`}>
      <summary
        className={variant === 'rail' ? 'psh-acct-rail-btn' : 'psh-account'}
        aria-label={`Account — signed in as ${displayName}`}
      >
        {variant === 'rail' ? (
          <>
            <span className="psh-avatar" aria-hidden="true">
              {initials(displayName)}
            </span>
            <span className="psh-user-col">
              <span className="psh-user-name">{displayName}</span>
              <span className="psh-user-role">{roleLabel}</span>
            </span>
            <ChevronUpDown />
          </>
        ) : (
          <UserCircle />
        )}
      </summary>

      <div className="psh-acct-pop" role="menu">
        <div className="psh-acct-id">
          <span className="psh-acct-name">{displayName}</span>
          <span className="psh-acct-role">{roleLabel}</span>
        </div>
        <button
          type="button"
          role="menuitem"
          className="psh-acct-out"
          onClick={() => signOut({ redirectUrl: '/sign-in' })}
        >
          <SignOutIcon />
          Sign out
        </button>
      </div>
    </details>
  );
}

function UserCircle() {
  return (
    <svg viewBox="0 0 24 24" role="presentation">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="10" r="3" />
      <path d="M6.5 18.5a6 6 0 0 1 11 0" />
    </svg>
  );
}

function ChevronUpDown() {
  return (
    <svg className="psh-acct-caret" viewBox="0 0 24 24" role="presentation">
      <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg viewBox="0 0 24 24" role="presentation">
      <path d="M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3" />
      <path d="M10 12H3M6 8l-4 4 4 4" />
    </svg>
  );
}
