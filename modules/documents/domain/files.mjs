// Task files (PRD-05) — pure: the file-type tag a row shows and filters on,
// the preview state an upload starts in, the link vocabulary, and the version
// metadata a new version may carry. No I/O.

export const FILE_TYPES = Object.freeze(['pdf', 'dwg', 'dxf', 'ifc', 'image', 'other']);
export const PREVIEW_STATUSES = Object.freeze(['ready', 'pending', 'unavailable']);
export const LINK_ROLES = Object.freeze(['reference', 'deliverable']);
export const CHANGE_KINDS = Object.freeze(['upload', 'markup_only', 'edit']);

/** Scopes whose documents every participant reads (V1/V6) — the only linkable ones. */
export const PROJECT_FILE_SCOPES = Object.freeze(['project', 'location', 'task']);

const NOTE_MAX = 2000;
/** Image extensions (shared with the SQL type filter in infra/pg-links.mjs). */
export const IMAGE_EXTENSIONS = Object.freeze(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'tif', 'tiff', 'bmp']);
const IMAGE_EXT = new Set(IMAGE_EXTENSIONS);

function extensionOf(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name ?? '').trim());
  return m ? m[1].toLowerCase() : '';
}

/**
 * The type tag of a file, from its name first (DWG/IFC carry no agreed mime —
 * browsers send application/octet-stream) and its mime second.
 * @returns {'pdf'|'dwg'|'dxf'|'ifc'|'image'|'other'}
 */
export function fileTypeOf(name, mime = '') {
  const ext = extensionOf(name);
  if (ext === 'pdf') return 'pdf';
  if (ext === 'dwg') return 'dwg';
  if (ext === 'dxf') return 'dxf';
  if (ext === 'ifc') return 'ifc';
  if (IMAGE_EXT.has(ext)) return 'image';
  const m = String(mime ?? '').toLowerCase();
  if (m === 'application/pdf') return 'pdf';
  if (m === 'image/vnd.dwg' || m === 'application/acad') return 'dwg';
  if (m === 'image/vnd.dxf' || m === 'application/dxf') return 'dxf';
  if (m === 'model/ifc' || m === 'application/x-step') return 'ifc';
  if (m.startsWith('image/')) return 'image';
  return 'other';
}

/**
 * The preview state a freshly proven version puts its document in (F-7):
 * a DWG waits for the server-side conversion of PRD-06 (D-49); every other
 * type is viewable as-is or simply downloaded.
 */
export function initialPreviewStatus(fileType) {
  return fileType === 'dwg' ? 'pending' : 'ready';
}

/** The kind a task-file upload gets when the client does not say (PRD-05 §5: mime + `drawing`). */
export function defaultKindFor(fileType) {
  if (fileType === 'pdf' || fileType === 'dwg' || fileType === 'dxf') return 'drawing';
  if (fileType === 'ifc') return 'bim';
  if (fileType === 'image') return 'photo';
  return 'other';
}

/**
 * Validate the optional version metadata (note, base_version_no, change_kind).
 * Returns {errors, meta}: errors keyed by field, meta normalised for the store.
 */
export function validateVersionMeta(body) {
  const errors = {};
  const meta = { note: null, baseVersionNo: null, changeKind: 'upload' };
  if (body?.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string' || body.note.trim().length > NOTE_MAX) errors.note = `text up to ${NOTE_MAX} characters`;
    else meta.note = body.note.trim() || null;
  }
  if (body?.base_version_no !== undefined && body.base_version_no !== null) {
    if (!Number.isInteger(body.base_version_no) || body.base_version_no < 1) errors.base_version_no = 'a version number ≥ 1';
    else meta.baseVersionNo = body.base_version_no;
  }
  if (body?.change_kind !== undefined && body.change_kind !== null) {
    if (!CHANGE_KINDS.includes(body.change_kind)) errors.change_kind = `one of ${CHANGE_KINDS.join(', ')}`;
    else meta.changeKind = body.change_kind;
  }
  return { errors, meta };
}

/**
 * The links one "link to task" request writes: the task itself, then — with
 * `includeSubtasks` — every current sub-task as an inherited link. A sub-task
 * that already links the document keeps its own link (the store skips it).
 */
export function linkRows({ taskId, role, includeSubtasks, descendantIds = [] }) {
  const rows = [{ taskId, role, inherited: false, inheritedFromTaskId: null }];
  if (includeSubtasks) {
    for (const id of descendantIds) {
      if (id !== taskId) rows.push({ taskId: id, role, inherited: true, inheritedFromTaskId: taskId });
    }
  }
  return rows;
}

/** Wire `DocumentUse[]` from link rows of one document. */
export function usesBody(links = []) {
  return links.map((l) => ({ task_id: l.task_id, role: l.role, inherited: Boolean(l.inherited) }));
}
