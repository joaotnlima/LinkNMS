// Questions and minutes — `/projects/{id}/questions` (PRD-12 N-5, N-6; flows
// C16–C17; to-be/20). "For us" is the queue the viewer's organisation must
// answer (the architect's clarifications and design-change approvals, the
// owner's scope gaps); "We asked" is what it is waiting on; "Meeting minutes"
// the atas with who still has to acknowledge. Lists are the collaboration
// module's answers; names come from the participants and plan reads, in one
// round. `?q=` focuses one question (the notification deep link).
import { redirect } from 'next/navigation';
import Link from 'next/link';

import { isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContextV2 } from '@/lib/v2/shell';
import { getRecordV2 } from '@/lib/v2/record';
import { getPlanGrid } from '@/lib/v2/planning';
import { collectRowOptions } from '@/lib/v2/planning-view';
import { listParticipants } from '@/lib/v2/participants';
import { listMinutesV2, listProjectQuestionsV2 } from '@/lib/v2/questions';
import { QUESTION_TABS, minuteCard, questionCard } from '@/lib/v2/questions-view';
import { AskQuestion } from '@/components/coordination/AskQuestion';
import { QuestionActions } from '@/components/coordination/QuestionActions';
import { MinuteActions, NewMinute } from '@/components/coordination/Minutes';
import '@/components/site.css';
import '@/components/coordination/coordination.css';

export const dynamic = 'force-dynamic';

type Tab = (typeof QUESTION_TABS)[number]['value'];
const TABS = new Set<string>(QUESTION_TABS.map((t) => t.value));

export default async function QuestionsPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; q?: string }>;
}) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/questions`);
  const sp = await searchParams;
  // A deep link to one question opens the list that holds it (either side).
  const tab: Tab | 'all' = sp.tab && TABS.has(sp.tab) ? (sp.tab as Tab) : sp.q ? 'all' : 'addressed';
  const [record, grid, participants, questions, minutes] = await Promise.all([
    getRecordV2(id), getPlanGrid(id), listParticipants(id),
    tab === 'minutes' ? Promise.resolve([]) : listProjectQuestionsV2(id, tab),
    tab === 'minutes' ? listMinutesV2(id) : Promise.resolve([]),
  ]);
  const name = record?.name ?? 'This build';
  const shell = await buildShellContextV2(id, name);
  const orgList = [...new Map(participants.map((p) => [p.org.id, { id: p.org.id, name: p.org.legal_name }])).values()];
  const orgs = new Map(orgList.map((o) => [o.id, o.name]));
  const tasks = collectRowOptions(grid.rows);
  const taskNames = new Map(tasks.map((t) => [t.id, t.name]));
  const base = `/projects/${id}/questions`;

  return (
    <PortalShell user={shell.user} builds={shell.builds} activeBuild={{ id, name }} section="questions">
      <main className="ste-page">
        <header className="ste-head">
          <h1>Questions and minutes</h1>
          <nav className="crd-tabs" aria-label="View">
            {QUESTION_TABS.map((t) => (
              <Link key={t.value} href={`${base}?tab=${t.value}`} className={t.value === tab ? 'is-on' : undefined}
                aria-current={t.value === tab ? 'page' : undefined}>{t.label}</Link>
            ))}
          </nav>
        </header>

        {tab === 'minutes' ? (
          <>
            <NewMinute projectId={id} today={new Date().toISOString().slice(0, 10)} orgs={orgList} />
            {minutes.length === 0 ? <p className="ste-quiet">No minutes yet.</p> : (
              <ul className="crd-list">
                {minutes.map((m) => minuteCard(m, orgs)).map((m) => (
                  <li key={m.id} className="crd-item">
                    <span className="crd-meta"><strong>{m.date}</strong><span>{m.statusLabel}</span></span>
                    <ol>{m.items.map((text, i) => <li key={i}>{text}</li>)}</ol>
                    {m.acked.length ? <span className="crd-meta">Acknowledged: {m.acked.join(', ')}</span> : null}
                    {m.waiting.length ? <span className="crd-meta">Waiting for: {m.waiting.join(', ')}</span> : null}
                    <MinuteActions projectId={id} minuteId={m.id} actions={m.actions} />
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <>
            <AskQuestion projectId={id} orgs={orgList} tasks={tasks} />
            {questions.length === 0 ? (
              <p className="ste-quiet">{tab === 'asked' ? 'Your organisation has not asked anything here.' : 'Nothing waiting for your organisation.'}</p>
            ) : (
              <ul className="crd-list">
                {questions.map((q) => questionCard(q, orgs, { tasks: taskNames })).map((c) => (
                  <li key={c.id} id={`q-${c.id}`} className={`crd-item${sp.q === c.id ? ' is-focus' : ''}`}>
                    <span className="crd-meta">
                      <span className="crd-badge">{c.topicLabel}</span>
                      <span>{c.statusLabel}</span>
                      {c.decision ? <span className={`crd-badge is-${c.decision}`}>{c.decision}</span> : null}
                      <span>{c.askedOn}</span>
                    </span>
                    <p className="crd-body">{c.body}</p>
                    <span className="crd-meta"><span>{c.from} → {c.to}</span><span>{c.on}</span></span>
                    <QuestionActions projectId={id} questionId={c.id} actions={c.actions} needsDecision={c.needsDecision} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </main>
    </PortalShell>
  );
}
