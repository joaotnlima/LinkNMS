// App chrome: the standalone top bar (brand + integrity health dot).
//
// The build-scoped BOTTOM NAV (the pen M14 tab bar) is GONE (LINA-224): every
// /projects/[id]/* surface now wears PortalShell's left-rail BUILD mode, which
// carries its own rail + mobile tab bar. `BottomNav` had no consumers left, so
// keeping it would be dead chrome pointing at a navigation the app no longer uses.
//
// `TopBar` survives for exactly one non-build surface — the invitation-accept
// flow (invitations/accept), which is not a build and so is not a PortalShell
// candidate. Once that flow gets its own frame this whole file can be deleted;
// tracked as a follow-up.
import Link from 'next/link';
import { Mark } from './icons';

export function TopBar({ back }: { back?: { href: string; label: string } }) {
  return (
    <header className="topbar">
      {back ? (
        <Link className="back" href={back.href}>
          ‹ {back.label}
        </Link>
      ) : (
        <span className="brand">
          <Mark className="mk" />
          LinkNMS
        </span>
      )}
      <span className="health" title="Ledger integrity signal">
        <span className="dot" />
        integrity ok
      </span>
    </header>
  );
}

// The M14 bottom tab bar that used to live here (Builds · Plan · Docs · More,
// ADR-0015 §6) is RETIRED (LINA-224). Its job — the build-scoped nav on every
// /projects/[id]/* page — is now PortalShell's, which draws the same tabs on
// mobile and a left rail on desktop from one component. See git history for the
// old markup; there is no reason to keep a second, unreferenced copy of it.

// `DemoBanner` is GONE (LINA-57), and deliberately not replaced by a quieter
// variant. The surfaces now render persisted data or fail loudly; there is no
// third state left for a banner to warn about, and keeping a dormant one would
// re-open the door to shipping fixtures behind a notice nobody reads.
