'use client';

// The Files tab of the docked task panel (PRD-05 F-1..F-5; board F1 TaskModel,
// F2 DocTask): Deliverables — what the task must hand over, with review — and
// Reference — what the work is built from. Separate from Conversation (F-5).
//
// One read per task (the task's files + its deliverables, two module endpoints).
// It stays mounted while the panel shows other tabs (`visible` false) so the tab
// label can carry "n to review" or the file count (F-1) and the status picker
// can say done is blocked (F-16, D-48) — the server refuses it either way.
import { useCallback, useEffect, useState } from 'react';

import { loadTaskFilesAction } from '@/lib/v2/task-files-actions';
import type { DeliverableView, TaskFilesView } from '@/lib/v2/task-files-view';
import { AddFilesDialog } from './AddFilesDialog';
import { DeliverablesSection } from './DeliverablesSection';
import { ReferenceSection } from './ReferenceSection';
import './files.css';

export interface TaskFilesSummary {
  fileCount: number;
  toReview: number;
  doneBlocked: boolean;
}

export function TaskFiles({
  projectId, taskId, taskName, hasSubtasks, visible, taskNameOf, orgNameOf, onSummary,
}: {
  projectId: string;
  /** The v2 task id, or null while the row is unsaved (nothing to hang files on). */
  taskId: string | null;
  taskName: string;
  hasSubtasks: boolean;
  visible: boolean;
  taskNameOf: (id: string) => string | null;
  orgNameOf: (id: string | null) => string | null;
  onSummary?: (summary: TaskFilesSummary | null) => void;
}) {
  const [view, setView] = useState<TaskFilesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dialog, setDialog] = useState<{ deliverable: DeliverableView | null } | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!taskId) { setView(null); setError(null); return; }
    let live = true;
    setLoading(true);
    setError(null);
    loadTaskFilesAction(taskId)
      .then((res) => {
        if (!live) return;
        if (res.ok) setView(res.value);
        else { setView(null); setError(res.message); }
      })
      .catch(() => { if (live) setError('Could not load this task’s files.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [taskId, tick]);

  // A stale view from the task just left is never summarised for the new one.
  const current = view && view.taskId === taskId ? view : null;
  useEffect(() => {
    onSummary?.(current ? {
      fileCount: current.files.length,
      toReview: current.deliverables.toReview,
      doneBlocked: current.deliverables.doneBlocked,
    } : null);
  }, [current, onSummary]);

  if (!visible) return null;

  if (!taskId) {
    return (
      <section className="tfl" aria-label="Files">
        <p className="tfl-note">Save the plan to add files. Files live on the task once it is saved.</p>
      </section>
    );
  }

  const d = current?.deliverables;
  const canEditTask = Boolean(d && (d.canEdit || d.canSubmit));

  return (
    <section className="tfl" aria-label="Files">
      {error ? <p role="alert" className="tfl-err">{error}</p> : null}
      {loading && !current ? <p className="tfl-note" role="status">Loading the files…</p> : null}
      {current && d ? (
        <>
          <DeliverablesSection taskId={taskId} view={d} orgName={orgNameOf} onChanged={reload}
            onSubmitFile={(deliverable) => setDialog({ deliverable })} />
          <ReferenceSection taskId={taskId} files={current.files} canEdit={canEditTask}
            taskName={taskNameOf} orgName={orgNameOf} onAdd={() => setDialog({ deliverable: null })} onChanged={reload} />
          <p className="tfl-note">Deliverables are what you approve. Reference files are what the work is built from.</p>
        </>
      ) : null}
      {dialog ? (
        <AddFilesDialog
          projectId={projectId} taskId={taskId} taskName={taskName} hasSubtasks={hasSubtasks}
          deliverable={dialog.deliverable}
          onClose={() => { setDialog(null); reload(); }}
          onDone={() => { setDialog(null); reload(); }}
        />
      ) : null}
    </section>
  );
}
