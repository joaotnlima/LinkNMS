'use client';

// Add files to a task (PRD-05 F-6..F-10, F-13; board F4 AddFile). Two ways in:
//   • upload — each file becomes ONE project file linked to this task (never a
//     copy), or a new version of a matching project file (F-8, the person picks);
//     per-upload state Ready / Making preview… / No preview (F-7);
//   • link from the project — search by sheet number or name, filter by type,
//     multi-select (F-9). Linking never copies.
// "Also on sub-tasks" links every current sub-task (inherited, removable per
// sub-task — F-10). In deliverable mode the one file handed in is submitted
// against the deliverable with a note (F-13).
// The browser PUTs the bytes straight to storage (sha256 pinned); reserve and
// complete go through server actions. Every refusal is the server's sentence.
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  completeUploadAction, linkFilesAction, reserveTaskUploadAction, searchProjectFilesAction, submitDeliverableAction,
} from '@/lib/v2/task-files-actions';
import { digestSha256, putToTicket } from '@/lib/v2/upload-client';
import {
  ACCEPTED_FILES, FILE_TYPE_TAG, fileTypeOfName, matchingFile, uploadRefusal,
  type DeliverableView, type FileType, type FileView,
} from '@/lib/v2/task-files-view';
import { Badge, FileTypeTag } from './FileBits';

type PickState = 'waiting' | 'uploading' | 'ready' | 'preview' | 'error';
interface Pick {
  key: string; file: File; type: FileType; refusal: string | null;
  match: FileView | null; choice: 'version' | 'separate'; state: PickState; message?: string;
}

const KIND: Record<FileType, string> = { pdf: 'drawing', dwg: 'drawing', dxf: 'drawing', ifc: 'bim', image: 'photo', other: 'other' };
const SEARCH_TYPES: Array<FileType | null> = [null, 'pdf', 'dwg', 'ifc', 'image'];

export function AddFilesDialog({
  projectId, taskId, taskName, hasSubtasks, deliverable = null, onClose, onDone,
}: {
  projectId: string;
  taskId: string;
  taskName: string;
  hasSubtasks: boolean;
  deliverable?: DeliverableView | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const single = deliverable != null;
  const [picks, setPicks] = useState<Pick[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<FileView[]>([]);
  const [q, setQ] = useState('');
  const [type, setType] = useState<FileType | null>(null);
  const [subtasks, setSubtasks] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // The project's files, for the picker and for spotting "new version of X" (F-8).
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      void searchProjectFilesAction(projectId, q, type).then((res) => {
        if (live) { if (res.ok) setResults(res.value); else setError(res.message); }
      });
    }, q ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [projectId, q, type]);

  const addPicked = useCallback((list: FileList | null) => {
    if (!list?.length) return;
    const next = [...list].slice(0, single ? 1 : 20).map((file, i) => {
      const match = matchingFile(results, file.name);
      return {
        key: `${Date.now()}-${i}-${file.name}`, file, type: fileTypeOfName(file.name, file.type),
        refusal: uploadRefusal(file), match, choice: match ? 'version' : 'separate', state: 'waiting',
      } as Pick;
    });
    setPicks((prev) => (single ? next : [...prev, ...next]));
    if (single) setSelected(new Set());
  }, [results, single]);

  const set = (key: string, patch: Partial<Pick>) =>
    setPicks((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  async function uploadOne(p: Pick): Promise<string | null> {
    set(p.key, { state: 'uploading' });
    const mime = p.file.type || 'application/octet-stream';
    try {
      const { hex, base64 } = await digestSha256(p.file);
      const reserved = await reserveTaskUploadAction({
        projectId, taskId, role: single ? 'deliverable' : 'reference', includeSubtasks: subtasks, kind: KIND[p.type],
        file: { name: p.file.name, mime, sizeBytes: p.file.size, sha256: hex },
        note: note.trim() || null, newVersionOf: p.match && p.choice === 'version' ? p.match.id : null,
      });
      if (!reserved.ok) { set(p.key, { state: 'error', message: reserved.message }); return null; }
      await putToTicket(reserved.value.uploadUrl, p.file, mime, base64);
      const done = await completeUploadAction(reserved.value.versionRef);
      if (!done.ok) { set(p.key, { state: 'error', message: done.message }); return null; }
      set(p.key, { state: p.type === 'dwg' ? 'preview' : 'ready' });
      return reserved.value.versionRef.split('.')[0];
    } catch {
      set(p.key, { state: 'error', message: 'That file did not upload. Try again.' });
      return null;
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const role = single ? 'deliverable' : 'reference';
      const uploaded: string[] = [];
      const versioned: string[] = [];
      for (const p of picks.filter((x) => !x.refusal && x.state === 'waiting')) {
        const id = await uploadOne(p);
        if (id) { uploaded.push(id); if (p.match && p.choice === 'version') versioned.push(id); }
      }
      // A new version of a file not yet on this task, and project files picked on the right, are LINKED.
      const toLink = [...new Set([...versioned, ...selected])];
      if (toLink.length) {
        const linked = await linkFilesAction(taskId, toLink, role, subtasks);
        if (!linked.ok) { setError(linked.message); return; }
      }
      if (single) {
        const documentId = uploaded[0] ?? [...selected][0];
        if (!documentId) { setError('Pick or upload the file to hand in.'); return; }
        const res = await submitDeliverableAction(deliverable!.id, documentId, note.trim() || null);
        if (!res.ok) { setError(res.message); return; }
      }
      if (uploaded.length || toLink.length) onDone();
    } finally {
      setBusy(false);
    }
  }

  const queued = picks.filter((p) => !p.refusal && p.state === 'waiting').length;
  const total = queued + selected.size;
  const linkedIds = new Set(results.filter((f) => f.usedOn.some((u) => u.taskId === taskId)).map((f) => f.id));

  return (
    <div className="afd-scrim" role="presentation" onClick={onClose}>
      <section role="dialog" aria-modal="true" aria-label={`Add files to ${taskName}`} className="afd" onClick={(e) => e.stopPropagation()}>
        <header className="afd-hd">
          <div>
            <span className="afd-grp">{taskName}</span>
            <h2>{single ? `Hand in “${deliverable!.title}”` : 'Add drawings & model'}</h2>
          </div>
          <button type="button" className="btn sm" aria-label="Close" onClick={onClose}>✕</button>
        </header>
        <div className="afd-body">
          <div className="afd-col">
            <div className={`afd-drop${over ? ' is-over' : ''}`} role="button" tabIndex={0}
              onClick={() => input.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') input.current?.click(); }}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); addPicked(e.dataTransfer.files); }}>
              <b>Drop files or browse</b>
              <span className="tfl-note">.pdf · .dwg · .dxf · .ifc · images — up to 100 MB each. Each file gets its own version history.</span>
              <input ref={input} type="file" hidden multiple={!single} accept={ACCEPTED_FILES}
                onChange={(e) => { addPicked(e.target.files); e.target.value = ''; }} />
            </div>
            {picks.length ? <span className="afd-grp">Uploading · {picks.length}</span> : null}
            {picks.length ? (
              <div className="tfl-card">
                {picks.map((p) => <PickRow key={p.key} pick={p} onChoice={(choice) => set(p.key, { choice })}
                  onDrop={() => setPicks((prev) => prev.filter((x) => x.key !== p.key))} />)}
              </div>
            ) : null}
            {single ? (
              <label className="afd-col" style={{ gap: 4 }}>
                <span className="afd-grp">Note for the reviewer</span>
                <textarea className="tfl-textarea" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)}
                  placeholder="What changed, what to look at." />
              </label>
            ) : (
              <>
                <span className="afd-grp">Where these show</span>
                {hasSubtasks ? (
                  <label className="afd-check"><input type="checkbox" checked={subtasks} onChange={(e) => setSubtasks(e.target.checked)} />
                    Also on its sub-tasks (inherited — remove per sub-task)</label>
                ) : <span className="tfl-note">On {taskName}. Files you add here are project files linked to this task.</span>}
              </>
            )}
          </div>
          <aside className="afd-side" aria-label="Link from the project">
            <span className="afd-grp">Or link from the project · {results.length} files</span>
            <input className="tfl-input" placeholder="Search by sheet number or name" value={q} onChange={(e) => setQ(e.target.value)}
              aria-label="Search project files" />
            <div className="tfl-tools" role="group" aria-label="Filter by type">
              {SEARCH_TYPES.map((t) => (
                <button key={t ?? 'all'} type="button" className={`tfl-tool${type === t ? ' is-on' : ''}`} aria-pressed={type === t}
                  onClick={() => setType(t)}>{t ? FILE_TYPE_TAG[t] : 'All'}</button>
              ))}
            </div>
            <div className="afd-pick">
              {results.map((f) => {
                const linked = !single && linkedIds.has(f.id);
                return (
                  <label key={f.id} className="frow">
                    <input type={single ? 'radio' : 'checkbox'} name="afd-pick" disabled={linked}
                      checked={linked || selected.has(f.id)}
                      onChange={(e) => setSelected((prev) => {
                        const next = new Set(single ? [] : prev);
                        if (e.target.checked) next.add(f.id); else next.delete(f.id);
                        return next;
                      })} />
                    <span><FileTypeTag type={f.fileType} tag={f.tag} /> {f.title}</span>
                    <span className="tfl-note">{linked ? 'linked' : f.versionLabel}</span>
                  </label>
                );
              })}
              {!results.length ? <p className="tfl-note">No project files match.</p> : null}
            </div>
            <p className="tfl-note">Linking doesn&apos;t copy. Every task that uses a file sees its newest version — and when it changes, those tasks&apos; owners get a notification.</p>
          </aside>
        </div>
        {error ? <p role="alert" className="tfl-err" style={{ padding: '0 24px' }}>{error}</p> : null}
        <footer className="afd-ft">
          <span className="tfl-note">{queued} upload{queued === 1 ? '' : 's'} + {selected.size} linked → {taskName}</span>
          <div className="tfl-inline">
            <button type="button" className="btn" onClick={onClose}>{picks.some((p) => p.state === 'ready' || p.state === 'preview') ? 'Close' : 'Cancel'}</button>
            <button type="button" className="btn primary" disabled={busy || total === 0 || (single && total > 1)} onClick={() => void submit()}>
              {busy ? 'Working…' : single ? 'Submit for review' : `Add ${total} file${total === 1 ? '' : 's'}`}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function PickRow({ pick, onChoice, onDrop }: { pick: Pick; onChoice: (c: 'version' | 'separate') => void; onDrop: () => void }) {
  const badge = pick.refusal ? <Badge tone="warn">Can&apos;t add</Badge>
    : pick.state === 'ready' ? <Badge tone="ok">Ready</Badge>
      : pick.state === 'preview' ? <Badge tone="pending">Making preview…</Badge>
        : pick.state === 'uploading' ? <Badge tone="pending">Uploading…</Badge>
          : pick.state === 'error' ? <Badge tone="warn">Failed</Badge>
            : pick.match ? <Badge tone="pending">Your call</Badge> : <Badge tone="neutral">Waiting</Badge>;
  return (
    <div className="frow" style={pick.match && pick.state === 'waiting' ? { alignItems: 'start' } : undefined}>
      <FileTypeTag type={pick.type} tag={FILE_TYPE_TAG[pick.type]} />
      <b>{pick.file.name}</b>
      {badge}
      <span className="meta">
        {pick.refusal ?? pick.message ?? (pick.state === 'preview'
          ? 'Viewable once the preview is made. You can close this — it carries on.' : null)}
        {pick.match && pick.state === 'waiting' && !pick.refusal ? (
          <span className="frow-body">
            <span className="tfl-note">The project already has {pick.match.title} ({pick.match.versionLabel}).</span>
            <label className="afd-check"><input type="radio" checked={pick.choice === 'version'} onChange={() => onChoice('version')} />
              Make it <b>v{pick.match.version + 1}</b> of that file</label>
            <label className="afd-check"><input type="radio" checked={pick.choice === 'separate'} onChange={() => onChoice('separate')} />
              Add as a separate file{pick.type === 'ifc' ? ' (e.g. a structural or MEP model)' : ''}</label>
          </span>
        ) : null}
        {pick.state === 'waiting' ? <>{' '}<button type="button" className="tfl-linkbtn" onClick={onDrop}>Remove</button></> : null}
      </span>
    </div>
  );
}
