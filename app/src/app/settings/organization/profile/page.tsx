// /settings/organization/profile — the company's public directory profile
// (PRD-03 R-17, R-19, R-20; to-be/20): its listing over the last 30 days, the
// completeness checklist (never a ranking input, D-46), the editor and the
// stated portfolio. Requests for you / open requests near you arrive with
// PRD-04 (the company inbox).
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import type { PortalUser } from '@/components/PortalShell';
import { ProfileEditor } from '@/components/directory/ProfileEditor';
import '@/components/directory/directory.css';
import { getViewerProfile } from '@/lib/v2/profile';
import { getMeSettings } from '@/lib/v2/settings';
import { can } from '@/lib/v2/settings-view';
import { getCompleteness, getListingStats, getMyProfile, listMyPortfolio, listSpecialties } from '@/lib/v2/directory';
import { COMPLETENESS_LABEL, formatDay, listingStatTiles } from '@/lib/v2/directory-view';
import { sessionState } from '@/server/session';

import { SettingsFrame } from '../../SettingsFrame';
import { addPortfolioAction, deletePortfolioAction, saveDirectoryProfileAction } from './actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Company profile · LinkNMS' };

export default async function CompanyProfileSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const state = await sessionState();
  if (state.kind === 'anonymous') redirect('/sign-in?next=/settings/organization/profile');
  if (state.kind === 'unseated') redirect('/no-access');
  const [{ saved, error }, viewer, me, taxonomy] = await Promise.all([
    searchParams, getViewerProfile(), getMeSettings(), listSpecialties(),
  ]);
  const user: PortalUser = viewer ?? { displayName: 'Your account', roleLabel: '' };
  const org = me?.active_org ?? null;
  const manages = can(me, 'org:profile:manage');

  if (!org || org.kind === 'household' || !manages) {
    return (
      <SettingsFrame user={user} tab="organization" saved={saved} error={error}>
        <section className="set-card">
          <h2>Public company profile</h2>
          <p>
            {!org ? 'Pick your company first — the profile belongs to the organisation you act for.'
              : org.kind === 'household' ? 'Households are not listed in the company directory.'
                : `Only an admin or manager of ${org.legal_name} edits its public profile.`}
          </p>
          <p><Link className="set-link" href="/companies">Find companies</Link></p>
        </section>
      </SettingsFrame>
    );
  }

  const profile = await getMyProfile(org.id);
  const [completeness, stats, portfolio] = await Promise.all([
    profile ? getCompleteness(org.id) : Promise.resolve(null),
    profile ? getListingStats(org.id) : Promise.resolve(null),
    profile ? listMyPortfolio(org.id) : Promise.resolve([]),
  ]);
  const stated = portfolio.filter((e) => e.source === 'declared');

  return (
    <SettingsFrame user={user} tab="organization" saved={saved} error={error}>
      {profile ? (
        <section className="set-card" aria-labelledby="dir-listing">
          <h2 id="dir-listing">Your listing</h2>
          <div className="stats">
            {listingStatTiles(stats).map((t) => <div key={t.label} className="stat"><b>{t.value}</b><span>{t.label}</span></div>)}
          </div>
          <p>
            {profile.listed
              ? <Link className="set-link" href={`/companies/${profile.slug}`}>View your public profile (/companies/{profile.slug})</Link>
              : 'Not shown in the directory — tick “Show my company in the directory” below.'}
          </p>
        </section>
      ) : null}

      {completeness ? (
        <section className="set-card" aria-labelledby="dir-complete">
          <h2 id="dir-complete">Get found for the right work · {completeness.score}%</h2>
          <p className="cap">These help owners decide. None of them changes your position in search results.</p>
          <div className="check-list">
            {completeness.items.map((i) => (
              <span key={i.item} className={`check-row${i.done ? ' done' : ''}`}>
                <b aria-hidden="true">{i.done ? '✓' : '·'}</b>{COMPLETENESS_LABEL[i.item] ?? i.item}
                <span className="dsr">{i.done ? ' — done' : ' — missing'}</span>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <section className="set-card" aria-labelledby="dir-edit">
        <h2 id="dir-edit">{profile ? 'Edit your profile' : 'Create your public company profile'}</h2>
        {!profile ? <p>Owners and contractors find you by specialty and place. Your address in the directory is minted from the name.</p> : null}
        <ProfileEditor orgId={org.id} profile={profile} taxonomy={taxonomy} defaultName={org.legal_name} action={saveDirectoryProfileAction} />
      </section>

      {profile ? (
        <section className="set-card" aria-labelledby="dir-portfolio">
          <h2 id="dir-portfolio">Portfolio (stated)</h2>
          {stated.length ? (
            <table className="set-table">
              <tbody>
                {stated.map((e) => (
                  <tr key={e.id}>
                    <td>{e.title}<span className="set-sub">{[e.typology, e.municipality_code, e.end_date ? formatDay(e.end_date) : null].filter(Boolean).join(' · ')}</span></td>
                    <td>
                      <form action={deletePortfolioAction}>
                        <input type="hidden" name="org_id" value={org.id} />
                        <input type="hidden" name="entry_id" value={e.id} />
                        <button type="submit" className="set-btn is-danger">Remove</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="cap">No entries yet.</p>}
          <form action={addPortfolioAction} className="dform" aria-label="Add a portfolio entry">
            <input type="hidden" name="org_id" value={org.id} />
            <label className="wide">Title<input name="title" required maxLength={160} placeholder="Moradia T4 — tiled roof" /></label>
            <label>Municipality (INE)<input name="municipality_code" inputMode="numeric" maxLength={4} /></label>
            <label>Typology<input name="typology" maxLength={60} placeholder="T4" /></label>
            <label>Finished<input name="end_date" type="date" /></label>
            <div className="wide"><button type="submit" className="btn">Add entry</button></div>
          </form>
        </section>
      ) : null}
    </SettingsFrame>
  );
}
