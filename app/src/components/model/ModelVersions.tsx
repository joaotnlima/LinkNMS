'use client';

// Model versions (PRD-07 M-15..M-18; board F10). History newest first — who,
// when, note, base version, current, "edited by …" and "author review
// pending" —; Open a version; Restore vN as v(n+1) (author / owner; nothing is
// deleted); Compare any two versions by GlobalId — the FILE half (added /
// removed / properties changed) read from the two IFC files in the browser,
// the RECORD half (links, issues) from the server; and the author's upload of
// a new .ifc (ModelUpload). Side-by-side and overlay compare are not built:
// the list is the comparison.
import { useState } from 'react';

import { modelViewUrlAction, recordDiffAction, restoreModelAction } from '@/lib/v2/model-actions';
import {
  compareIndexes, historyRows, humanSize, prettyClass, type FileDiff, type V2ProjectModel, type V2RecordDiff,
} from '@/lib/v2/model-view';
import { fetchBytes, readIfcIndex } from './ifc-index';
import { ModelUpload } from './ModelUpload';

export function ModelVersions({
  projectId, model, orgName, onOpen, onChanged, onClose,
}: {
  projectId: string;
  model: V2ProjectModel;
  orgName: (id: string | null | undefined) => string;
  onOpen: (versionNo: number) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const doc = model.document!;
  const rows = historyRows(doc, model.author_org_id ?? null, (id) => orgName(id));
  const [from, setFrom] = useState(Math.max(1, doc.current_version - 1));
  const [to, setTo] = useState(doc.current_version);
  const [diff, setDiff] = useState<{ file: FileDiff; record: V2RecordDiff } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const taskLabel = (id: string) => { const t = model.tasks.find((x) => x.id === id); return t ? `${t.code} ${t.name}` : 'a task'; };

  const restore = async (n: number) => {
    setBusy(`Restoring v${n}…`); setError(null);
    const res = await restoreModelAction(projectId, n);
    setBusy(null);
    if (!res.ok) { setError(res.message); return; }
    onChanged();
  };

  const compare = async () => {
    if (from === to) { setError('Pick two different versions.'); return; }
    setBusy('Reading both versions…'); setError(null); setDiff(null);
    try {
      const [a, b, record] = await Promise.all([modelViewUrlAction(doc.id, from), modelViewUrlAction(doc.id, to), recordDiffAction(projectId, from, to)]);
      if (!a.ok || !b.ok || !record.ok) { setError((!a.ok && a.message) || (!b.ok && b.message) || (!record.ok && record.message) || 'Could not compare.'); return; }
      const lo = Math.min(from, to) === from ? a.value : b.value;
      const hi = lo === a.value ? b.value : a.value;
      const [ia, ib] = [await readIfcIndex(await fetchBytes(lo)), await readIfcIndex(await fetchBytes(hi))];
      setDiff({ file: compareIndexes(ia, ib), record: record.value });
    } catch {
      setError('The two versions could not be read.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mdl-versions" aria-label="Versions">
      <div className="mdl-draft-hd">
        <b>Versions · {doc.versions.length}</b>
        <button type="button" className="btn sm" onClick={onClose}>Back to model</button>
      </div>
      {model.viewer.can_upload ? (
        <ModelUpload projectId={projectId} check={model.upload_check ?? null}
          nextVersion={doc.current_version + 1} onDone={onChanged} />
      ) : null}
      <ol className="mdl-history">
        {rows.map((r) => (
          <li key={r.versionNo} className={r.current ? 'is-current' : ''}>
            <div className="mdl-row">
              <b>v{r.versionNo}</b>
              <span>{r.label}</span>
              {r.current ? <span className="mdl-tag">current</span> : null}
              {r.authorReviewPending ? <span className="mdl-tag mdl-tag-warn">Author review pending</span> : null}
            </div>
            <span className="mdl-note">
              {new Date(r.when).toLocaleString('pt-PT', { dateStyle: 'medium', timeStyle: 'short' })}
              {r.kind === 'upload' ? ` · ${humanSize(r.sizeBytes)}` : ''}
              {r.base ? ` · based on v${r.base}` : ''}
            </span>
            {r.note ? <p className="mdl-quote">“{r.note}”</p> : null}
            <div className="mdl-row">
              <button type="button" className="mdl-link" onClick={() => onOpen(r.versionNo)}>Open</button>
              {model.viewer.can_restore && !r.current ? (
                <button type="button" className="mdl-link" disabled={Boolean(busy)} onClick={() => restore(r.versionNo)}>Restore as v{doc.current_version + 1}</button>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <p className="mdl-note">Versions are never overwritten or deleted. Restoring a version creates a new one as a copy of it; every later version stays on the record.</p>

      <div className="mdl-compare">
        <b>Compare</b>
        <div className="mdl-row">
          <select aria-label="From version" value={from} onChange={(e) => setFrom(Number(e.target.value))}>
            {rows.map((r) => <option key={r.versionNo} value={r.versionNo}>v{r.versionNo}</option>)}
          </select>
          <span>↔</span>
          <select aria-label="To version" value={to} onChange={(e) => setTo(Number(e.target.value))}>
            {rows.map((r) => <option key={r.versionNo} value={r.versionNo}>v{r.versionNo}</option>)}
          </select>
          <button type="button" className="btn sm" onClick={compare} disabled={Boolean(busy)}>Compare</button>
        </div>
        {diff ? (
          <div className="mdl-diff">
            <p className="mdl-row">
              <span className="mdl-tag">Added {diff.file.added.length}</span>
              <span className="mdl-tag">Removed {diff.file.removed.length}</span>
              <span className="mdl-tag">Properties changed {diff.file.changed.length}</span>
              <span className="mdl-tag">Record changes {diff.record.links_added.length + diff.record.links_removed.length + diff.record.pins_added.length + diff.record.pins_closed.length}</span>
            </p>
            {diff.file.added.length && diff.file.removed.length && diff.file.changed.length === 0 && diff.file.added.length === diff.file.removed.length ? (
              <p className="mdl-warn">Every element looks removed and added — the export likely regenerated its GlobalIds.</p>
            ) : null}
            <ul className="mdl-list">
              {diff.file.changed.slice(0, 50).map((c) => (
                <li key={c.globalId}><span className="mdl-tag">IFC</span> {c.name || c.globalId} <span className="mdl-mono mdl-note">{c.globalId}</span>
                  {c.changes.slice(0, 6).map((x) => <div key={x.key} className="mdl-note">{x.key}: {x.from ?? '—'} → {x.to ?? '—'}</div>)}
                </li>
              ))}
              {diff.file.added.slice(0, 30).map((a) => <li key={`a-${a.globalId}`}><span className="mdl-tag">IFC</span> Added {a.name || prettyClass(a.cls)} <span className="mdl-mono mdl-note">{a.globalId}</span></li>)}
              {diff.file.removed.slice(0, 30).map((a) => <li key={`r-${a.globalId}`}><span className="mdl-tag">IFC</span> Removed {a.name || prettyClass(a.cls)} <span className="mdl-mono mdl-note">{a.globalId}</span></li>)}
              {diff.record.links_added.slice(0, 50).map((l) => <li key={`la-${l.global_id}-${l.task_id}`}><span className="mdl-tag">Record</span> Linked <span className="mdl-mono">{l.global_id}</span> to {taskLabel(l.task_id)}</li>)}
              {diff.record.links_removed.slice(0, 50).map((l) => <li key={`lr-${l.global_id}-${l.task_id}`}><span className="mdl-tag">Record</span> Unlinked <span className="mdl-mono">{l.global_id}</span> from {taskLabel(l.task_id)}</li>)}
              {diff.record.pins_added.map((p) => <li key={`pa-${p.id}`}><span className="mdl-tag">Record</span> Issue pinned: “{p.text}”</li>)}
              {diff.record.pins_closed.map((p) => <li key={`pc-${p.id}`}><span className="mdl-tag">Record</span> Issue closed: “{p.text}”</li>)}
            </ul>
            <p className="mdl-note">Diffs match elements by IFC GlobalId.</p>
          </div>
        ) : null}
      </div>
      {busy ? <p className="mdl-note" role="status">{busy}</p> : null}
      {error ? <p role="alert" className="mdl-err">{error}</p> : null}
    </section>
  );
}
