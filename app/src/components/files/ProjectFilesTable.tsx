'use client';

// The table of `/projects/{id}/documents` (PRD-05 F-19) with the drawing viewer
// behind every PDF / DWG / DXF name (PRD-06 V-1): the rail lists the files of
// this page. The page reads the files, deliverables and task names on the
// server; this only renders them and owns the viewer's open/closed state.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { DELIVERABLE_STATE, type FileView, type DeliverableStatus } from '@/lib/v2/task-files-view';
import { FileViewer } from '@/components/viewer/FileViewer';
import { FileOpen, FileTypeTag, PreviewBadge, Badge } from './FileBits';

export function ProjectFilesTable({
  projectId, files, taskNames, deliverableStates,
}: {
  projectId: string;
  files: FileView[];
  taskNames: Record<string, string>;
  deliverableStates: Record<string, DeliverableStatus>;
}) {
  const router = useRouter();
  const [viewing, setViewing] = useState<string | null>(null);

  return (
    <>
      <table className="pfl-table">
        <thead>
          <tr><th>Type</th><th>Name</th><th>Version</th><th>Used on</th><th>Deliverable</th><th>Preview</th></tr>
        </thead>
        <tbody>
          {files.map((f) => {
            const state = deliverableStates[f.id];
            return (
              <tr key={f.id}>
                <td><FileTypeTag type={f.fileType} tag={f.tag} /></td>
                <td><FileOpen file={f} onOpen={(file) => setViewing(file.id)} /></td>
                <td>{f.versionLabel}</td>
                <td>
                  {f.usedOn.length ? f.usedOn.map((u) => (
                    <Link key={u.taskId} href={`/projects/${projectId}/plan?task=${encodeURIComponent(u.taskId)}&tab=files`} style={{ display: 'block' }}>
                      {taskNames[u.taskId] ?? 'A task'}{u.role === 'deliverable' ? ' · deliverable' : ''}{u.inherited ? ' · inherited' : ''}
                    </Link>
                  )) : <span className="tfl-note">Project file</span>}
                </td>
                <td>{state ? <Badge tone={DELIVERABLE_STATE[state].tone}>{DELIVERABLE_STATE[state].label}</Badge> : <span className="tfl-note">—</span>}</td>
                <td>{f.preview.tone === 'ok' ? <span className="tfl-note">{f.preview.label}</span> : <PreviewBadge file={f} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {viewing ? (
        <FileViewer
          projectId={projectId} taskId={null} label="Files of this build" files={files} initialFileId={viewing}
          onClose={() => setViewing(null)} onChanged={() => router.refresh()}
        />
      ) : null}
    </>
  );
}
