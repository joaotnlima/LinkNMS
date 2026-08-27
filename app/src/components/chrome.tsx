// App chrome: the top bar (brand + integrity health dot) and the bottom nav that
// ties the four surfaces together. Mobile-first; the shell caps width for desktop.
import Link from 'next/link';
import { Mark, HomeIcon, DecisionIcon, ChangeIcon, AuditIcon } from './icons';
import { isDemo } from '@/lib/api';

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

type Tab = 'home' | 'decisions' | 'change-orders' | 'audit';

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

export function DemoBanner() {
  if (!isDemo()) return null;
  return (
    <div className="demo-banner" role="note">
      <strong>Demo data.</strong> Live Slices 1–4 API routes aren't wired to this deployment yet — showing the
      Maple Street scenario. Set <code>LINKNMS_API_BASE</code> to read the live contract endpoints.
    </div>
  );
}
