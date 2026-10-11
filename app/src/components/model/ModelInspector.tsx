'use client';

// The inspector (PRD-07 M-2; board F8 "Selected · editing"): name, IFC class,
// GlobalId, the linked task(s) and the element's read-only properties. While
// editing, the record-side tools act on the selection: Link to task (M-10
// links), Issue pin (M-5) and close an issue — each a line in the private
// draft. Properties are never editable (D-45: nothing is written into the
// IFC). Elements outside the viewer's scope are shown, not offered: the server
// refuses them anyway (M-8).
import { useEffect, useMemo, useState } from 'react';

import type { IfcProperty, LoadedIfc } from '@/components/ifc/ifc-loader';
import {
  canEditElement, editableTasks, prettyClass, type DraftChange, type V2ElementPin, type V2ProjectModel,
} from '@/lib/v2/model-view';
import type { Tool } from './ModelPage';

export function ModelInspector({
  model, links, pins, selected, loaded, editing, tool, editable, orgName, onChange, onClear,
}: {
  model: V2ProjectModel;
  links: Array<{ global_id: string; task_id: string }>;
  pins: V2ElementPin[];
  selected: string[];
  loaded: LoadedIfc | null;
  editing: boolean;
  tool: Tool;
  editable: Set<string> | 'all';
  orgName: (id: string | null | undefined) => string;
  onChange: (c: DraftChange) => void;
  onClear: () => void;
}) {
  const [props, setProps] = useState<IfcProperty[] | null>(null);
  const [taskId, setTaskId] = useState('');
  const [pinText, setPinText] = useState('');
  const [pinTasks, setPinTasks] = useState<string[]>([]);
  const one = selected.length === 1 ? selected[0] : null;
  const el = one ? loaded?.elements.get(one) ?? null : null;
  const tasksById = useMemo(() => new Map(model.tasks.map((t) => [t.id, t])), [model.tasks]);
  const label = (id: string) => { const t = tasksById.get(id); return t ? `${t.code} ${t.name}` : 'a task'; };
  const mine = editableTasks(model);
  const inScope = selected.filter((g) => canEditElement(editable, g));

  useEffect(() => {
    setProps(null);
    if (!one || !loaded) return;
    let live = true;
    void loaded.properties(one).then((p) => { if (live) setProps(p); });
    return () => { live = false; };
  }, [one, loaded]);

  if (!selected.length) {
    return (
      <aside className="mdl-insp" aria-label="Inspector">
        <p className="mdl-note">{editing
          ? (tool === 'link' || tool === 'pin' ? 'Click elements to select them (click again to drop one), then link them or pin an issue.' : 'Pick an element to see what it is and which task it belongs to.')
          : 'Pick an element to see its name, IFC class, GlobalId, linked task and properties.'}</p>
      </aside>
    );
  }

  const linkedTasks = one ? links.filter((l) => l.global_id === one).map((l) => l.task_id) : [];
  const elementPins = one ? pins.filter((p) => p.global_ids.includes(one)) : [];

  return (
    <aside className="mdl-insp" aria-label="Inspector">
      <div className="mdl-insp-hd">
        <b>{one ? (el?.name || 'Element') : `${selected.length} elements selected`}</b>
        <button type="button" className="mdl-link" onClick={onClear}>Clear</button>
      </div>
      {one ? (
        <dl className="mdl-dl">
          <dt>IFC class</dt><dd>{el ? prettyClass(el.ifcClass) : '—'}</dd>
          <dt>GlobalId</dt><dd className="mdl-mono">{one}</dd>
          <dt>Linked task</dt>
          <dd>
            {linkedTasks.length ? linkedTasks.map((t) => (
              <span key={t} className="mdl-chip">
                {label(t)}
                {editing && canEditElement(editable, one) && mine.some((m) => m.id === t) ? (
                  <button type="button" className="mdl-x" aria-label={`Unlink from ${label(t)}`} onClick={() => onChange({ op: 'unlink', globalId: one, taskId: t })}>×</button>
                ) : null}
              </span>
            )) : 'Not linked to any task'}
          </dd>
        </dl>
      ) : null}

      {editing && tool === 'link' ? (
        <div className="mdl-form">
          {inScope.length < selected.length ? (
            <p className="mdl-warn">{selected.length - inScope.length} selected element{selected.length - inScope.length === 1 ? ' is' : 's are'} outside your edit scope and will not be linked.</p>
          ) : null}
          <label>Link {inScope.length} element{inScope.length === 1 ? '' : 's'} to
            <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              <option value="">Choose a task…</option>
              {mine.map((t) => <option key={t.id} value={t.id}>{t.code} {t.name}</option>)}
            </select>
          </label>
          <button type="button" className="btn sm primary" disabled={!taskId || !inScope.length}
            onClick={() => { for (const g of inScope) onChange({ op: 'link', globalId: g, taskId }); }}>Add to draft</button>
        </div>
      ) : null}

      {editing && tool === 'pin' ? (
        <div className="mdl-form">
          {inScope.length < selected.length ? <p className="mdl-warn">You can pin issues only on elements in your edit scope.</p> : null}
          <label>Issue
            <textarea rows={3} maxLength={2000} value={pinText} onChange={(e) => setPinText(e.target.value)} placeholder="e.g. Drain clash with beam B-12" />
          </label>
          <label>Concerns tasks
            <select multiple value={pinTasks} onChange={(e) => setPinTasks([...e.target.selectedOptions].map((o) => o.value).slice(0, 20))}>
              {model.tasks.map((t) => <option key={t.id} value={t.id}>{t.code} {t.name}</option>)}
            </select>
          </label>
          <button type="button" className="btn sm primary" disabled={!pinText.trim() || !selected.length || inScope.length < selected.length}
            onClick={() => {
              onChange({ op: 'pin', pin: { id: crypto.randomUUID(), globalIds: selected.slice(0, 200), taskIds: pinTasks, text: pinText.trim() } });
              setPinText(''); setPinTasks([]);
            }}>Pin issue on {selected.length} element{selected.length === 1 ? '' : 's'}</button>
        </div>
      ) : null}

      {elementPins.length ? (
        <div className="mdl-form">
          <b>Issues on this element</b>
          {elementPins.map((p) => (
            <p key={p.id} className={`mdl-pin${p.state === 'closed' ? ' is-closed' : ''}`}>
              {p.text} <span className="mdl-note">{p.author.org_id ? orgName(p.author.org_id) : 'in your draft'}{p.state === 'closed' ? ' · closed' : ''}</span>
              {editing && p.state === 'open' && p.author.org_id ? (
                <button type="button" className="mdl-link" onClick={() => onChange({ op: 'close_pin', pinId: p.id })}>Close</button>
              ) : null}
            </p>
          ))}
        </div>
      ) : null}

      {one ? (
        <div className="mdl-props">
          <b>Properties</b> <span className="mdl-note">read-only — from the IFC</span>
          {props === null ? <p className="mdl-note">Reading…</p> : props.length === 0 ? <p className="mdl-note">No property sets.</p> : (
            <dl className="mdl-dl">
              {props.slice(0, 80).map((p, i) => (
                <div key={`${p.set}-${p.name}-${i}`} className="mdl-prop"><dt title={p.set}>{p.name}</dt><dd>{p.value || '—'}</dd></div>
              ))}
            </dl>
          )}
        </div>
      ) : null}
    </aside>
  );
}
