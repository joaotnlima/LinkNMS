// The build home — `/projects/{id}` (PRD-09 O-1, O-2; flow 01 screen 11;
// to-be/20 §3). It used to redirect to the plan; now it is the build's own
// page: the four pillars from getProjectOverview (built on PillarPanel), what
// is waiting for the viewer on this build (one server read: the unread
// notifications by category), who is on the build, and — while the plan is
// empty — the way in: import the Excel plan or start it in the plan editor.
//
// Two server reads, both composed server-side; nothing is aggregated here.
// Fail-closed: a viewer who cannot read the build gets the neutral sentence.
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { PillarPanel } from '@/components/PillarPanel';
import { buildShellContextV2 } from '@/lib/v2/shell';
import { getProjectOverview, getWaitingForMe } from '@/lib/v2/build-home';
import { pillarsFromOverview, waitingRows, planIsEmpty } from '@/lib/v2/build-home-view';
import { getPortfolioConsent } from '@/lib/v2/directory';
import { openNotificationAction } from '@/app/notifications/actions';
import { setPortfolioConsentAction } from './home-actions';
import './record-home.css';
import './build-home.css';

export const dynamic = 'force-dynamic';

export default async function BuildHomePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}`);

  const [overview, waiting, consent] = await Promise.all([
    getProjectOverview(id),
    getWaitingForMe(id),
    // Owner-only read (PRD-03 R-12): null for everyone else, so the card hides.
    getPortfolioConsent(id),
  ]);
  const name = overview?.project.name ?? 'This build';
  const shell = await buildShellContextV2(id, name);

  if (!overview) {
    return (
      <PortalShell user={shell.user} builds={shell.builds} activeBuild={{ id, name }} section="overview">
        <main className="m14">
          <p className="bh-note">This build could not be loaded for you. If you were just invited, accept the invitation first.</p>
        </main>
      </PortalShell>
    );
  }

  const base = `/projects/${id}`;
  const rows = waitingRows(waiting);
  const empty = planIsEmpty(overview);

  return (
    <PortalShell user={shell.user} builds={shell.builds} activeBuild={{ id, name }} section="overview">
      <main className="m14">
        <header className="m14-head">
          <h1 className="m14-title">{name}</h1>
        </header>

        {empty && (
          <section className="bh-empty" aria-labelledby="bh-empty-t">
            <h2 id="bh-empty-t" className="bh-h">Add your plan to start the record</h2>
            <p className="bh-note">
              Upload the schedule you already have — actions, sub-actions and their dates in Excel. You map the
              columns and check the result before anything is written.
            </p>
            <div className="bh-actions">
              <Link className="btn primary" href={`${base}/plan/import`}>Upload plan (Excel)</Link>
              <Link className="btn" href={`${base}/plan`}>Build it in the plan instead</Link>
            </div>
            <a className="bh-link" href="/plan-template.xlsx" download>Download the LinkNMS plan template (.xlsx)</a>
          </section>
        )}

        <PillarPanel
          pillars={pillarsFromOverview(overview)}
          links={{ schedule: `${base}/plan`, budget: `${base}/budget`, scope: `${base}/plan` }}
        />

        <section className="bh-sec" aria-labelledby="bh-wait-t">
          <h2 id="bh-wait-t" className="bh-h">What&rsquo;s waiting for you</h2>
          {rows.length === 0 ? (
            <p className="bh-note">Nothing needs you on this build right now.</p>
          ) : (
            <ul className="bh-list">
              {rows.map((r) => (
                <li key={r.category} className="bh-item">
                  <form action={openNotificationAction}>
                    <input type="hidden" name="id" value={waiting!.categories.find((c) => c.category === r.category)!.latest.id} />
                    <input type="hidden" name="url" value={r.url} />
                    <button type="submit" className="bh-item-btn">
                      <span className="bh-count" aria-label={`${r.count} unread`}>{r.count}</span>
                      <span className="bh-item-col">
                        <span className="bh-item-k">{r.label}</span>
                        <span className="bh-item-t">{r.title}</span>
                      </span>
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <Link className="bh-link" href="/notifications">All notifications</Link>
        </section>

        <section className="bh-sec" aria-labelledby="bh-people-t">
          <h2 id="bh-people-t" className="bh-h">People on this build</h2>
          <p className="bh-note">Who takes part, their role, and the invitations still open.</p>
          <Link className="btn" href={`${base}/participants`}>Participants and invitations</Link>
        </section>

        {consent && (
          <section className="bh-sec" aria-labelledby="bh-consent-t">
            <h2 id="bh-consent-t" className="bh-h">Show this build on your companies&rsquo; profiles</h2>
            <p className="bh-note">
              {consent.show_on_profiles
                ? `Shown: the companies with a signed contract here list “${consent.name ?? name}” on their public profile. Amounts are never shown.`
                : 'Not shown: companies list this build by its state and dates only. Amounts are never shown either way.'}
            </p>
            <form action={setPortfolioConsentAction}>
              <input type="hidden" name="projectId" value={id} />
              <input type="hidden" name="show" value={consent.show_on_profiles ? 'no' : 'yes'} />
              <button type="submit" className="btn">{consent.show_on_profiles ? 'Stop showing the name' : 'Show the name'}</button>
            </form>
          </section>
        )}
      </main>
    </PortalShell>
  );
}
