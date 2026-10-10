// The /settings frame (PRD-12 §3.4; to-be/20): the portal shell, the three
// settings tabs and the save/error notice every settings page shows after an
// action. Server component — the tabs are links (an address per section).
import Link from 'next/link';

import { PortalShell, type PortalUser } from '@/components/PortalShell';
import './settings.css';

export type SettingsTab = 'personal' | 'organization' | 'billing';

const TABS: { key: SettingsTab; label: string; href: string }[] = [
  { key: 'personal', label: 'Personal', href: '/settings' },
  { key: 'organization', label: 'Organisation', href: '/settings/organization' },
  { key: 'billing', label: 'Billing', href: '/settings/billing' },
];

const SAVED: Record<string, string> = {
  profile: 'Your details were saved.',
  notifications: 'Notification preferences saved.',
  invited: 'Invitation sent. They join once they accept it.',
  role: 'Role changed. It applies at their next sign-in refresh.',
  removed: 'Member removed from your organisation.',
  subscribed: 'Subscription started.',
  plan: 'Plan changed.',
  canceled: 'Subscription canceled.',
};

export function SettingsFrame({
  user, tab, saved, error, children,
}: {
  user: PortalUser;
  tab: SettingsTab;
  saved?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <PortalShell user={user} switcherLabel="Settings" align="start">
      <section className="set">
        <h1 className="set-title">Settings</h1>
        <nav className="set-tabs" aria-label="Settings sections">
          {TABS.map((t) => (
            <Link key={t.key} href={t.href} className={`set-tab${t.key === tab ? ' is-on' : ''}`}
              aria-current={t.key === tab ? 'page' : undefined}>
              {t.label}
            </Link>
          ))}
        </nav>
        {error ? <p className="set-notice is-error" role="alert">{error}</p> : null}
        {!error && saved && SAVED[saved] ? <p className="set-notice" role="status">{SAVED[saved]}</p> : null}
        {children}
      </section>
    </PortalShell>
  );
}
