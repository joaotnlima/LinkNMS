// D16 — Budget: materials & price movement, on its own surface (LINA-218).
//
// Contract: docs/architecture/slice-b3-live-record-materials-contract.md §3c
// route 5 + §5. The rendering itself is components/MoneyMovement.tsx, shared
// verbatim with the D14 Money tab.
//
// ── WHY A SECOND WAY IN TO THE SAME VIEW ─────────────────────────────────────
// D14's Money tab embeds this, and that is where you land when you are reading
// the record. But "what has happened to the money" is also a question asked on
// its own, from the dashboard, without wanting the WBS — and route 5 exists in
// the frozen contract precisely so that question costs one small read instead of
// the whole record projection. Same component, so the two can never disagree
// about what a price movement is.
import { redirect } from 'next/navigation';
import Link from 'next/link';

import { getBudgetMovement, getBuild, getPlan, isSignedIn } from '@/lib/api';
import { directoryOf } from '@/lib/view';
import { TopBar, BottomNav } from '@/components/chrome';
import { MoneyMovement } from '@/components/MoneyMovement';
import type { PlanStageNode } from '@/lib/plan-baseline';
import '@/components/record.css';

export const dynamic = 'force-dynamic';

export default async function BudgetMovementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/budget`);

  // The plan read is only for the stage NAMES: a movement row that says
  // "8f3a-… moved $1,200" answers nothing. If the plan is unreadable the rows
  // still render, named as lines rather than as ids.
  const [build, money, plan] = await Promise.all([getBuild(id), getBudgetMovement(id), getPlan(id)]);

  const directory = directoryOf(build);
  const nameOf = (partyId: string | null | undefined) =>
    (partyId && directory.get(partyId)?.name) || 'Unknown party';

  const names = new Map<string, string>();
  collect(plan.current?.stages ?? [], names);

  return (
    <>
      <TopBar back={{ href: `/projects/${id}`, label: build.name }} />
      <main className="rc">
        <nav className="rc-crumbs" aria-label="Breadcrumb">
          <Link href={`/projects/${id}`}>{build.name}</Link>
          <span aria-hidden="true">›</span>
          <span aria-current="page">Budget movement</span>
        </nav>

        <div className="rc-head">
          <div className="rc-head-l">
            <h1 className="rc-title">Budget movement</h1>
            <p className="rc-lede">
              What moved the contract, and what moved underneath it without touching the contract.
              They are two different facts and they are never added together.
            </p>
          </div>
        </div>

        <MoneyMovement
          projectId={id}
          view={money}
          nameOf={nameOf}
          lineNameOf={(stageId) => names.get(stageId) ?? null}
        />

        <p className="cap">
          Looking for the line each of these came from?{' '}
          <Link href={`/projects/${id}/record?tab=plan`}>Open the record</Link>.
        </p>
      </main>
      <BottomNav projectId={id} active="plan" />
    </>
  );
}

function collect(nodes: PlanStageNode[], into: Map<string, string>): void {
  for (const n of nodes) {
    into.set(n.id, n.name);
    collect(n.children, into);
  }
}
