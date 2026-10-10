// /settings — personal settings (PRD-12 N-8; to-be/20): name, language and
// notification preferences per type and channel (N-2). The onboarding promise
// "you can change it later in settings" lands here.
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import type { PortalUser } from '@/components/PortalShell';
import { getViewerProfile } from '@/lib/v2/profile';
import { getNotificationPreferences } from '@/lib/v2/notifications';
import { preferenceRows } from '@/lib/v2/notifications-view';
import { getMeSettings } from '@/lib/v2/settings';
import { LOCALES } from '@/lib/v2/settings-view';
import { sessionState } from '@/server/session';

import { savePreferencesAction, saveProfileAction } from './actions';
import { SettingsFrame } from './SettingsFrame';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Settings · LinkNMS' };

export default async function PersonalSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const state = await sessionState();
  if (state.kind === 'anonymous') redirect('/sign-in?next=/settings');
  if (state.kind === 'unseated') redirect('/no-access');

  const [{ saved, error }, profile, me, prefs] = await Promise.all([
    searchParams, getViewerProfile(), getMeSettings(), getNotificationPreferences(),
  ]);
  const user: PortalUser = profile ?? { displayName: 'Your account', roleLabel: '' };
  const rows = preferenceRows(prefs);

  return (
    <SettingsFrame user={user} tab="personal" saved={saved} error={error}>
      <section className="set-card" aria-labelledby="set-me">
        <h2 id="set-me">Your details</h2>
        <p>How you appear on every decision you record, and the language you read LinkNMS in.</p>
        {me ? (
          <form action={saveProfileAction}>
            <label className="set-field">
              Name
              <input name="name" defaultValue={me.person.name} required maxLength={200} autoComplete="name" />
            </label>
            <label className="set-field">
              Language
              <select name="locale" defaultValue={me.person.locale}>
                {LOCALES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </label>
            <p className="set-sub">Signed in as {me.person.email}. Your e-mail and password are managed at sign-in.</p>
            <p><button type="submit" className="set-btn">Save details</button></p>
          </form>
        ) : (
          <p>Your account is still being set up — try again in a moment.</p>
        )}
      </section>

      <section className="set-card" id="notifications" aria-labelledby="set-ntf">
        <h2 id="set-ntf">Notifications</h2>
        <p>
          What reaches you in LinkNMS and by e-mail. Turning off “In LinkNMS” also stops the e-mail for that type.{' '}
          <Link className="set-link" href="/notifications">Open the notification centre</Link>
        </p>
        {rows.length ? (
          <form action={savePreferencesAction}>
            <input type="hidden" name="categories" value={rows.map((r) => r.category).join(',')} />
            <table className="set-table">
              <thead>
                <tr><th>Type</th><th className="is-center">In LinkNMS</th><th className="is-center">E-mail</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.category}>
                    <td>{r.label}<span className="set-sub">{r.hint}</span></td>
                    <td className="is-center">
                      <input type="checkbox" name={`${r.category}:in_app`} defaultChecked={r.inApp}
                        aria-label={`${r.label} in LinkNMS`} />
                    </td>
                    <td className="is-center">
                      <input type="checkbox" name={`${r.category}:email`} defaultChecked={r.email}
                        aria-label={`${r.label} by e-mail`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p><button type="submit" className="set-btn">Save notification preferences</button></p>
          </form>
        ) : (
          <p>Your account is still being set up — try again in a moment.</p>
        )}
      </section>
    </SettingsFrame>
  );
}
