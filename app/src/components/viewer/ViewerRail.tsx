'use client';

// The viewer's left rail (PRD-06 V-1): the files around the open one grouped by
// type — switching between them never closes the viewer — then the sheets of a
// PDF or the layouts of a DWG. Files the viewer cannot render (models, photos)
// open their download instead.
import { previewReason, railGroups, isViewable } from '@/lib/v2/viewer-view';
import type { FileView } from '@/lib/v2/task-files-view';

export function ViewerRail({
  label, files, activeId, sheets, page, sheetCounts, onOpen, onPage,
}: {
  label: string;
  files: FileView[];
  activeId: string;
  /** Pages ("1", "2"…) of a PDF or layout names of a DWG. */
  sheets: Array<{ key: string; label: string }>;
  page: string;
  /** Markups per sheet key (the tile says how many). */
  sheetCounts: Map<string, number>;
  onOpen: (file: FileView) => void;
  onPage: (key: string) => void;
}) {
  const active = files.find((f) => f.id === activeId);
  return (
    <aside className="vw-side" aria-label="Files and sheets">
      <div className="vw-fgrp">{label} · {files.length}</div>
      {railGroups(files).map((g) => (
        <div key={g.key}>
          {railGroups(files).length > 1 ? <div className="vw-fsub">{g.label}</div> : null}
          {g.files.map((f) => {
            const reason = f.preview.tone === 'warn' ? previewReason(f.previewReason) : null;
            const body = (
              <>
                <i className={`ft is-${f.fileType}`}>{f.tag}</i>
                {f.id === activeId ? <b>{f.title}</b> : <span>{f.title}</span>}
                <span className="vw-note">{f.preview.tone === 'warn' ? '⚠' : f.versionLabel}</span>
                {f.preview.tone !== 'ok' ? (
                  <span className={`vw-frow-meta${f.preview.tone === 'warn' ? ' is-warn' : ''}`}>
                    {f.preview.label}{reason ? ` — ${reason}` : ''}
                  </span>
                ) : null}
              </>
            );
            return isViewable(f) ? (
              <button key={f.id} type="button" className={`vw-frow${f.id === activeId ? ' is-on' : ''}`}
                aria-current={f.id === activeId ? 'true' : undefined} onClick={() => onOpen(f)}>{body}</button>
            ) : (
              <a key={f.id} className="vw-frow" href={f.downloadPath ?? undefined} target="_blank" rel="noreferrer"
                title="Opens the download — this viewer shows PDF and DWG/DXF drawings">{body}</a>
            );
          })}
        </div>
      ))}
      {active && sheets.length ? (
        <>
          <div className="vw-fgrp">{active.fileType === 'pdf' ? 'Sheets in this PDF' : 'Layouts'}</div>
          <div className="vw-sheets">
            {sheets.map((s) => (
              <button key={s.key} type="button" className={`vw-pthumb${s.key === page ? ' is-on' : ''}`}
                aria-pressed={s.key === page} onClick={() => onPage(s.key)}>
                {s.label}
                {sheetCounts.get(s.key) ? <span className="vw-note"> · {sheetCounts.get(s.key)} markup{sheetCounts.get(s.key) === 1 ? '' : 's'}</span> : null}
              </button>
            ))}
          </div>
          <p className="vw-note">Markups are pinned to a {active.fileType === 'pdf' ? 'page' : 'layout'}, not to the file.</p>
        </>
      ) : null}
    </aside>
  );
}
