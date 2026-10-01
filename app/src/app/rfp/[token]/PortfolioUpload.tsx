'use client';

// The portfolio-image tray on the public RFP form (LINA-375; BE LINA-370). A
// tokened bidder attaches site photos / a method-statement PDF here; each file
// rides the reserve → PUT → complete protocol and only a proven `stored` id is
// handed up to the submit as `document_ids`.
//
// ── BUNDLE DISCIPLINE ─────────────────────────────────────────────────────────
// This is a client island. It imports the PURE view module (constants + the
// pre-flight file guard) and the client-only R2 helpers (`upload-client.ts`) —
// never the `server-only` I/O twin. The two JSON steps (reserve, complete) cross
// to the server through the actions in `actions.ts`; the one browser→R2 step
// (the presigned PUT of the raw bytes) runs here, so the file never passes
// through our server.
//
// ── WHY THE PARENT HOLDS NOTHING BUT THE IDS ──────────────────────────────────
// All the per-file machinery — hashing, the three-step upload, previews, errors —
// lives here. The form only needs the list of proven ids and whether an upload
// is still in flight (to hold the submit), so that is all this reports upward.
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  completeDocumentAction,
  reserveDocumentAction,
} from './actions';
import {
  ALLOWED_ATTACHMENT_MIME,
  MAX_PROPOSAL_ATTACHMENTS,
  validateAttachmentFile,
} from '@/lib/v2/rfp-link-view';
import { digestSha256, putToTicket } from '@/lib/v2/upload-client';

type ItemStatus = 'uploading' | 'stored' | 'error';

/** One file in the tray, across its upload lifecycle. */
interface Item {
  key: string;
  name: string;
  size: number;
  mime: string;
  /** An object URL for an image preview; absent for a PDF or a rejected file. */
  previewUrl?: string;
  status: ItemStatus;
  documentId?: string;
  error?: string;
}

const ACCEPT = ALLOWED_ATTACHMENT_MIME.join(',');

export function PortfolioUpload({
  token,
  onChange,
  onBusyChange,
  disabled = false,
}: {
  token: string;
  /** Called with the proven `stored` ids whenever the tray changes. */
  onChange: (documentIds: string[]) => void;
  /** Called when an upload starts or settles, so the form can hold its submit. */
  onBusyChange: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // A client-unique key per tile without reaching for Date/Math at module load.
  const seq = useRef(0);

  // Report the two things the form actually needs: the proven ids and whether an
  // upload is still running. Derived from `items` so the parent never drifts.
  useEffect(() => {
    onChange(items.filter((i) => i.status === 'stored' && i.documentId).map((i) => i.documentId!));
    onBusyChange(items.some((i) => i.status === 'uploading'));
  }, [items, onChange, onBusyChange]);

  // Revoke any object URLs on unmount — the previews are the only thing that
  // leaks if we don't.
  useEffect(
    () => () => {
      setItems((prev) => {
        prev.forEach((i) => i.previewUrl && URL.revokeObjectURL(i.previewUrl));
        return prev;
      });
    },
    [],
  );

  const patch = useCallback((key: string, next: Partial<Item>) => {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...next } : i)));
  }, []);

  /** Drive one file through reserve → PUT → complete, patching the tile as it goes. */
  const upload = useCallback(
    async (key: string, file: File, mime: string) => {
      try {
        const { hex, base64 } = await digestSha256(file);
        const reserved = await reserveDocumentAction(token, {
          name: file.name, mime, sizeBytes: file.size, sha256: hex,
        });
        if ('error' in reserved) {
          patch(key, { status: 'error', error: reserved.error });
          return;
        }
        await putToTicket(reserved.ticket.uploadUrl, file, mime, base64);
        const done = await completeDocumentAction(token, reserved.ticket.documentId);
        if (done.error) {
          patch(key, { status: 'error', error: done.error });
          return;
        }
        patch(key, { status: 'stored', documentId: reserved.ticket.documentId });
      } catch (e) {
        patch(key, {
          status: 'error',
          error: e instanceof Error ? e.message : 'That file did not upload. Try again.',
        });
      }
    },
    [token, patch],
  );

  const onPick = useCallback(
    (fileList: FileList | null) => {
      setNotice(null);
      if (!fileList || fileList.length === 0) return;
      const picked = Array.from(fileList);

      // The count cap is the server's; mirror it here so an over-pick is refused
      // without a wasted reserve. Count only what is still live (not a prior error).
      const liveCount = items.filter((i) => i.status !== 'error').length;
      const room = MAX_PROPOSAL_ATTACHMENTS - liveCount;
      if (room <= 0) {
        setNotice(`You can attach up to ${MAX_PROPOSAL_ATTACHMENTS} files.`);
        return;
      }
      const accepted = picked.slice(0, room);
      if (picked.length > room) {
        setNotice(`You can attach up to ${MAX_PROPOSAL_ATTACHMENTS} files; the extra were not added.`);
      }

      const fresh: Item[] = [];
      for (const file of accepted) {
        const key = `f${seq.current++}`;
        const mime = file.type;
        const bad = validateAttachmentFile({ type: mime, size: file.size });
        if (bad) {
          fresh.push({ key, name: file.name, size: file.size, mime, status: 'error', error: bad });
          continue;
        }
        const previewUrl = mime.startsWith('image/') ? URL.createObjectURL(file) : undefined;
        fresh.push({ key, name: file.name, size: file.size, mime, previewUrl, status: 'uploading' });
        void upload(key, file, mime);
      }
      setItems((prev) => [...prev, ...fresh]);
    },
    [items, upload],
  );

  const remove = useCallback((key: string) => {
    setItems((prev) => {
      const gone = prev.find((i) => i.key === key);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((i) => i.key !== key);
    });
  }, []);

  const liveCount = items.filter((i) => i.status !== 'error').length;
  const full = liveCount >= MAX_PROPOSAL_ATTACHMENTS;

  return (
    <div className="field">
      <label id="portfolio-label">Portfolio (optional)</label>
      <p className="hint">
        Add photos of comparable work, or a short PDF. Up to {MAX_PROPOSAL_ATTACHMENTS} files,
        15 MB each.
      </p>

      <div className="rfp-tray" aria-labelledby="portfolio-label">
        {items.map((item) => (
          <Thumb key={item.key} item={item} onRemove={() => remove(item.key)} />
        ))}

        {!full ? (
          <label className="rfp-add" data-busy={disabled ? 'true' : undefined} data-full={undefined}>
            <PlusGlyph />
            <span>Add files</span>
            <input
              type="file"
              multiple
              accept={ACCEPT}
              disabled={disabled}
              onChange={(e) => {
                onPick(e.target.files);
                // Reset so re-picking the same file fires onChange again.
                e.target.value = '';
              }}
            />
          </label>
        ) : null}
      </div>

      {notice ? <p className="rfp-fieldnote" role="status"><InfoGlyph /><span>{notice}</span></p> : null}
    </div>
  );
}

/** One tile: an image preview or a document face, a status overlay, a remove button. */
function Thumb({ item, onRemove }: { item: Item; onRemove: () => void }) {
  const isImage = item.previewUrl && item.status !== 'error';
  return (
    <div className="rfp-thumb" data-status={item.status} title={item.error ?? item.name}>
      {isImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- a local object URL, not a remote asset
        <img src={item.previewUrl} alt={item.name} />
      ) : (
        <span className="rfp-thumb-face">
          {item.status === 'error' ? <WarnGlyph /> : <DocGlyph />}
          <span className="rfp-thumb-name">{item.name}</span>
        </span>
      )}

      {item.status === 'uploading' ? (
        <span className="rfp-thumb-veil" aria-label="Uploading">
          <Spinner />
        </span>
      ) : null}

      <button type="button" onClick={onRemove} aria-label={`Remove ${item.name}`}>
        <CloseGlyph />
      </button>
    </div>
  );
}

function PlusGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  );
}

function DocGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 3h7l4 4v14H7z" strokeLinejoin="round" />
      <path d="M14 3v4h4" strokeLinejoin="round" />
    </svg>
  );
}

function WarnGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4l9 16H3z" strokeLinejoin="round" />
      <path d="M12 10v4M12 17v.5" strokeLinecap="round" />
    </svg>
  );
}

function InfoGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 7.6v.4" strokeLinecap="round" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="rfp-spin" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" strokeLinecap="round" />
    </svg>
  );
}
