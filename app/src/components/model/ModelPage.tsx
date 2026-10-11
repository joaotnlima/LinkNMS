'use client';

// The shared project model (PRD-07; boards F3 ProjectModel, F8 ModelEdit,
// F9 SaveVersion, F10 Versions). One client island:
//   - view: the 3D viewport, colour by task / status / who edits with the
//     legend (M-3), `?task=` isolates a task (M-4), the inspector (M-2), the
//     issues list (M-5) and the access panel (M-6);
//   - edit (only with a write scope, M-1/M-8): Link to task, Issue pin,
//     Measure; every change goes into a PRIVATE draft kept in this browser
//     (M-11) until "Save as v(n+1)" with a required note (M-12); a 409 asks
//     element by element (M-14);
//   - versions (M-15..M-18): ModelVersions.
// The server decides every permission and rejects out-of-scope changes; the
// UI only mirrors the scope it was told to grey out what would be refused.
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { LoadedIfc } from '@/components/ifc/ifc-loader';
import { loadModelAction, modelViewUrlAction } from '@/lib/v2/model-actions';
import {
  addChange, applyDraft, colourContext, colourOf, editableElements, isolatedElements, resolveTaskParam,
  FADED, HIGHLIGHT, type ColourMode, type Draft, type DraftChange, type V2ProjectModel,
} from '@/lib/v2/model-view';
import { fetchBytes } from './ifc-index';
import { ModelSidebar } from './ModelSidebar';
import { ModelInspector } from './ModelInspector';
import { ModelDraftBar } from './ModelDraftBar';
import { ModelVersions } from './ModelVersions';
import { ModelUpload } from './ModelUpload';
import './model.css';

const ModelViewport = dynamic(() => import('./ModelViewport'), {
  ssr: false,
  loading: () => <div className="mdl-viewport"><p className="mdl-overlay">Preparing the 3D viewer…</p></div>,
});

export type Tool = 'select' | 'link' | 'pin' | 'measure';

function draftKey(projectId: string) { return `linknms.model-draft.${projectId}`; }
function readDraft(projectId: string): Draft | null {
  try { const raw = window.localStorage.getItem(draftKey(projectId)); return raw ? JSON.parse(raw) as Draft : null; } catch { return null; }
}
function writeDraft(projectId: string, draft: Draft | null) {
  try {
    if (draft && draft.changes.length) window.localStorage.setItem(draftKey(projectId), JSON.stringify(draft));
    else window.localStorage.removeItem(draftKey(projectId));
  } catch { /* private window: the draft lives for this page only */ }
}

export function ModelPage({
  projectId, projectName, initial, orgNames, taskParam, versionParam, initialTab,
}: {
  projectId: string;
  projectName: string;
  initial: V2ProjectModel;
  orgNames: Record<string, string>;
  taskParam: string | null;
  versionParam: number | null;
  initialTab: 'model' | 'versions';
}) {
  const [model, setModel] = useState<V2ProjectModel>(initial);
  const [error, setError] = useState<string | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [loaded, setLoaded] = useState<LoadedIfc | null>(null);
  const [mode, setMode] = useState<ColourMode>('task');
  const [isolate, setIsolate] = useState<string | null>(() => resolveTaskParam(taskParam, initial.tasks));
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [tool, setTool] = useState<Tool>('select');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tab, setTab] = useState<'model' | 'versions'>(initialTab);
  const [distance, setDistance] = useState<number | null>(null);
  const [focus, setFocus] = useState<string[] | null>(null);

  const doc = model.document;
  const viewing = model.viewing_version ?? doc?.current_version ?? 0;
  const isCurrent = Boolean(doc) && viewing === doc!.current_version;
  const orgName = useCallback((id: string | null | undefined) => (id ? orgNames[id] ?? model.access.editors.find((e) => e.org_id === id)?.org_name ?? 'Organisation' : '—'), [orgNames, model.access.editors]);
  const canEdit = model.viewer.scope.kind !== 'none' && isCurrent;

  useEffect(() => { setDraft(readDraft(projectId)); }, [projectId]);
  useEffect(() => { writeDraft(projectId, draft); }, [projectId, draft]);

  const reload = useCallback(async (version?: number | null) => {
    const res = await loadModelAction(projectId, version ?? null);
    if (res.ok) { setModel(res.value); setError(null); } else setError(res.message);
    return res.ok ? res.value : null;
  }, [projectId]);

  // Bytes of the version being viewed; re-fetched when the version changes.
  useEffect(() => {
    if (!doc || viewing < 1) { setBytes(null); return; }
    let live = true;
    setLoaded(null);
    void modelViewUrlAction(doc.id, viewing).then(async (res) => {
      if (!live) return;
      if (!res.ok) { setError(res.message); return; }
      try { const b = await fetchBytes(res.value); if (live) setBytes(b); } catch { if (live) setError('The model file could not be downloaded. Try again.'); }
    });
    return () => { live = false; };
  }, [doc?.id, viewing]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (versionParam && doc && versionParam !== viewing) void reload(versionParam); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The record as the viewer sees it: with the draft applied while editing.
  const record = useMemo(() => applyDraft(model.links, model.pins, editing ? draft : null), [model.links, model.pins, editing, draft]);
  const ctx = useMemo(() => colourContext(model, record.links), [model, record.links]);
  const isolated = useMemo(() => (isolate ? isolatedElements(isolate, model.tasks, record.links) : null), [isolate, model.tasks, record.links]);
  const editable = useMemo(() => editableElements(model), [model]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const paint = useCallback((gid: string) => {
    if (selectedSet.has(gid)) return HIGHLIGHT;
    if (isolated && !isolated.has(gid)) return FADED;
    return colourOf(mode, gid, ctx);
  }, [selectedSet, isolated, mode, ctx]);
  const paintKey = `${mode}|${isolate ?? ''}|${selected.join(',')}|${record.links.length}|${JSON.stringify(draft?.changes.length ?? 0)}|${editing}`;

  const onPick = useCallback((gid: string | null, additive: boolean) => {
    setSelected((prev) => {
      if (!gid) return additive ? prev : [];
      if (additive || tool === 'link' || tool === 'pin') return prev.includes(gid) ? prev.filter((g) => g !== gid) : [...prev, gid];
      return [gid];
    });
  }, [tool]);

  const isolateTask = useCallback((taskId: string | null) => {
    setIsolate(taskId);
    const ids = taskId ? [...isolatedElements(taskId, model.tasks, record.links)] : null;
    setFocus(ids && ids.length ? ids : null);
    try {
      const url = new URL(window.location.href);
      if (taskId) url.searchParams.set('task', model.tasks.find((t) => t.id === taskId)?.code || taskId); else url.searchParams.delete('task');
      window.history.replaceState(null, '', url);
    } catch { /* cosmetic */ }
  }, [model.tasks, record.links]);

  const change = useCallback((c: DraftChange) => {
    setDraft((d) => addChange(d && d.changes.length ? d : { baseVersion: doc?.current_version ?? 1, changes: [] }, c));
  }, [doc?.current_version]);

  const afterSave = useCallback(async () => {
    setDraft(null);
    setSelected([]);
    setEditing(false);
    await reload(null);
  }, [reload]);

  if (!doc) {
    return (
      <main className="mdl">
        <header className="mdl-hd"><div><h1 className="mdl-h">Model</h1><p className="mdl-note">{projectName} · shared by every task</p></div></header>
        {error ? <p role="alert" className="mdl-err">{error}</p> : null}
        <section className="mdl-card mdl-empty">
          <p>This build has no model yet. Put the IFC on the record once — every task, RFP and company then works from the same file. The organisation that uploads it becomes the model’s author: the only one who uploads later versions.</p>
          {model.viewer.can_upload ? <ModelUpload projectId={projectId} check={null} nextVersion={1} onDone={() => reload(null)} /> : null}
        </section>
      </main>
    );
  }

  const draftCount = draft?.changes.length ?? 0;
  return (
    <main className="mdl">
      <header className="mdl-hd">
        <div>
          <h1 className="mdl-h">Model</h1>
          <p className="mdl-note">{projectName} · {doc.title} · shared by every task</p>
        </div>
        <div className="mdl-actions">
          <label className="mdl-version">
            <span className="sr-only">Version</span>
            <select value={viewing} onChange={(e) => { setEditing(false); void reload(Number(e.target.value)); }}>
              {[...doc.versions].reverse().map((v) => (
                <option key={v.version_no} value={v.version_no}>v{v.version_no}{v.version_no === doc.current_version ? ' · current' : ''}</option>
              ))}
            </select>
          </label>
          <button type="button" className={`btn sm${tab === 'versions' ? ' is-on' : ''}`} onClick={() => setTab(tab === 'versions' ? 'model' : 'versions')}>
            History · {doc.versions.length}
          </button>
          {model.viewer.scope.kind !== 'none' ? (
            <button type="button" className={`btn sm${editing ? ' primary' : ''}`} disabled={!isCurrent}
              title={isCurrent ? undefined : 'Open the current version to edit'}
              onClick={() => { setEditing((e) => !e); setTool('select'); }}>
              {editing ? 'Stop editing' : model.viewer.scope.kind === 'tasks' ? 'Edit my elements' : 'Edit the record'}
            </button>
          ) : null}
        </div>
      </header>
      {error ? <p role="alert" className="mdl-err">{error}</p> : null}
      {!isCurrent ? <p className="mdl-banner">You are viewing v{viewing}. v{doc.current_version} is current.</p> : null}

      {tab === 'versions' ? (
        <ModelVersions projectId={projectId} model={model} orgName={orgName}
          onOpen={(n) => { setTab('model'); void reload(n); }} onChanged={() => reload(null)} onClose={() => setTab('model')} />
      ) : null}

      <div className="mdl-body" hidden={tab !== 'model'}>
        <ModelSidebar model={model} links={record.links} pins={record.pins} mode={mode} onMode={setMode}
          elementTotal={loaded?.elements.size ?? 0} isolate={isolate} onIsolate={isolateTask} orgName={orgName}
          projectId={projectId} onFocusPin={(gids) => { setSelected(gids); setFocus(gids); }} />
        <section className="mdl-stage">
          {editing ? (
            <div className="mdl-tools" role="toolbar" aria-label="Edit tools">
              {(['select', 'link', 'pin', 'measure'] as Tool[]).map((t) => (
                <button key={t} type="button" className={`mdl-tool${tool === t ? ' is-on' : ''}`} aria-pressed={tool === t} onClick={() => { setTool(t); setDistance(null); }}>
                  {{ select: 'Select', link: 'Link to task', pin: 'Issue pin', measure: 'Measure' }[t]}
                </button>
              ))}
              <button type="button" className="mdl-tool" disabled title="LinkNMS never changes the model's geometry or properties — the author does, in their tool, and uploads a new version (D-45).">Move / reshape — not available</button>
            </div>
          ) : (
            <div className="mdl-tools" role="toolbar" aria-label="View tools">
              <button type="button" className={`mdl-tool${tool === 'measure' ? ' is-on' : ''}`} aria-pressed={tool === 'measure'}
                onClick={() => { setTool(tool === 'measure' ? 'select' : 'measure'); setDistance(null); }}>Measure</button>
              {isolate ? <button type="button" className="mdl-tool" onClick={() => isolateTask(null)}>Show all tasks</button> : null}
            </div>
          )}
          {bytes ? (
            <ModelViewport bytes={bytes} colourOf={paint} paintKey={paintKey} onLoaded={setLoaded} onPick={onPick}
              measuring={tool === 'measure'} onMeasure={setDistance} focus={focus} />
          ) : <div className="mdl-viewport"><p className="mdl-overlay" role="status">Fetching v{viewing}…</p></div>}
          {distance != null ? <p className="mdl-note">Distance: {distance.toFixed(2)} model units (usually metres)</p> : null}
          {editing && draftCount ? (
            <ModelDraftBar projectId={projectId} model={model} draft={draft!} orgName={orgName} elements={loaded?.elements ?? null}
              onDiscard={() => setDraft(null)} onSaved={afterSave} onRemove={(i) => setDraft((d) => (d ? { ...d, changes: d.changes.filter((_, j) => j !== i) } : d))} />
          ) : null}
        </section>
        <ModelInspector model={model} links={record.links} pins={record.pins} selected={selected} loaded={loaded}
          editing={editing} tool={tool} editable={editable} orgName={orgName} onChange={change}
          onClear={() => setSelected([])} />
      </div>
    </main>
  );
}
