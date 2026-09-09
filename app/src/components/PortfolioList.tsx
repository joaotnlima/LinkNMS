// D1 — the returning-user portfolio (LINA-198, ADR-0012 §A1).
//
// The other half of the home branch: `EmptyPortal` is the first-time state,
// this is what a user with one or more builds sees. One card per build, most
// recent first (the server orders; this never sorts). Each card is the FR-level
// answer at a glance — name, whether it is live yet, the acting party's role,
// where the budget stands against its baseline, and how much has been recorded.
//
// Drafts are included and link BACK INTO the wizard, not to a half-built record:
// an abandoned create flow is resumable from exactly the step it stalled on
// (`stepFor` reads the same draft truth table the wizard routes on). A live
// build links to its record at `/projects/{id}`.
import Link from 'next/link';

import type { ProjectSummary } from '@/lib/types';
import { money, roleLabel, delta } from '@/lib/format';
import { stepFor, hrefForStep } from '@/lib/build-creation';
import { PortalShell, type PortalUser } from './PortalShell';
import './portfolio.css';

export function PortfolioList({ projects, user }: { projects: ProjectSummary[]; user: PortalUser }) {
  // The populated portfolio wears the SAME pen app-shell as the empty state
  // (rail + account menu + tab bar) — before LINA-219 it rendered bare, which is
  // why it "did not mimic the pen" and offered no way to sign out. The shell owns
  // the "Your builds"/"Portfolio" title, the Create-build control and the account
  // menu; this body is just the list of cards.
  const label = projects.length === 1 ? '1 build' : `${projects.length} builds`;
  return (
    <PortalShell user={user} switcherLabel={label} align="start">
      <div className="pf">
        <ul className="pf-list">
          {projects.map((p) => (
            <li key={p.id}>
              <PortfolioCard project={p} />
            </li>
          ))}
        </ul>
      </div>
    </PortalShell>
  );
}

function PortfolioCard({ project: p }: { project: ProjectSummary }) {
  const isDraft = p.status === 'draft';
  // A draft resumes at the step it stalled on; a live build opens its record.
  const href = isDraft ? hrefForStep(p.id, stepFor(p)) : `/projects/${p.id}`;
  // Current vs baseline — the one number that says "has this moved". Baseline is
  // the figure every change is measured against, so we show the move explicitly.
  const moved = p.currentBudgetCents - p.baselineBudgetCents;
  const d = delta(moved);

  return (
    <Link className="pf-card" href={href}>
      <div className="pf-card-top">
        <span className="pf-card-name">{p.name}</span>
        {isDraft ? (
          <span className="badge neutral">Draft</span>
        ) : (
          <span className="badge ok">Live</span>
        )}
      </div>

      <div className="pf-card-meta">
        <span className={`tag ${p.role}`}>
          <span className="pd" />
          {roleLabel(p.role)}
        </span>
      </div>

      <div className="pf-card-budget">
        <span className="pf-budget-now">{money(p.currentBudgetCents)}</span>
        <span className="pf-budget-base">
          {moved === 0 ? (
            <>baseline {money(p.baselineBudgetCents)}</>
          ) : (
            <>
              <span className={`delta ${d.dir}`}>{d.text}</span> vs {money(p.baselineBudgetCents)}
            </>
          )}
        </span>
      </div>

      <div className="pf-card-counts">
        <span>
          <strong>{p.counts.changeOrders}</strong>{' '}
          {p.counts.changeOrders === 1 ? 'change order' : 'change orders'}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          <strong>{p.counts.decisions}</strong>{' '}
          {p.counts.decisions === 1 ? 'decision' : 'decisions'}
        </span>
      </div>

      {isDraft && <span className="pf-card-resume">Finish setting this up →</span>}
    </Link>
  );
}
