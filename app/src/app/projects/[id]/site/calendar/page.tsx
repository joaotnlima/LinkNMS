// Who is on site when — `/projects/{id}/site/calendar` (PRD-10 E-10, E-11).
// Derived by the planning module from task dates, assignees and locations
// (getSiteCalendar); this page lays it out as lanes per location and
// organisation over the working days, and lists the overlaps — two trades at
// one location on one day — with a link to both tasks.
import { Fragment } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';

import { isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContextV2 } from '@/lib/v2/shell';
import { getRecordV2 } from '@/lib/v2/record';
import { V2Error } from '@/lib/v2/client';
import { getSiteCalendarV2 } from '@/lib/v2/execution';
import {
  calendarDays, calendarPlaces, clashCells, dayWords, overlapWords, weekdayOf, type V2SiteCalendar,
} from '@/lib/v2/execution-view';
import '@/components/site.css';

export const dynamic = 'force-dynamic';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export default async function SiteCalendarPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/site/calendar`);
  const sp = await searchParams;
  const from = sp.from && ISO.test(sp.from) ? sp.from : undefined;
  const to = sp.to && ISO.test(sp.to) ? sp.to : undefined;
  let cal: V2SiteCalendar | null = null;
  let error: string | null = null;
  const record = await getRecordV2(id);
  try {
    cal = await getSiteCalendarV2(id, from, to);
  } catch (err) {
    if (!(err instanceof V2Error)) throw err;
    error = err.status === 404 ? 'This build’s site calendar is not available to you.' : (err.detail ?? Object.values(err.errors ?? {})[0] ?? err.message);
  }
  const name = record?.name ?? 'This build';
  const shell = await buildShellContextV2(id, name);
  const days = cal ? calendarDays(cal) : [];
  const places = cal ? calendarPlaces(cal) : [];
  const clash = cal ? clashCells(cal) : new Set<string>();

  return (
    <PortalShell user={shell.user} builds={shell.builds} activeBuild={{ id, name }} crumb="Site calendar">
      <main className="ste-page" style={{ maxWidth: 1100 }}>
        <header className="ste-head">
          <h1>Who is on site when</h1>
          <form className="ste-row" method="get" action={`/projects/${id}/site/calendar`}>
            <input className="ste-field" type="date" name="from" defaultValue={cal?.from ?? from} aria-label="From" style={{ maxWidth: 170 }} />
            <input className="ste-field" type="date" name="to" defaultValue={cal?.to ?? to} aria-label="To" style={{ maxWidth: 170 }} />
            <button className="btn sm" type="submit">Show</button>
          </form>
        </header>
        <p className="ste-quiet">
          From the plan: each task’s organisation at the task’s location on every working day of its dates.
          {cal?.unassigned_count ? ` ${cal.unassigned_count} dated task(s) have no organisation yet and are not shown.` : ''}
        </p>
        {error ? <p role="alert" className="ste-error">{error}</p> : null}

        {cal && cal.overlaps.length ? (
          <section className="ste-card" aria-label="Overlaps">
            <h2>Two trades in the same place</h2>
            <ul className="ste-overlaps">
              {cal.overlaps.map((o) => (
                <li key={`${o.location_id}-${o.from}-${o.tasks.map((t) => t.task_id).join('-')}`}>
                  {overlapWords(o)} ·{' '}
                  {o.tasks.map((t, i) => (
                    <span key={t.task_id}>{i ? ' · ' : ''}<Link href={`/projects/${id}/plan?task=${t.task_id}`}>{t.task_name}</Link></span>
                  ))}
                </li>
              ))}
            </ul>
          </section>
        ) : cal ? <p className="ste-quiet">No overlaps in this window.</p> : null}

        {cal && days.length ? (
          <div className="ste-cal" role="region" aria-label="Site calendar" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Where · who</th>
                  {days.map((d) => <th key={d} scope="col" title={dayWords(d)}>{weekdayOf(d)} {d.slice(8)}/{d.slice(5, 7)}</th>)}
                </tr>
              </thead>
              <tbody>
                {places.map((place) => (
                  <Fragment key={`p-${place.locationId ?? 'none'}`}>
                    <tr>
                      <th className="ste-place" colSpan={days.length + 1} scope="rowgroup">{place.label}</th>
                    </tr>
                    {place.lanes.map((lane) => (
                      <tr key={`${place.locationId ?? 'none'}-${lane.key}`}>
                        <th scope="row" title={lane.tasks.join(', ')}>{lane.label}</th>
                        {days.map((d) => {
                          const on = lane.days.has(d);
                          const hot = clash.has(`${place.locationId}|${lane.org}|${d}`);
                          return <td key={d} className={hot ? 'is-clash' : on ? 'is-on' : undefined}>{hot ? '!' : on ? '●' : ''}</td>;
                        })}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ) : cal ? <p className="ste-quiet">Nobody is planned on site in this window.</p> : null}
      </main>
    </PortalShell>
  );
}
