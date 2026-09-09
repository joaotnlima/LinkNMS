// D15 — Line detail: the materials behind the price (LINA-218).
//
// Pen: "Desktop — Bootstrap flow (lg)" › D15. Contract:
// docs/architecture/slice-b3-live-record-materials-contract.md §3b + §5.
// Decision: ADR-0014 §1/§3.
//
// ── WHY THIS SCREEN EXISTS ───────────────────────────────────────────────────
// A plan line says "Roof — $42,000". That number is the end of an argument, not
// the start of one, unless you can open it and see the 180 m² of membrane at
// $18.40 that make it up. Everything on this page exists so that when the price
// moves, the conversation is about a quantity or a unit rate, which is a fact,
// rather than about the total, which is a position.
//
// ── THE ONE RULE THE PAGE ENFORCES IN ITS LAYOUT ─────────────────────────────
// Before the baseline: the proposer authors freely, because nothing is agreed.
// After it: there is NO edit control anywhere on this screen. The only way a
// number changes is a swap, and a swap makes you say which of two different
// things you are doing — changing what is being built (scope, opens a change
// order, moves the budget) or recording that what you are buying costs
// differently (price movement, moves nothing). The server and the database both
// refuse to let those blur (ADR-0014 §3); this screen refuses to let them LOOK
// the same, which is the earlier and cheaper refusal.
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';

import { getBuild, getPlan, getStageMaterials, isSignedIn } from '@/lib/api';
import { currentSession } from '@/server/session';
import { directoryOf } from '@/lib/view';
import { TopBar, BottomNav } from '@/components/chrome';
import { canAuthorMaterials, canRecordMovement } from '@/lib/record';
import type { PlanStageNode } from '@/lib/plan-baseline';
import { LineDetail } from './LineDetail';
import '@/components/record.css';

export const dynamic = 'force-dynamic';

export default async function LineDetailPage({
  params,
}: {
  params: Promise<{ id: string; stageId: string }>;
}) {
  const { id, stageId } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/record/${stageId}`);

  const [build, plan, materials, session] = await Promise.all([
    getBuild(id), getPlan(id), getStageMaterials(stageId), currentSession(),
  ]);

  // The line's own facts (its name, what the plan says it costs) come from the
  // plan projection, not from the materials read: a line with no breakdown yet is
  // a real line, and it must still open.
  const node = findStage(plan.current?.stages ?? [], stageId);
  if (!node) notFound();

  const directory = directoryOf(build);
  const nameOf = (partyId: string | null | undefined) =>
    (partyId && directory.get(partyId)?.name) || 'Unknown party';

  const actorPartyId = session?.partyId ?? null;
  // Affordances, not permissions (§4): the server authorises every write from the
  // session and a refusal comes back typed. Showing an authoring form to the
  // reviewer, or a swap to a party without RECORD_MOVEMENT, would be a promise
  // the record cannot keep.
  const mayAuthor = canAuthorMaterials(plan, stageId, actorPartyId);
  const maySwap = canRecordMovement(plan, build.actingRole);
  const versionStatus = plan.current?.status ?? null;

  return (
    <>
      <TopBar back={{ href: `/projects/${id}/record`, label: 'The record' }} />
      <main className="rc">
        <nav className="rc-crumbs" aria-label="Breadcrumb">
          <Link href={`/projects/${id}`}>{build.name}</Link>
          <span aria-hidden="true">›</span>
          <Link href={`/projects/${id}/record`}>The record</Link>
          <span aria-hidden="true">›</span>
          <span aria-current="page">{node.name}</span>
        </nav>

        <LineDetail
          projectId={id}
          stageId={stageId}
          lineName={node.name}
          trade={node.trade}
          plannedCostCents={node.plannedCostCents}
          view={materials}
          mayAuthor={mayAuthor}
          maySwap={maySwap}
          versionStatus={versionStatus}
          parties={build.members.map((m) => ({
            partyId: m.partyId,
            name: nameOf(m.partyId),
          }))}
        />
      </main>
      <BottomNav projectId={id} active="home" />
    </>
  );
}

function findStage(nodes: PlanStageNode[], stageId: string): PlanStageNode | null {
  for (const n of nodes) {
    if (n.id === stageId) return n;
    const hit = findStage(n.children, stageId);
    if (hit) return hit;
  }
  return null;
}
