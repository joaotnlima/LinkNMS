// The plan surface: D7 "no plan yet" (LINA-207) and D11–D13, the proposal →
// review → baseline v1 record (LINA-212).
//
// Pen: "Desktop — Bootstrap flow (lg)" › Band C › D7, and D11/D12/D12a/D13.
// Contracts: slice-b1-plan-import-contract §7, slice-b2-plan-baseline-contract §7.
//
// ── ONE URL, THREE STATES ────────────────────────────────────────────────────
// `/projects/:id/plan` is the plan, whatever the plan currently is:
//   - nothing imported yet          → D7, the routes in
//   - a version open for review     → D11 / D12 / D12a, per who is looking
//   - a version accepted and frozen → D13, the baseline banner
// A separate URL per state would go stale the moment the state changed and would
// leave every redirect (the import's, the acceptance's) pointing at a screen
// about a moment that has passed.
//
// ── WHY THE ACTING PARTY IS READ HERE ────────────────────────────────────────
// The screen needs it to decide which affordances exist (proposer → withdraw,
// reviewer → accept/request-changes/reject). It is read from the VERIFIED
// session server-side and passed down, never sent back up: every transition
// derives its actor from the session again on the server (contract §6), so this
// value shapes buttons and authorises nothing.
import { redirect } from 'next/navigation';
import Link from 'next/link';

import { getBuild, getPlan, isSignedIn } from '@/lib/api';
import { currentSession } from '@/server/session';
import { directoryOf } from '@/lib/view';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContext } from '@/server/portal-shell';
import { PlanBaseline, type PartyRef } from './PlanBaseline';
import '@/components/plan-import.css';

export const dynamic = 'force-dynamic';

export default async function PlanPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ imported?: string; drafted?: string }>;
}) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/plan`);

  const [build, plan, session] = await Promise.all([getBuild(id), getPlan(id), currentSession()]);
  const shell = await buildShellContext(id, build.name);
  const { imported, drafted } = await searchParams;
  const isGC = build.actingRole === 'counterparty';

  const directory = directoryOf(build);
  const parties: PartyRef[] = build.members.map((m) => ({
    partyId: m.partyId,
    name: directory.get(m.partyId)?.name ?? 'Unknown party',
    role: m.role,
  }));

  // "Is there a plan?" is `current || baseline || history`, not a stage count:
  // a withdrawn v1 leaves a build with no open version and a real history, and
  // showing "add your plan" over the top of a negotiation that happened would be
  // the record forgetting it.
  const hasPlan = plan.current !== null || plan.baseline !== null || plan.history.length > 0;

  return (
    <PortalShell
      user={shell.user}
      builds={shell.builds}
      activeBuild={{ id, name: build.name }}
      section="plan"
    >
      <main className="pi">
        {/* The stamp the import returned (B1 contract §7). It is shown once, on
            the redirect that carried it — the durable copy is the ledger event,
            which is why this links there rather than pretending to be it. */}
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

        {/* The stamp the :author write returned (LINA-228/LINA-230). Saving is
            PRIVATE drafting — the copy says so plainly: nothing is sent yet. Shown
            once on the redirect; the durable copy is the plan_drafted ledger event. */}
        {drafted ? (
          <div className="pi-stamp" role="status">
            <p className="pi-stamp-t">Draft saved</p>
            <p className="cap">
              Saved as your private draft — the other party cannot see it and no approval has been
              requested. Recorded as one event on the shared record:{' '}
              <span className="pi-stamp-id">{drafted}</span>
            </p>
            <Link className="btn" href={`/projects/${id}/audit`}>See it in the audit trail</Link>
          </div>
        ) : null}

        {hasPlan ? (
          <PlanBaseline
            projectId={id}
            view={plan}
            actorPartyId={session?.partyId ?? null}
            parties={parties}
          />
        ) : (
          <NoPlanYet projectId={id} isGC={isGC} />
        )}
      </main>
    </PortalShell>
  );
}

/**
 * The three routes in (pen D7).
 *
 * Route 1 is live. Route 2 ("build it here") is not, and it is drawn as what it
 * is rather than as a button that goes nowhere: there is no hand-authoring flow
 * yet. Route 3 in the pen ("the owner drafted one for you") appears "only when a
 * draft is actually waiting" — with B2 shipped, an owner-authored version DOES
 * exist as a shape (a request-changes fork is authored by the reviewer), but
 * nothing lets an owner start one from empty, so the route stays described
 * rather than mocked.
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
            // B1 contract §5: importing is the GC's, not the owner's. An owner
            // sees the route and why it is not theirs rather than a button that
            // 403s.
            <p className="cap">The plan is the contractor&apos;s to bring in.</p>
          )}
        </section>

        <section className="pi-route">
          <p className="pi-route-n">Route 2</p>
          <h2 className="pi-route-t">Build it here</h2>
          <p className="pi-route-b">
            No spreadsheet — start from a standard skeleton, then add phases and tasks directly and
            date them where you know them.
          </p>
          <p className="pi-route-meta">seeded skeleton · phases &amp; tasks · optional dates</p>
          {/* Either party may author (ADR-0017 §3): it is proposed to the other to
              agree, so there is no role gate here. */}
          <Link className="btn primary" href={`/projects/${projectId}/plan/build`}>Build the plan</Link>
        </section>
      </div>

      <p className="cap">
        Whichever route you take, the plan is the contractor&apos;s: they own it and only they can
        revise it. The owner can propose a change, never overwrite one.
      </p>
    </>
  );
}
