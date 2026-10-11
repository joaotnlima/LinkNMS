'use client';

// The private draft and its save (PRD-07 M-11, M-12, M-14; boards F8 / F9).
// The draft lists unsaved changes — every one tagged `Record` (kept on
// LinkNMS, carried by GlobalId; nothing is written into the IFC, D-45). Save
// asks for the required note, says "edited by …" when the saver is not the
// author (the author is notified to review), and on a 409 lists the elements
// someone changed since the draft's base so the saver chooses, element by
// element, whose change stays — never last-write-wins.
import { useState } from 'react';

import { saveModelEditsAction } from '@/lib/v2/model-actions';
import { draftBody, draftLines, type Draft, type V2Conflict, type V2ProjectModel } from '@/lib/v2/model-view';
import type { IfcElement } from '@/components/ifc/ifc-loader';

export function ModelDraftBar({
  projectId, model, draft, orgName, elements, onDiscard, onSaved, onRemove,
}: {
  projectId: string;
  model: V2ProjectModel;
  draft: Draft;
  orgName: (id: string | null | undefined) => string;
  elements: Map<string, IfcElement> | null;
  onDiscard: () => void;
  onSaved: () => void;
  onRemove: (index: number) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<V2Conflict[]>([]);
  const [choices, setChoices] = useState<Record<string, 'mine' | 'theirs'>>({});
  const [refused, setRefused] = useState<Array<{ change_index: number; reason: string }>>([]);
  const doc = model.document!;
  const next = doc.current_version + 1;
  const taskLabel = (id: string) => { const t = model.tasks.find((x) => x.id === id); return t ? `${t.code} ${t.name}` : 'a task'; };
  const elementLabel = (gid: string) => elements?.get(gid)?.name || gid;
  const lines = draftLines(draft, taskLabel, elementLabel);
  const isAuthor = model.viewer.scope.kind === 'author';
  const author = model.author_org_id ? orgName(model.author_org_id) : 'the author';
  const stale = draft.baseVersion < doc.current_version;

  const save = async () => {
    setSaving(true);
    setError(null);
    setRefused([]);
    const res = await saveModelEditsAction(projectId, draftBody(draft, note, choices));
    setSaving(false);
    if (res.ok) { setOpen(false); setNote(''); setConflicts([]); setChoices({}); onSaved(); return; }
    if (res.code === 'version_conflict' && res.conflicts?.length) { setConflicts(res.conflicts); setError(res.message); return; }
    if (res.code === 'out_of_scope' && res.refused?.length) { setRefused(res.refused); setError(res.message); return; }
    setError(res.message);
  };

  const unresolved = conflicts.filter((c) => !choices[c.global_id]);
  return (
    <section className="mdl-draft" aria-label="Unsaved changes">
      <div className="mdl-draft-hd">
        <b>Unsaved changes · {draft.changes.length}</b>
        <span className="mdl-note">editing on top of v{draft.baseVersion}{stale ? ` — v${doc.current_version} came out meanwhile; untouched elements apply on top of it` : ''}</span>
      </div>
      <ul className="mdl-list">
        {draft.changes.map((c, i) => (
          <li key={i}>
            <span className="mdl-tag">Record</span>{' '}
            {draftLines({ ...draft, changes: [c] }, taskLabel, elementLabel)[0]}
            <button type="button" className="mdl-x" aria-label="Remove this change" onClick={() => onRemove(i)}>×</button>
          </li>
        ))}
      </ul>
      <p className="mdl-note">Kept as your private draft until you save. Nobody else sees it.</p>
      <div className="mdl-row">
        <button type="button" className="btn sm" onClick={onDiscard}>Discard changes</button>
        <button type="button" className="btn sm primary" onClick={() => setOpen(true)}>Save as v{next}…</button>
      </div>

      {open ? (
        <div className="mdl-dialog" role="dialog" aria-modal="true" aria-label={`Save as v${next}`}>
          <div className="mdl-dialog-card">
            <h2 className="mdl-h">Save as v{next}</h2>
            <p className="mdl-note">v{doc.current_version} stays on the record exactly as it is. v{next} becomes the current version for every task and RFP that follows the model.</p>
            <ul className="mdl-list">{lines.map((l, i) => <li key={i}><span className="mdl-tag">Record</span> {l}</li>)}</ul>
            <p className="mdl-note">Record = kept on the shared record and carried to every later version by element GlobalId. The IFC file is not changed.</p>
            <label className="mdl-form">What changed and why <span className="mdl-note">(required — it goes on the record)</span>
              <textarea rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            {!isAuthor ? (
              <p className="mdl-warn">You are not the model’s author. v{next} will be marked “edited by” your organisation, and {author} is notified to review it. The owners of the tasks whose elements changed are notified too.</p>
            ) : null}
            {conflicts.length ? (
              <div className="mdl-conflicts">
                <b>Changed since v{draft.baseVersion} — choose per element</b>
                {conflicts.map((c) => (
                  <div key={c.global_id} className="mdl-row">
                    <span>{elementLabel(c.global_id)} <span className="mdl-note">v{c.version} · {orgName(c.by_org_id)}</span></span>
                    <label><input type="radio" name={`c-${c.global_id}`} checked={choices[c.global_id] === 'mine'} onChange={() => setChoices({ ...choices, [c.global_id]: 'mine' })} /> Keep mine</label>
                    <label><input type="radio" name={`c-${c.global_id}`} checked={choices[c.global_id] === 'theirs'} onChange={() => setChoices({ ...choices, [c.global_id]: 'theirs' })} /> Keep theirs</label>
                  </div>
                ))}
              </div>
            ) : null}
            {refused.length ? (
              <ul className="mdl-list">{refused.map((r) => <li key={r.change_index} className="mdl-err">Change {r.change_index + 1}: {r.reason}</li>)}</ul>
            ) : null}
            {error ? <p role="alert" className="mdl-err">{error}</p> : null}
            <div className="mdl-row">
              <button type="button" className="btn sm" onClick={() => setOpen(false)}>Keep editing</button>
              <button type="button" className="btn sm primary" disabled={saving || !note.trim() || unresolved.length > 0} onClick={save}>
                {saving ? 'Saving…' : `Save as v${next}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
