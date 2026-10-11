'use client';

// The model page's left column (board F3): colour by Task / Status / Who edits
// with the legend and element counts plus "not linked to any task" (M-3) —
// clicking a task isolates it (M-4) —, the open issues pinned on elements
// (M-5) and the access panel: who reads, who edits on which scope, and rows
// whose elements open for whoever wins them (M-6). Everything shown comes
// from getProjectModel; nothing here decides a permission.
import { useMemo, useState } from 'react';
import Link from 'next/link';

import {
  legendRows, type ColourMode, type V2ElementPin, type V2ProjectModel,
} from '@/lib/v2/model-view';

export function ModelSidebar({
  model, links, pins, mode, onMode, elementTotal, isolate, onIsolate, orgName, projectId, onFocusPin,
}: {
  model: V2ProjectModel;
  links: Array<{ global_id: string; task_id: string }>;
  pins: V2ElementPin[];
  mode: ColourMode;
  onMode: (m: ColourMode) => void;
  elementTotal: number;
  isolate: string | null;
  onIsolate: (taskId: string | null) => void;
  orgName: (id: string | null | undefined) => string;
  projectId: string;
  onFocusPin: (globalIds: string[]) => void;
}) {
  const [panel, setPanel] = useState<'legend' | 'issues' | 'access'>('legend');
  const rows = useMemo(() => legendRows(mode, model, links, elementTotal, (id) => orgName(id)), [mode, model, links, elementTotal, orgName]);
  const open = pins.filter((p) => p.state === 'open');
  const taskLabel = (id: string) => { const t = model.tasks.find((x) => x.id === id); return t ? `${t.code} ${t.name}` : 'a task'; };

  return (
    <aside className="mdl-side" aria-label="Legend, issues and access">
      <div className="mdl-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={panel === 'legend'} className={panel === 'legend' ? 'is-on' : ''} onClick={() => setPanel('legend')}>Colour</button>
        <button type="button" role="tab" aria-selected={panel === 'issues'} className={panel === 'issues' ? 'is-on' : ''} onClick={() => setPanel('issues')}>Issues · {open.length}</button>
        <button type="button" role="tab" aria-selected={panel === 'access'} className={panel === 'access' ? 'is-on' : ''} onClick={() => setPanel('access')}>Access</button>
      </div>

      {panel === 'legend' ? (
        <>
          <div className="mdl-seg" role="group" aria-label="Colour by">
            {(['task', 'status', 'editor'] as ColourMode[]).map((m) => (
              <button key={m} type="button" className={mode === m ? 'is-on' : ''} aria-pressed={mode === m} onClick={() => onMode(m)}>
                {{ task: 'Task', status: 'Status', editor: 'Who edits' }[m]}
              </button>
            ))}
          </div>
          <ul className="mdl-legend">
            {rows.map((r) => (
              <li key={r.key}>
                {r.taskId ? (
                  <button type="button" className={`mdl-legend-row${isolate === r.taskId ? ' is-on' : ''}`} onClick={() => onIsolate(isolate === r.taskId ? null : r.taskId!)}
                    title="Isolate this task's elements">
                    <span className="mdl-swatch" style={{ background: r.colour }} />
                    <span className="mdl-legend-label">{r.label}</span>
                    <span className="mdl-count">{r.count}</span>
                  </button>
                ) : (
                  <span className="mdl-legend-row">
                    <span className="mdl-swatch" style={{ background: r.colour }} />
                    <span className="mdl-legend-label">{r.label}</span>
                    <span className="mdl-count">{r.count}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {isolate ? (
            <p className="mdl-note">
              Showing {taskLabel(isolate)} and its sub-tasks. <Link href={`/projects/${projectId}/plan?task=${isolate}`}>Open it in the plan</Link>
            </p>
          ) : <p className="mdl-note">Click a task to isolate its elements. Opening the model from a task’s Files tab lands here with that task isolated.</p>}
        </>
      ) : null}

      {panel === 'issues' ? (
        <ul className="mdl-list">
          {pins.length === 0 ? <li className="mdl-note">No issue is pinned on this model.</li> : null}
          {[...open, ...pins.filter((p) => p.state === 'closed')].map((p) => (
            <li key={p.id} className={`mdl-pin${p.state === 'closed' ? ' is-closed' : ''}`}>
              <button type="button" className="mdl-link" onClick={() => onFocusPin(p.global_ids)}>{p.text}</button>
              <span className="mdl-note">
                {p.global_ids.length} element{p.global_ids.length === 1 ? '' : 's'}
                {p.task_ids.length ? ` · ${p.task_ids.map(taskLabel).join(' · ')}` : ''}
                {p.author.org_id ? ` · ${orgName(p.author.org_id)}` : ' · in your draft'}
                {p.state === 'closed' ? ' · closed' : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {panel === 'access' ? (
        <div className="mdl-access">
          <p><b>Everyone reads. Winners edit their part.</b></p>
          <p className="mdl-note">Read · everyone on the project. Bidders on an RFP see only the version attached to it.</p>
          <ul className="mdl-list">
            {model.access.editors.map((e) => (
              <li key={`${e.role}-${e.org_id}`}>
                <b>{e.org_name ?? orgName(e.org_id)}</b>
                <span className="mdl-note">
                  {e.role === 'author' ? 'Author · whole model · the only one who uploads a new .ifc'
                    : e.role === 'owner' ? 'Owner · whole model · links and issues'
                      : `Elements of its awarded rows · ${e.element_count ?? 0} (${e.task_ids.length} row${e.task_ids.length === 1 ? '' : 's'})`}
                </span>
              </li>
            ))}
            {model.access.unassigned_tasks.map((u) => (
              <li key={u.task_id}>
                <b>{taskLabel(u.task_id)}</b>
                <span className="mdl-note">Pending · edit opens for the winner on award · {u.element_count} element{u.element_count === 1 ? '' : 's'}</span>
              </li>
            ))}
          </ul>
          <p className="mdl-note">Each save is a new model version, attributed to the company that made it. Nothing is overwritten.</p>
        </div>
      ) : null}
    </aside>
  );
}
