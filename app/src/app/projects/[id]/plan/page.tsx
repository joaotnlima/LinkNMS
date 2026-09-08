// D7 — "No plan yet: the routes in", and what the same URL shows once a plan
// exists (LINA-207).
//
// Pen: "Desktop — Bootstrap flow (lg)" › Band C › D7. Contract §7.
//
// ── ONE URL, TWO STATES ──────────────────────────────────────────────────────
// D7 is an EMPTY-build state, so it needs somewhere to stop being. `:confirm`
// says the flow ends "route to the plan/record" (contract §7) and this is that
// record: the same `/projects/:id/plan` renders the routes-in when the build has
// no stages and the imported plan when it has some. A separate /plan/empty URL
// would go stale the moment the import lands and would leave the post-confirm
// redirect pointing at a screen about not having a plan.
//
// ── WHAT THIS PAGE DOES NOT TRY TO BE ────────────────────────────────────────
// The populated state is a LIST, not the Band D/E schedule surface. `getPlan`
// returns flat stages (name, dates, status) — the WBS parentage and trade that
// the import wrote are in the schema but not on that projection yet, and
// inventing a hierarchy here by re-deriving it from names is exactly the kind of
// inference the whole slice refuses. The tree the GC just approved is in the
// preview they confirmed; the durable answer to "who imported this and when" is
// the audit stamp below, which links to the ledger.
import { redirect } from 'next/navigation';
import Link from 'next/link';

import { getBuild, getPlan, isSignedIn, type PlanHeadline } from '@/lib/api';
import { TopBar, BottomNav } from '@/components/chrome';
import '@/components/plan-import.css';

export const dynamic = 'force-dynamic';

export default async function PlanPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ imported?: string }>;
}) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/plan`);

  const [build, plan] = await Promise.all([getBuild(id), getPlan(id)]);
  const { imported } = await searchParams;
  const isGC = build.actingRole === 'counterparty';

  return (
    <>
      <TopBar back={{ href: `/projects/${id}`, label: build.name }} />
      <main className="pi">
        <nav className="pi-crumbs" aria-label="Breadcrumb">
          <Link href={`/projects/${id}`}>{build.name}</Link>
          <span aria-hidden="true">›</span>
          <span aria-current="page">Plan</span>
        </nav>

        {/* The stamp the import returned (contract §7). It is shown once, on the
            redirect that carried it — the durable copy is the ledger event, which
            is why this links there rather than pretending to be it. */}
        {imported ? (
          <div className="pi-stamp" role="status">
            <p className="pi-stamp-t">Plan imported</p>
            <p className="cap">
              Recorded as one event on the shared record:{' '}
              <span className="pi-stamp-id">{imported}</span>
            </p>
            <Link className="btn" href={`/projects/${id}/audit`}>See it in the audit trail</Link>
          </div>
        ) : null}

        {plan.totalStages === 0 ? <NoPlanYet projectId={id} isGC={isGC} /> : (
          <>
            <div className="pi-head">
              <h1 className="pi-title">Plan</h1>
              <p className="pi-lede">
                {plan.totalStages} stage{plan.totalStages === 1 ? '' : 's'} · {headlineText(plan.headline)}
              </p>
            </div>
            <ul className="card pi-stages">
              {plan.stages.map((s) => (
                <li key={s.id} className="pi-stagerow">
                  <span className="pi-stage-name">{s.name}</span>
                  <span className="cap num">
                    {s.plannedStartDate ?? '—'} → {s.plannedEndDate ?? '—'}
                  </span>
                </li>
              ))}
            </ul>
            {isGC ? (
              <p className="cap">
                Importing again adds a second stamped import — it never overwrites what is here.
              </p>
            ) : null}
          </>
        )}
      </main>
      <BottomNav projectId={id} active="plan" />
    </>
  );
}

// `headline` is a rollup TOKEN, not a sentence — the service is deliberate that
// an empty plan has no headline at all rather than "0% complete" (R1.5). Printing
// the token would put `not_started` on the screen; this is the one place it turns
// into English, and the empty case is handled by the branch above, not here.
const headlineText = (h: PlanHeadline): string => {
  switch (h) {
    case 'attention_needed': return 'needs attention';
    case 'complete': return 'complete';
    case 'in_progress': return 'under way';
    case 'not_started': return 'not started yet';
    default: return 'no progress reported yet';
  }
};

/**
 * The three routes in (pen D7).
 *
 * Route 1 is live. Route 2 ("build it here") and route 3 ("the owner drafted one
 * for you") are NOT, and they are drawn as what they are rather than as buttons
 * that go nowhere: there is no hand-authoring flow in B1, and an owner-drafted
 * plan needs the proposal→baseline lifecycle that B2 (LINA-200) adds. The pen
 * itself says route 3 appears "only when a draft is actually waiting"; in B1 one
 * never is, so it is described in the note rather than mocked as a live card.
 */
function NoPlanYet({ projectId, isGC }: { projectId: string; isGC: boolean }) {
  return (
    <>
      <div className="pi-head">
        <h1 className="pi-title">Add your plan</h1>
        <p className="pi-lede">
          Actions, sub-actions and the dates they run. However it gets in, the plan is the
          contractor&apos;s — nothing here is binding until both parties agree it.
        </p>
      </div>

      <div className="pi-routes">
        <section className="pi-route">
          <p className="pi-route-n">Route 1</p>
          <h2 className="pi-route-t">Import a spreadsheet</h2>
          <p className="pi-route-b">
            You already have the plan in Excel. Choose the file, tell us what each column means,
            confirm what will be stored.
          </p>
          <p className="pi-route-meta">.xlsx · multi-sheet · you pick the tab</p>
          {isGC ? (
            <Link className="btn primary" href={`/projects/${projectId}/plan/import`}>Upload plan</Link>
          ) : (
            // Contract §5: importing is the GC's, not the owner's. An owner sees
            // the route and why it is not theirs rather than a button that 403s.
            <p className="cap">The plan is the contractor&apos;s to bring in.</p>
          )}
        </section>

        <section className="pi-route is-later">
          <p className="pi-route-n">Route 2</p>
          <h2 className="pi-route-t">Build it here</h2>
          <p className="pi-route-b">
            No spreadsheet — add actions and sub-actions directly.
          </p>
          <p className="pi-route-meta">Not built yet</p>
        </section>
      </div>

      <p className="cap">
        Whichever route you take, the plan is the contractor&apos;s: they own it and only they can
        revise it. The owner can propose a change, never overwrite one.
      </p>
    </>
  );
}
