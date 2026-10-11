'use client';

// Small shared pieces of the Files surfaces (PRD-05): the type tag, the state
// badge, and one reference-file row. Names come from the screen (the plan's rows
// and parties), never from the wire.
import type { FileView } from '@/lib/v2/task-files-view';
import { usedElsewhere } from '@/lib/v2/task-files-view';
import { isViewable, previewReason } from '@/lib/v2/viewer-view';

export function FileTypeTag({ type, tag }: { type: string; tag: string }) {
  return <i className={`ft is-${type}`}>{tag}</i>;
}

export function Badge({ tone, children }: { tone: 'ok' | 'pending' | 'warn' | 'neutral'; children: React.ReactNode }) {
  return <span className={`tfl-badge${tone === 'neutral' ? '' : ` is-${tone}`}`}>{children}</span>;
}

export function shortDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * The name of a file as the way to open it: PDF / DWG / DXF open the drawing
 * viewer (PRD-06 V-1) when the screen offers it, everything else the download
 * behind the V6 check.
 */
export function FileOpen({ file, onOpen }: { file: FileView; onOpen?: (file: FileView) => void }) {
  if (onOpen && isViewable(file)) {
    return <button type="button" className="frow-name tfl-linkbtn" onClick={() => onOpen(file)}>{file.title}</button>;
  }
  return file.openPath
    ? <a className="frow-name" href={file.openPath} target="_blank" rel="noreferrer">{file.title}</a>
    : <b>{file.title}</b>;
}

/** The preview badge, with the reason a DWG/DXF is download-only (PRD-06 V-14). */
export function PreviewBadge({ file }: { file: FileView }) {
  if (file.preview.tone === 'ok') return <span className="tfl-note">{file.versionLabel}</span>;
  const reason = file.preview.tone === 'warn' ? previewReason(file.previewReason) : null;
  return <span title={reason ?? undefined}><Badge tone={file.preview.tone}>{file.preview.label}</Badge></span>;
}

/**
 * One reference file on a task (F-3): tag · name · version or preview state,
 * meta "v2 · Atelier Sousa · also on 2.5.1". The name opens the drawing viewer
 * for PDF / DWG / DXF (PRD-06), the download otherwise.
 */
export function ReferenceRow({
  file, taskId, taskName, orgName, onUnlink, onOpen,
}: {
  file: FileView;
  taskId: string;
  taskName: (id: string) => string | null;
  orgName: (id: string | null) => string | null;
  onUnlink?: (file: FileView) => void;
  onOpen?: (file: FileView) => void;
}) {
  const elsewhere = usedElsewhere(file, taskId, taskName);
  const meta = [
    file.versionLabel,
    orgName(file.uploaderOrgId),
    file.preview.tone === 'warn' ? previewReason(file.previewReason) : null,
    file.inherited ? 'inherited from the parent task' : null,
    file.attached ? 'attached to this task' : null,
    elsewhere,
  ].filter(Boolean).join(' · ');
  return (
    <div className="frow">
      <FileTypeTag type={file.fileType} tag={file.tag} />
      <FileOpen file={file} onOpen={onOpen} />
      <PreviewBadge file={file} />
      <span className="meta">
        {meta}
        {onUnlink && !file.attached ? (
          <>
            {' · '}
            <button type="button" className="tfl-linkbtn" onClick={() => onUnlink(file)}
              title={file.inherited ? 'Remove from this sub-task only' : 'Remove from this task (the file stays in the project)'}>
              Remove
            </button>
          </>
        ) : null}
      </span>
    </div>
  );
}
