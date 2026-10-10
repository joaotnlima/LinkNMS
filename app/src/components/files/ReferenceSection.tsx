'use client';

// The Reference section of a task's Files tab (PRD-05 F-3, F-4 slot, F-5;
// board F1 TaskModel): what the work is built from. Every file lives once in the
// project and is linked here — "also on 2.5.1" says where else it is used.
// Files attached to the task itself (and in its conversation) show here too.
import { useState } from 'react';

import { unlinkFileAction } from '@/lib/v2/task-files-actions';
import {
  filterCounts, referenceFiles, type FileView, type ReferenceFilter,
} from '@/lib/v2/task-files-view';
import { ReferenceRow } from './FileBits';

const FILTERS: Array<{ key: ReferenceFilter; label: string }> = [
  { key: 'all', label: 'All' }, { key: 'pdf', label: 'PDF' }, { key: 'dwg', label: 'DWG' },
  { key: 'ifc', label: 'IFC' }, { key: 'image', label: 'Images' },
];

export function ReferenceSection({
  taskId, files, canEdit, taskName, orgName, onAdd, onChanged,
}: {
  taskId: string;
  files: FileView[];
  canEdit: boolean;
  taskName: (id: string) => string | null;
  orgName: (id: string | null) => string | null;
  onAdd: () => void;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<ReferenceFilter>('all');
  const [error, setError] = useState<string | null>(null);
  const counts = filterCounts(files);
  const shown = referenceFiles(files, filter);

  async function unlink(file: FileView) {
    setError(null);
    const res = await unlinkFileAction(taskId, file.id);
    if (!res.ok) setError(res.message);
    else onChanged();
  }

  return (
    <section className="tfl-sec" aria-label="Reference">
      <div className="tfl-hd">
        <h4 className="tfl-h">Reference <span className="tfl-note">· what to build from</span></h4>
        {canEdit ? <button type="button" className="btn sm" onClick={onAdd}>＋ Add</button> : null}
      </div>

      {/* F-4: the shared project model card lands with PRD-07 (IFC model page). */}
      <div className="tfl-slot" data-slot="project-model">
        Project model — the shared IFC model and the elements linked to this task appear here once the build has one.
      </div>

      {counts.all > 0 ? (
        <div className="tfl-tools" role="group" aria-label="Filter by type">
          {FILTERS.filter((f) => f.key === 'all' || counts[f.key] > 0).map((f) => (
            <button key={f.key} type="button" className={`tfl-tool${filter === f.key ? ' is-on' : ''}`}
              aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label} {counts[f.key]}
            </button>
          ))}
        </div>
      ) : null}
      {error ? <p role="alert" className="tfl-err">{error}</p> : null}

      {shown.length ? (
        <div className="tfl-card">
          {shown.map((f) => (
            <ReferenceRow key={f.id} file={f} taskId={taskId} taskName={taskName} orgName={orgName}
              onUnlink={canEdit ? (file) => { void unlink(file); } : undefined} />
          ))}
        </div>
      ) : (
        <p className="tfl-note">
          No reference files yet. Drawings (PDF, DWG, DXF), the IFC model and photos — up to 100 MB each.
        </p>
      )}
      <p className="tfl-note">
        Every file lives once, in the project&apos;s files. A task only links to it, so a new version shows up on every task that uses it.
      </p>
    </section>
  );
}
