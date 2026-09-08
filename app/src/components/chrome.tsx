// App chrome: the top bar (brand + integrity health dot) and the bottom nav that
// ties the four surfaces together. Mobile-first; the shell caps width for desktop.
import Link from 'next/link';
import { Mark, HomeIcon, DecisionIcon, ChangeIcon, AuditIcon } from './icons';

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

// 'plan' is a valid place to BE without being one of the four tabs (LINA-207).
// The plan surface is reached from the dashboard, not from this nav, and marking
// Home as current there would tell a screen-reader user they are somewhere they
// are not. No item matches it, so nothing is highlighted — which is the truth.
type Tab = 'home' | 'decisions' | 'change-orders' | 'audit' | 'plan';

export function BottomNav({ projectId, active }: { projectId: string; active: Tab }) {
  const items: { key: Tab; href: string; label: string; Icon: (p: { className?: string }) => React.JSX.Element }[] = [
    { key: 'home', href: `/projects/${projectId}`, label: 'Home', Icon: HomeIcon },
    { key: 'decisions', href: `/projects/${projectId}/decisions`, label: 'Decisions', Icon: DecisionIcon },
    { key: 'change-orders', href: `/projects/${projectId}/change-orders`, label: 'Changes', Icon: ChangeIcon },
    { key: 'audit', href: `/projects/${projectId}/audit`, label: 'Audit', Icon: AuditIcon },
  ];
  return (
    <nav className="botnav" aria-label="Primary">
      {items.map(({ key, href, label, Icon }) => (
        <Link key={key} href={href} className={key === active ? 'active' : undefined} aria-current={key === active ? 'page' : undefined}>
          <Icon />
          {label}
        </Link>
      ))}
    </nav>
  );
}

// `DemoBanner` is GONE (LINA-57), and deliberately not replaced by a quieter
// variant. The surfaces now render persisted data or fail loudly; there is no
// third state left for a banner to warn about, and keeping a dormant one would
// re-open the door to shipping fixtures behind a notice nobody reads.
