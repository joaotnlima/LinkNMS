'use client';

// Data hooks the tender flow's containers share (PRD-02): planning's tender
// window and one tender's follow data. Both read through the server actions —
// the browser never mints its own v2 client (LINA-309).

import { useCallback, useEffect, useState } from 'react';

import { loadTenderFollowAction, loadTenderWindowAction } from '../procurement-actions';
import type { TenderFollow } from '@/lib/v2/tender-flow';
import type { V2TenderWindow } from '@/lib/v2/tender-flow-view';
import type { V2Rfp } from '@/lib/v2/tendering-view';

/**
 * Planning's view of tendering `taskIds` (coverage, window, critical path,
 * award-by), re-read when the rows, the include-backs or the bids-due day
 * change. Debounced so typing a date does not fire a read per keystroke.
 */
export function useTenderWindow(
  projectId: string, taskIds: readonly string[], include: readonly string[], bidsDue: string | null,
): { window: V2TenderWindow | null; loading: boolean } {
  const [window, setWindow] = useState<V2TenderWindow | null>(null);
  const [loading, setLoading] = useState(false);
  const key = `${taskIds.join(',')}|${include.join(',')}|${bidsDue ?? ''}`;
  useEffect(() => {
    if (taskIds.length === 0) { setWindow(null); return undefined; }
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void loadTenderWindowAction(projectId, [...taskIds], { include: [...include], bidsDue })
        .then((w) => { if (live) setWindow(w); })
        .catch(() => { if (live) setWindow(null); })
        .finally(() => { if (live) setLoading(false); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
    // `key` folds the three inputs into one stable dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, key]);
  return { window, loading };
}

/** One tender's bidders + its own lanes; `reload` after a write. */
export function useTenderFollow(rfp: Pick<V2Rfp, 'id' | 'root_task_ids'> | null): {
  data: TenderFollow | null; loading: boolean; error: string | null; reload: () => Promise<void>;
} {
  const [data, setData] = useState<TenderFollow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = rfp?.id ?? null;
  const roots = rfp?.root_task_ids.join(',') ?? '';
  const reload = useCallback(async () => {
    if (!id) { setData(null); return; }
    setLoading(true);
    setError(null);
    try {
      setData(await loadTenderFollowAction({ id, root_task_ids: roots ? roots.split(',') : [] }));
    } catch {
      setError('Could not load the bidders. Try again.');
    } finally {
      setLoading(false);
    }
  }, [id, roots]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, loading, error, reload };
}

/**
 * Planning's window for an EXISTING tender: its roots, with the assigned rows
 * it chose to include put back (planning lists every assigned descendant as
 * left out; the RFP records which ones it actually left out).
 */
export function useRfpWindow(
  projectId: string, rfp: Pick<V2Rfp, 'root_task_ids' | 'excluded_task_ids' | 'submission_deadline'> | null,
): { window: V2TenderWindow | null; loading: boolean } {
  const roots = rfp?.root_task_ids ?? [];
  const [include, setInclude] = useState<string[]>([]);
  const due = rfp?.submission_deadline?.slice(0, 10) ?? null;
  const res = useTenderWindow(projectId, roots, include, due);
  const excludedKey = (rfp?.excluded_task_ids ?? []).join(',');
  useEffect(() => {
    if (!res.window) return;
    const excluded = new Set(excludedKey ? excludedKey.split(',') : []);
    const back = res.window.left_out.map((r) => r.task_id).filter((id) => !excluded.has(id));
    if (back.length) setInclude((cur) => [...new Set([...cur, ...back])]);
  }, [res.window, excludedKey]);
  return res;
}
