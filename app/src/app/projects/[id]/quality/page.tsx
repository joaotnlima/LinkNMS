// Quality — `/projects/{id}/quality` (PRD-12 N-3, N-4; flow C15; to-be/20).
// The verifications waiting for my organisation, the build's non-conformities
// (raise with a location, task and photos; assign → fix → close, which only the
// raiser can do, or reject the fix back) and the inspections. Every list is the
// owning module's answer in one round — names come from the participants,
// locations and plan reads, never one call per row. `?nc=` focuses one issue
// (the notification deep link); `?status=` filters.
import { redirect } from 'next/navigation';
import Link from 'next/link';

import { isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContextV2 } from '@/lib/v2/shell';
import { getRecordV2 } from '@/lib/v2/record';
import { getPlanGrid } from '@/lib/v2/planning';
import { collectRowOptions } from '@/lib/v2/planning-view';
import { listParticipants } from '@/lib/v2/participants';
import { listLocationsV2 } from '@/lib/v2/execution';
import { listInspectionsV2, listMyVerificationsV2, listNonConformitiesV2 } from '@/lib/v2/quality';
import { STATUS_FILTERS, inspectionRow, ncCard, type Names } from '@/lib/v2/quality-view';
import { RaiseNonConformity } from '@/components/coordination/RaiseNonConformity';
import { NonConformityActions } from '@/components/coordination/NonConformityActions';
import { RecordInspection } from '@/components/coordination/RecordInspection';
import { VerificationDecision } from '@/components/coordination/VerificationDecision';
import '@/components/site.css';
import '@/components/coordination/coordination.css';

export const dynamic = 'force-dynamic';

const STATUSES = new Set(STATUS_FILTERS.map((f) => f.value));

export default async function QualityPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ status?: string; nc?: string }>;
}) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/quality`);
  const sp = await searchParams;
  const status = sp.status && STATUSES.has(sp.status) ? sp.status : 'active';
  const [record, grid, participants, locations, ncs, inspections, verifications] = await Promise.all([
    getRecordV2(id), getPlanGrid(id), listParticipants(id), listLocationsV2(id),
    listNonConformitiesV2(id, status), listInspectionsV2(id), listMyVerificationsV2(id),
  ]);
  const name = record?.name ?? 'This build';
  const shell = await buildShellContextV2(id, name);
  const orgs = [...new Map(participants.map((p) => [p.org.id, { id: p.org.id, name: p.org.legal_name }])).values()];
  const tasks = collectRowOptions(grid.rows);
  const places = locations.map((l) => ({ id: l.id, name: l.name }));
  const names: Names = {
    orgs: new Map(orgs.map((o) => [o.id, o.name])),
    tasks: new Map(tasks.map((t) => [t.id, t.name])),
    locations: new Map(places.map((l) => [l.id, l.name])),
  };
  const cards = ncs.map((nc) => ncCard(nc, names));
  const base = `/projects/${id}/quality`;

  return (
    <PortalShell user={shell.user} builds={shell.builds} activeBuild={{ id, name }} section="quality">
      <main className="ste-page">
        <header className="ste-head">
          <h1>Quality and safety</h1>
          <span className="ste-links"><Link href={`/projects/${id}/site`}>Daily log</Link></span>
        </header>

        {verifications.length ? (
          <section className="ste-card" aria-label="Work waiting for your verification">
            <h2>Waiting for your verification</h2>
            <ul className="crd-list">
              {verifications.map((v) => (
                <li key={v.id} className="crd-item">
                  <strong>{v.task_name ?? names.tasks.get(v.task_id) ?? 'A task'}</strong>
                  <span className="crd-meta">
                    Reported done by {names.orgs.get(v.requested_by.org_id) ?? 'an organisation on this build'}
                    {v.criteria ? ` · criteria: ${v.criteria}` : ''}
                  </span>
                  <VerificationDecision projectId={id} verificationId={v.id} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <RaiseNonConformity projectId={id} orgs={orgs} tasks={tasks} locations={places} />

        <section aria-label="Non-conformities">
          <div className="ste-head">
            <h2>Non-conformities</h2>
            <nav className="crd-tabs" aria-label="Filter">
              {STATUS_FILTERS.map((f) => (
                <Link key={f.value} href={`${base}?status=${f.value}`} className={f.value === status ? 'is-on' : undefined}
                  aria-current={f.value === status ? 'page' : undefined}>{f.label}</Link>
              ))}
            </nav>
          </div>
          {cards.length === 0 ? <p className="ste-quiet">Nothing here.</p> : (
            <ul className="crd-list">
              {cards.map((c) => (
                <li key={c.id} id={`nc-${c.id}`} className={`crd-item${sp.nc === c.id ? ' is-focus' : ''}`}>
                  <span className="crd-meta">
                    <span className={`crd-badge is-${c.severity}`}>{c.severity}</span>
                    <span>{c.kindLabel}</span>
                    <span>{c.statusLabel}</span>
                    {c.raisedOn ? <span>raised {c.raisedOn}</span> : null}
                  </span>
                  <p className="crd-body">{c.title}</p>
                  <span className="crd-meta">
                    {c.where ? <span>{c.where}</span> : null}
                    <span>Raised by {c.raisedBy}</span>
                    {c.assignedTo ? <span>Fix: {c.assignedTo}</span> : null}
                  </span>
                  {c.lastNote ? <p className="ste-quiet">“{c.lastNote}”</p> : null}
                  {c.photos.length ? (
                    <span className="crd-meta">
                      {c.photos.map((p, i) => <a key={p.documentId} href={p.href} target="_blank" rel="noreferrer">Photo {i + 1}</a>)}
                    </span>
                  ) : null}
                  <NonConformityActions projectId={id} ncId={c.id} actions={c.actions} orgs={orgs} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Inspections">
          <h2>Inspections</h2>
          <RecordInspection projectId={id} today={new Date().toISOString().slice(0, 10)} tasks={tasks} locations={places} />
          {inspections.length === 0 ? <p className="ste-quiet">No inspections recorded yet.</p> : (
            <ul className="crd-list">
              {inspections.map((i) => inspectionRow(i, names)).map((r) => (
                <li key={r.id} className="crd-item">
                  <span className="crd-meta">
                    <strong>{r.date}</strong><span>{r.kindLabel}</span><span>{r.inspector}</span>
                    <span>{r.passed} ok · {r.failed} not ok</span>
                  </span>
                  {r.where.length ? <span className="crd-meta">{r.where.join(' · ')}</span> : null}
                  {r.failedItems.length ? <span className="ste-error">Not ok: {r.failedItems.join(', ')}</span> : null}
                  {r.findings ? <p className="crd-body">{r.findings}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </PortalShell>
  );
}
