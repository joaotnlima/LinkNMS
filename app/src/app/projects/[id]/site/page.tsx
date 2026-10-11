// The site's daily log, by day — `/projects/{id}/site` (PRD-10 E-9). The days
// that have entries (last 30 by default) and the chosen day in full: who was on
// site and how many, the weather, work against tasks, issues and photos. Every
// line is the planning module's answer (listDailyLogs, getDailyLog); a viewer
// who is not on the build gets the sentence, never a crash.
import { redirect } from 'next/navigation';
import Link from 'next/link';

import { isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContextV2 } from '@/lib/v2/shell';
import { getRecordV2 } from '@/lib/v2/record';
import { V2Error } from '@/lib/v2/client';
import { getDailyLogV2, listDailyLogsV2 } from '@/lib/v2/execution';
import {
  dayWords, daySummaryWords, entryLine, weatherWord, weekdayOf, type V2DailyLog,
} from '@/lib/v2/execution-view';
import { taskDocumentDownloadPath, versionRefOf } from '@/lib/v2/task-workspace-view';
import '@/components/site.css';

export const dynamic = 'force-dynamic';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export default async function SitePage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/site`);
  const sp = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const [record, days] = await Promise.all([getRecordV2(id), listDailyLogsV2(id)]);
  const date = sp.date && ISO.test(sp.date) ? sp.date : (days[0]?.date ?? today);
  let day: V2DailyLog | null = null;
  let error: string | null = null;
  try {
    day = await getDailyLogV2(id, date);
  } catch (err) {
    if (!(err instanceof V2Error)) throw err;
    error = err.status === 404 ? 'This build’s daily log is not available to you.' : (err.detail ?? err.message);
  }
  const name = record?.name ?? 'This build';
  const shell = await buildShellContextV2(id, name);

  return (
    <PortalShell user={shell.user} builds={shell.builds} activeBuild={{ id, name }} crumb="Daily log">
      <main className="ste-page">
        <header className="ste-head">
          <h1>Daily log</h1>
          <span className="ste-links">
            <Link className="btn primary" href={`/projects/${id}/site/log`}>Log today</Link>
            <Link className="btn" href={`/projects/${id}/site/calendar`}>Site calendar</Link>
          </span>
        </header>

        {error ? <p role="alert" className="ste-error">{error}</p> : null}

        {day ? (
          <section className="ste-card" aria-label={`The site on ${dayWords(date)}`}>
            <h2>{weekdayOf(date)} {dayWords(date)}</h2>
            {day.entries.length === 0 ? (
              <p className="ste-quiet">
                Nothing recorded for this day.{' '}
                {date === today ? <Link href={`/projects/${id}/site/log`}>Log it now</Link> : null}
              </p>
            ) : (
              <>
                <p>
                  <strong>{day.headcount_total}</strong> on site
                  {day.on_site.length ? ` — ${day.on_site.map((e) => `${e.org_name ?? 'organisation'} ${e.headcount}`).join(', ')}` : ''}
                  {day.weather ? ` · ${weatherWord(day.weather.weather)}${day.weather.temperature_c != null ? `, ${day.weather.temperature_c} °C` : ''}` : ''}
                </p>
                {day.work.length ? (
                  <><h2>Work done</h2><ul className="ste-log">{day.work.map((e) => <li key={e.id}>{entryLine(e)}</li>)}</ul></>
                ) : null}
                {day.issues.length ? (
                  <><h2>Issues</h2><ul className="ste-log">{day.issues.map((e) => <li key={e.id}>{entryLine(e)}</li>)}</ul></>
                ) : null}
                {day.photos.length ? (
                  <>
                    <h2>Photos</h2>
                    <div className="ste-photos">
                      {day.photos.map((e) => (
                        <a key={e.id} className="ste-photo" target="_blank" rel="noreferrer"
                          href={taskDocumentDownloadPath(versionRefOf(e.document_id!, e.version_no!))}>
                          <span>{entryLine(e)}</span>
                        </a>
                      ))}
                    </div>
                  </>
                ) : null}
                <p className="ste-quiet">
                  {day.entries.length} entr{day.entries.length === 1 ? 'y' : 'ies'} on the record — corrections are newer entries; nothing is overwritten.
                </p>
              </>
            )}
          </section>
        ) : null}

        <section aria-label="Days">
          <h2>Recent days</h2>
          {days.length === 0 ? <p className="ste-quiet">No days logged in the last 30 days.</p> : (
            <ul className="ste-days">
              {days.map((d) => (
                <li key={d.date}>
                  <Link href={`/projects/${id}/site?date=${d.date}`} className={d.date === date ? 'is-on' : undefined}
                    aria-current={d.date === date ? 'page' : undefined}>
                    <span>{weekdayOf(d.date)} {dayWords(d.date)}</span>
                    <span className="ste-quiet">{daySummaryWords(d)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </PortalShell>
  );
}
