'use client';

// The tendering section — the org's tenders on a project and, for the one that
// is open, the full tender WORKSPACE (PRD-02, D-42; LINA-361 lineage). It is
// mounted by `/projects/:id/plan/procurement` and by the plan's in-place tender
// modal, so it owns no page frame.
//
// Since PRD-02 the long single form is gone: a tender is composed in three
// steps (Scope · Bidders · Review & send) and followed, compared and awarded
// with the SAME components the docked task panel uses (components/tender/*);
// the workspace adds the proposals inbox with shortlist and the Compare
// drill-down, the line-by-line matrix, the files, the emailed bids and the
// clarifications placeholder.
//
// ── WHAT THIS SURFACE PROMISES (unchanged) ──────────────────────────────────
// 1. PUBLISH IS A DOOR: sending confirms first and says what it does.
// 2. A DRAFT IS PRIVATE UNTIL SENT: no personal link exists yet (the server
//    mints them at publish).
// 3. MONEY MAY BE WITHHELD, AND THE SURFACE SAYS SO — never a fake €0.
// 4. AWARD IS ONE-WAY AND EXPLAINS ITSELF.
// 5. NOTHING IS COMPUTED FROM A BID; NO DATE IS COMPUTED HERE (planning's).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import { loadMyRfpsAction } from './procurement-actions';
import { rfpStatusBadge, type RfpMode, type V2Rfp } from '@/lib/v2/tendering-view';
import { TenderWorkspace } from './tender/TenderWorkspace';
import type { WorkspaceSection } from './tender/TenderPanel';
import type { TaskOption } from './tender/types';
import { mirrorUrl } from './tender/url';
import './procurement.css';

export type { TaskOption } from './tender/types';

export function ProcurementSection({
  projectId, tasks, hasActiveOrg = true, initialMyRfps = null,
  composeTaskId = null, composeMode = 'detailed', openRfpId = null, initialSection = 'overview',
  onRfpChanged,
}: {
  projectId: string;
  /** Candidate root tasks (from the plan) a tender can be raised over. */
  tasks: TaskOption[];
  /** False when no organisation is selected: the neutral "pick an organisation" state. */
  hasActiveOrg?: boolean;
  /** The org's RFPs for this project, when the page already read them. */
  initialMyRfps?: V2Rfp[] | null;
  /** "Start tendering" deep-link (LINA-407): open a new tender on this task. */
  composeTaskId?: string | null;
  /** The shape the deep-link asked for — `light` for a design tender. */
  composeMode?: RfpMode;
  /** Open this existing tender (LINA-420); overridden by an explicit `?rfp=`. */
  openRfpId?: string | null;
  /** Which workspace section an opened tender lands on (the panel's "Line-by-line matrix →"). */
  initialSection?: WorkspaceSection;
  /** Told about every tender write, so a mounting plan keeps its chips in step. */
  onRfpChanged?: (rfp: V2Rfp) => void;
}) {
  // `?rfp=` ↔ selection, read once at mount and mirrored back with the raw
  // History API (a Next navigation would re-run the force-dynamic page and drop
  // in-flight state — the LINA-404 lesson). `?compare=` belongs to the inbox.
  const searchParams = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(() => searchParams.get('rfp') ?? openRfpId);
  const initialCompare = useRef<string | null>(searchParams.get('compare'));
  const [rfps, setRfps] = useState<V2Rfp[] | null>(initialMyRfps);
  const [loading, setLoading] = useState(hasActiveOrg && initialMyRfps === null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(hasActiveOrg && composeTaskId !== null && selectedId === null);
  const todayIso = useRef(new Date().toISOString().slice(0, 10)).current;

  const openRfp = useCallback((id: string | null) => {
    setSelectedId(id);
    initialCompare.current = null;
    mirrorUrl(id, null);
  }, []);

  const refreshList = useCallback(async () => {
    setLoading(true);
    try {
      setRfps((await loadMyRfpsAction()).filter((r) => r.project_id === projectId));
    } catch {
      setError('Could not load your tenders.');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!hasActiveOrg || initialMyRfps !== null) return;
    void refreshList();
  }, [hasActiveOrg, initialMyRfps, refreshList]);

  const upsert = useCallback((next: V2Rfp) => {
    setRfps((prev) => {
      const list = prev ?? [];
      return list.some((r) => r.id === next.id) ? list.map((r) => (r.id === next.id ? next : r)) : [next, ...list];
    });
  }, []);

  if (!hasActiveOrg) {
    return (
      <section className="prc" aria-label="Tendering">
        <p className="prc-quiet">
          Select an organisation to run a tender. RFPs belong to the org that issues them, so there
          is nothing to show until you are acting for one.
        </p>
      </section>
    );
  }
  if (loading && rfps === null) return <p className="prc-quiet" role="status">Loading tenders…</p>;

  const list = (rfps ?? []).filter((r) => r.project_id === projectId);
  const selected = list.find((r) => r.id === selectedId) ?? null;

  if (selected || creating) {
    return (
      <TenderWorkspace
        key={selected?.id ?? 'new'}
        projectId={projectId}
        rfp={selected}
        seedTaskId={selected ? null : composeTaskId}
        tasks={tasks}
        initialMode={composeMode}
        initialSection={initialSection}
        initialCompare={initialCompare.current}
        todayIso={todayIso}
        onRfpChanged={(next) => {
          upsert(next);
          onRfpChanged?.(next);
          if (!selected) { setCreating(false); openRfp(next.id); }
        }}
        onBack={() => { setCreating(false); openRfp(null); void refreshList(); }}
      />
    );
  }

  return (
    <div className="prc">
      {error ? <p role="alert" className="prc-error">{error}</p> : null}
      <div className="prc-composer-hd">
        <h3 className="prc-h">Tenders</h3>
        <button type="button" className="btn primary" onClick={() => setCreating(true)}>New RFP</button>
      </div>
      {list.length === 0 ? (
        <p className="prc-quiet">
          No tenders yet. Put a piece of the plan out to bid: pick the tasks, invite contractors by
          email, and compare the proposals that come back — all on the shared record.
        </p>
      ) : (
        <div className="prc-picker">
          <ul className="prc-rfp-list">
            {list.map((r) => {
              const badge = rfpStatusBadge(r.status);
              const names = r.root_task_ids
                .map((id) => tasks.find((t) => t.id === id)?.name?.trim())
                .filter((n): n is string => !!n);
              const taskLabel = names.length === 0 ? null
                : names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
              const kind = r.purpose === 'design' ? 'design' : 'build';
              return (
                <li key={r.id}>
                  <button type="button" className="prc-rfp-item" onClick={() => openRfp(r.id)}>
                    <span className="prc-rfp-main">
                      <span className="prc-rfp-title">{r.title}</span>
                      <span className="prc-rfp-tasks">{taskLabel ? `${taskLabel} · ${kind}` : kind}</span>
                      {r.status === 'cancelled' && r.cancel_reason ? (
                        <span className="prc-rfp-tasks">Cancelled: {r.cancel_reason}</span>
                      ) : null}
                    </span>
                    <span className={`prc-badge ${badge.tone}`}>{badge.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
