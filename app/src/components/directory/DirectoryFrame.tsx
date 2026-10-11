// The public directory frame (PRD-03 D1/D2): brand, "Find companies" and
// "For companies" (the company's own listing), and a sign-in door for
// visitors. Server component — the directory is public and indexable (R-9).
import Link from 'next/link';

import './directory.css';

export function DirectoryFrame({
  on, signedIn, context, children,
}: {
  on: 'search' | 'listing' | null;
  signedIn: boolean;
  /** The owner-blue strip under the top bar, e.g. "Finding companies for Casa da Encosta". */
  context?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="dir">
      <header className="dtop">
        <Link className="brand" href="/">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#3e5c8a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></svg>
          LinkNMS
        </Link>
        <nav aria-label="Directory">
          <Link className={on === 'search' ? 'on' : undefined} href="/companies" aria-current={on === 'search' ? 'page' : undefined}>Find companies</Link>
          <Link className={on === 'listing' ? 'on' : undefined} href="/settings/organization/profile">For companies</Link>
        </nav>
        {signedIn ? <Link className="btn" href="/">Your builds</Link> : <Link className="btn" href="/sign-in">Sign in</Link>}
      </header>
      {context ? <div className="dctx">{context}</div> : null}
      {children}
    </div>
  );
}
