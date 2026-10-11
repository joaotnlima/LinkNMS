'use client';

// "Upload revised PDF / .dwg" (PRD-06 V-10): a changed drawing is a new upload
// by its author — the next version of the same project file, through the same
// reserve → PUT → complete protocol as the Files tab (PRD-05 F-8). Only editors
// of the file may (the server answers 403 otherwise). Markups drawn on earlier
// bytes stay on the record and show as "drawn on vN" on the revision.
import { useRef, useState } from 'react';

import { completeUploadAction, reserveTaskUploadAction } from '@/lib/v2/task-files-actions';
import { fileTypeOfName, uploadRefusal, type FileView } from '@/lib/v2/task-files-view';
import { digestSha256, putToTicket } from '@/lib/v2/upload-client';

export function RevisedUpload({
  projectId, file, label, onUploaded, onError,
}: {
  projectId: string;
  file: FileView;
  label: string;
  onUploaded: () => void;
  onError: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const accept = file.fileType === 'pdf' ? '.pdf,application/pdf' : file.fileType === 'dxf' ? '.dxf' : '.dwg';

  async function upload(picked: File) {
    const refusal = uploadRefusal(picked);
    if (refusal) { onError(refusal); return; }
    const type = fileTypeOfName(picked.name, picked.type);
    if (type !== file.fileType) { onError(`A revision of ${file.title} is a ${file.tag} file too.`); return; }
    setBusy(true);
    const mime = picked.type || 'application/octet-stream';
    try {
      const { hex, base64 } = await digestSha256(picked);
      const reserved = await reserveTaskUploadAction({
        projectId, taskId: '', role: 'reference', includeSubtasks: false, kind: 'drawing',
        file: { name: picked.name, mime, sizeBytes: picked.size, sha256: hex }, note: null, newVersionOf: file.id,
      });
      if (!reserved.ok) { onError(reserved.message); return; }
      await putToTicket(reserved.value.uploadUrl, picked, mime, base64);
      const done = await completeUploadAction(reserved.value.versionRef);
      if (!done.ok) { onError(done.message); return; }
      onUploaded();
    } catch {
      onError('That file did not upload. Try again.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <>
      <input ref={input} type="file" accept={accept} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
      <button type="button" className="btn" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? 'Uploading…' : label}
      </button>
    </>
  );
}
