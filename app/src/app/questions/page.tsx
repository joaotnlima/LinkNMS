// Questions for me — `/questions` (PRD-12 N-7). Every question addressed to the
// active organisation, across builds (`/me/questions`), filtered by topic and
// state; each opens on its build's questions page where it is answered. Build
// names come from the portfolio read — no call per row.
import { redirect } from 'next/navigation';
import Link from 'next/link';

import { isSignedIn } from '@/lib/api';
import { PortalShell, type PortalUser } from '@/components/PortalShell';
import { getViewerProfile, listPortfolio } from '@/lib/v2/profile';
import { listMyQuestionsV2 } from '@/lib/v2/questions';
import { TOPIC_LABEL, questionCard, type QuestionTopic } from '@/lib/v2/questions-view';
import '@/components/site.css';
import '@/components/coordination/coordination.css';

export const dynamic = 'force-dynamic';

const STATUSES = ['open', 'answered', 'resolved'] as const;

export default async function QuestionsForMePage({ searchParams }: { searchParams: Promise<{ topic?: string; status?: string }> }) {
  if (!(await isSignedIn())) redirect('/sign-in?next=/questions');
  const sp = await searchParams;
  const topic = sp.topic && sp.topic in TOPIC_LABEL ? (sp.topic as QuestionTopic) : undefined;
  const status = STATUSES.find((s) => s === sp.status) ?? 'open';
  const [questions, profile, portfolio] = await Promise.all([listMyQuestionsV2({ status, topic }), getViewerProfile(), listPortfolio()]);
  const user: PortalUser = profile ?? { displayName: 'Your account', roleLabel: '' };
  const builds = new Map(portfolio.map((b) => [b.id, b.name]));
  const link = (patch: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    const next = { topic, status, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
    return `/questions?${q.toString()}`;
  };

  return (
    <PortalShell user={user} align="start" switcherLabel="Questions for me">
      <main className="ste-page">
        <header className="ste-head"><h1>Questions for me</h1></header>
        <nav className="crd-tabs" aria-label="Topic">
          <Link href={link({ topic: undefined })} className={!topic ? 'is-on' : undefined}>All</Link>
          {(Object.keys(TOPIC_LABEL) as QuestionTopic[]).map((t) => (
            <Link key={t} href={link({ topic: t })} className={topic === t ? 'is-on' : undefined}>{TOPIC_LABEL[t]}</Link>
          ))}
        </nav>
        <nav className="crd-tabs" aria-label="State">
          {STATUSES.map((s) => (
            <Link key={s} href={link({ status: s })} className={status === s ? 'is-on' : undefined}>
              {s === 'open' ? 'To answer' : s === 'answered' ? 'Answered' : 'Resolved'}
            </Link>
          ))}
        </nav>
        {questions.length === 0 ? <p className="ste-quiet">Nothing here.</p> : (
          <ul className="crd-list">
            {questions.map((q) => questionCard(q, new Map(), { builds })).map((c) => (
              <li key={c.id} className="crd-item">
                <span className="crd-meta"><span className="crd-badge">{c.topicLabel}</span><span>{c.on}</span><span>{c.askedOn}</span></span>
                <p className="crd-body">{c.body}</p>
                {c.href ? <Link className="btn" href={c.href}>Open on the build</Link> : null}
              </li>
            ))}
          </ul>
        )}
      </main>
    </PortalShell>
  );
}
