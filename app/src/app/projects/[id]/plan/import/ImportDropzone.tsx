'use client';

// Screen 8 — the FileDropzone (PRD-09 O-6, O-10): drag an .xlsx or tap to
// browse; anything else is refused inline before it leaves the browser (the
// server refuses it again). The template link sits right here for a GC
// starting from scratch.
import { useActionState, useRef, useState } from 'react';

import { uploadPlanAction, type ImportActionState } from './actions';

const MAX = 10 * 1024 * 1024;

export function ImportDropzone({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState<ImportActionState, FormData>(uploadPlanAction, {});
  const [over, setOver] = useState(false);
  const [picked, setPicked] = useState<{ name: string; size: number } | null>(null);
  const [local, setLocal] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const accept = (file: File | undefined | null) => {
    setLocal(null);
    setPicked(null);
    if (!file) return false;
    if (!/\.xlsx$/i.test(file.name)) { setLocal(`“${file.name}” is not an .xlsx workbook. In Excel, “Save as” → “Excel Workbook (.xlsx)”.`); return false; }
    if (file.size > MAX) { setLocal('The file is larger than 10 MB.'); return false; }
    setPicked({ name: file.name, size: file.size });
    return true;
  };

  return (
    <form action={action} className="bh-sec">
      <input type="hidden" name="projectId" value={projectId} />
      <label
        className={`imp-drop${over ? ' is-over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const file = e.dataTransfer.files?.[0];
          if (accept(file) && input.current) {
            const dt = new DataTransfer();
            dt.items.add(file);
            input.current.files = dt.files;
          }
        }}
      >
        <strong>Drop your .xlsx here</strong>
        <span className="bh-note">or tap to browse — max 10 MB</span>
        <input
          ref={input}
          type="file"
          name="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => { if (!accept(e.target.files?.[0])) e.target.value = ''; }}
          style={{ maxWidth: '100%' }}
        />
      </label>
      {picked && <p className="bh-note">{picked.name} · {Math.max(1, Math.round(picked.size / 1024))} KB</p>}
      {(local || state.error) && <p role="alert" className="imp-warn">{local ?? state.error}</p>}
      <div className="imp-foot">
        <a className="bh-link" href="/plan-template.xlsx" download>Download the LinkNMS plan template (.xlsx)</a>
        <button type="submit" className="btn primary" disabled={!picked || pending} aria-busy={pending}>
          {pending ? 'Reading the file…' : 'Map columns →'}
        </button>
      </div>
    </form>
  );
}
