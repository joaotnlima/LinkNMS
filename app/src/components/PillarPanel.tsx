// The M14 four-pillar panel (pen "S · M14 · The record, live"; ADR-0015 §1).
//
// Each tile is a status-tinted icon chip + the pillar NAME + a value line. The
// tint is never the sole signal (FR9): the name and the value word both carry it
// with colour stripped out. Three tiles link into their detail surface; SAFETY
// does not — there is no safety surface, and it says so ("Not tracked yet",
// ADR-0015 §2) rather than pretending an all-clear.
//
// This panel renders whatever the Ledger derived. No status math here — TIME→
// SCHEDULE and COST→BUDGET were renames of existing derivations, SCOPE is
// unchanged, and SAFETY is the service's static "not tracked" pillar.
import Link from 'next/link';
import type { Pillars, Pillar } from '@/lib/types';
import { PillarGlyph } from './icons';
import { money, delta } from '@/lib/format';

const NAME: Record<Pillar['pillar'], string> = {
  schedule: 'Schedule',
  budget: 'Budget',
  scope: 'Scope',
  safety: 'Safety',
};

// The value line each tile shows. BUDGET is special: it shows the current
// contract budget and its net change from baseline (ADR-0015 §3) — never a spent
// figure the ledger does not hold. The others show the derived label.
function Value({ p }: { p: Pillar }) {
  if (p.pillar === 'budget' && p.currentCents != null) {
    const d = delta(p.deltaCents ?? 0);
    return (
      <>
        <span className="m14-p-v">{money(p.currentCents)}</span>
        <span className={`m14-p-sub delta ${d.dir}`}>
          {(p.deltaCents ?? 0) === 0 ? 'On baseline' : `${d.text} vs baseline`}
        </span>
      </>
    );
  }
  return <span className="m14-p-v">{p.label}</span>;
}

function Tile({ p, href }: { p: Pillar; href?: string }) {
  const inner = (
    <>
      <div className="m14-p-top">
        <span className={`m14-p-chip ${p.status}`}>
          <PillarGlyph pillar={p.pillar} className="m14-p-ic" />
        </span>
        <span className="m14-p-name">{NAME[p.pillar]}</span>
      </div>
      <Value p={p} />
    </>
  );
  return href
    ? <Link className={`m14-pillar ${p.status}`} href={href}>{inner}</Link>
    : <div className={`m14-pillar ${p.status}`}>{inner}</div>;
}

export function PillarPanel({ pillars, projectId }: { pillars: Pillars; projectId: string }) {
  const base = `/projects/${projectId}`;
  // Order matches the pen: Schedule · Budget · Scope · Safety.
  return (
    <div className="m14-pillars" role="group" aria-label="Four-pillar project status">
      <Tile p={pillars.schedule} href={`${base}/record?tab=schedule`} />
      <Tile p={pillars.budget} href={`${base}/budget`} />
      <Tile p={pillars.scope} href={`${base}/change-orders`} />
      <Tile p={pillars.safety} />
    </div>
  );
}
