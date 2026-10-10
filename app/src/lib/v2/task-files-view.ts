// Pure v2-wire → view transforms for task files, project files and deliverables
// (PRD-05). Split from `task-files.ts` (the I/O, `server-only`) so the mapping is
// unit-testable without a session. Nothing here decides who may do what: the
// server answers `can_edit` / `can_submit` / `can_decide` / `done_blocked`, this
// only arranges what came back for the screen.

import { taskDocumentDownloadPath, versionRefOf } from './task-workspace-view.ts';

// ── wire (subset, restated — a drift lands as a type error) ────────────────────

export type FileType = 'pdf' | 'dwg' | 'dxf' | 'ifc' | 'image' | 'other';
export type PreviewStatus = 'ready' | 'pending' | 'unavailable';
export type LinkRole = 'reference' | 'deliverable';
export type DeliverableStatus = 'not_yet' | 'submitted' | 'changes_requested' | 'approved';

export interface V2Actor { person_id: string; org_id: string }

export interface V2FileVersion {
  version_no: number;
  mime: string;
  size_bytes: number;
  sha256: string;
  uploaded_by: V2Actor;
  uploaded_at: string;
  note?: string;
  change_kind?: string;
}

export interface V2DocumentUse { task_id: string; role: LinkRole; inherited: boolean }

export interface V2FileDocument {
  id: string;
  project_id: string | null;
  scope_type: string;
  scope_id: string;
  kind: string;
  title: string;
  file_type: FileType;
  preview_status: PreviewStatus;
  current_version: number;
  versions: V2FileVersion[];
  used_on?: V2DocumentUse[];
  role?: LinkRole;
  inherited?: boolean;
  inherited_from_task_id?: string;
  attached?: boolean;
}

export interface V2Submission {
  id: string;
  seq: number;
  document_id: string;
  version_no: number;
  sha256: string;
  file_title: string;
  mime: string;
  note?: string;
  submitted_by: V2Actor;
  submitted_at: string;
  status: 'submitted' | 'approved' | 'changes_requested' | 'superseded';
  decision?: { by: V2Actor; at: string; comment?: string };
}

export interface V2Deliverable {
  id: string;
  project_id: string;
  task_id: string;
  title: string;
  required: boolean;
  due: string | null;
  source_rfp_id: string | null;
  status: DeliverableStatus;
  current?: V2Submission;
  history: V2Submission[];
  can_decide?: boolean;
}

export interface V2TaskDeliverables {
  task_id: string;
  required_count: number;
  approved_count: number;
  done_blocked: boolean;
  to_review_count: number;
  can_edit: boolean;
  can_submit: boolean;
  can_review: boolean;
  items: V2Deliverable[];
}

// ── views ─────────────────────────────────────────────────────────────────────

export const FILE_TYPE_TAG: Record<FileType, string> = {
  pdf: 'PDF', dwg: 'DWG', dxf: 'DXF', ifc: 'IFC', image: 'IMG', other: 'FILE',
};

export interface PreviewView { label: string; tone: 'ok' | 'pending' | 'warn' }

/** F-7 per-upload state, as the board words it. */
export function previewOf(status: PreviewStatus): PreviewView {
  if (status === 'pending') return { label: 'Making preview…', tone: 'pending' };
  if (status === 'unavailable') return { label: 'No preview, download only', tone: 'warn' };
  return { label: 'Ready', tone: 'ok' };
}

export interface FileUseView { taskId: string; role: LinkRole; inherited: boolean }

export interface FileView {
  id: string;
  title: string;
  fileType: FileType;
  tag: string;
  preview: PreviewView;
  version: number;
  versionLabel: string;
  latestNote: string | null;
  uploadedAt: string | null;
  uploaderOrgId: string | null;
  downloadPath: string | null;
  /** PRD-06 renders PDFs and DWGs in place; until then a row opens the download. */
  openPath: string | null;
  role: LinkRole;
  inherited: boolean;
  attached: boolean;
  usedOn: FileUseView[];
}

export function toFileView(d: V2FileDocument): FileView {
  const latest = d.versions[d.versions.length - 1] ?? null;
  const download = latest ? taskDocumentDownloadPath(versionRefOf(d.id, latest.version_no)) : null;
  return {
    id: d.id,
    title: d.title,
    fileType: d.file_type,
    tag: FILE_TYPE_TAG[d.file_type] ?? 'FILE',
    preview: previewOf(d.preview_status),
    version: d.current_version,
    versionLabel: `v${d.current_version}`,
    latestNote: latest?.note ?? null,
    uploadedAt: latest?.uploaded_at ?? null,
    uploaderOrgId: latest?.uploaded_by.org_id ?? null,
    downloadPath: download,
    openPath: download,
    role: d.role ?? 'reference',
    inherited: d.inherited === true,
    attached: d.attached === true,
    usedOn: (d.used_on ?? []).map((u) => ({ taskId: u.task_id, role: u.role, inherited: u.inherited })),
  };
}

/** "also on 2.5.1, 2.5.2" / "deliverable of 1.4" — the other tasks using a file (F-3). */
export function usedElsewhere(file: FileView, taskId: string, nameOf: (id: string) => string | null): string | null {
  const others = file.usedOn.filter((u) => u.taskId !== taskId);
  if (!others.length) return null;
  const deliverableOf = others.filter((u) => u.role === 'deliverable').map((u) => nameOf(u.taskId) ?? 'another task');
  const alsoOn = others.filter((u) => u.role !== 'deliverable').map((u) => nameOf(u.taskId) ?? 'another task');
  const parts: string[] = [];
  if (deliverableOf.length) parts.push(`deliverable of ${deliverableOf.join(', ')}`);
  if (alsoOn.length) parts.push(`also on ${alsoOn.join(', ')}`);
  return parts.join(' · ');
}

export type ReferenceFilter = 'all' | 'pdf' | 'dwg' | 'ifc' | 'image';

/** The Reference section: reference links + files attached to the task, filtered by type. */
export function referenceFiles(files: FileView[], filter: ReferenceFilter = 'all'): FileView[] {
  const refs = files.filter((f) => f.role === 'reference');
  if (filter === 'all') return refs;
  if (filter === 'dwg') return refs.filter((f) => f.fileType === 'dwg' || f.fileType === 'dxf');
  return refs.filter((f) => f.fileType === filter);
}

export function filterCounts(files: FileView[]): Record<ReferenceFilter, number> {
  return {
    all: referenceFiles(files, 'all').length,
    pdf: referenceFiles(files, 'pdf').length,
    dwg: referenceFiles(files, 'dwg').length,
    ifc: referenceFiles(files, 'ifc').length,
    image: referenceFiles(files, 'image').length,
  };
}

export const DELIVERABLE_STATE: Record<DeliverableStatus, { label: string; tone: 'neutral' | 'pending' | 'warn' | 'ok' }> = {
  not_yet: { label: 'Not yet', tone: 'neutral' },
  submitted: { label: 'Submitted · review', tone: 'pending' },
  changes_requested: { label: 'Changes requested', tone: 'warn' },
  approved: { label: '✓ Approved', tone: 'ok' },
};

export interface SubmissionView {
  id: string;
  documentId: string;
  versionNo: number;
  versionLabel: string;
  fileTitle: string;
  fileType: FileType;
  tag: string;
  sha256: string;
  note: string | null;
  submittedAt: string;
  submitterOrgId: string;
  status: V2Submission['status'];
  decidedAt: string | null;
  deciderOrgId: string | null;
  decisionComment: string | null;
  downloadPath: string;
}

export interface DeliverableView {
  id: string;
  title: string;
  required: boolean;
  due: string | null;
  fromRfp: boolean;
  status: DeliverableStatus;
  stateLabel: string;
  tone: 'neutral' | 'pending' | 'warn' | 'ok';
  current: SubmissionView | null;
  earlier: SubmissionView[];
  canDecide: boolean;
}

function toSubmissionView(s: V2Submission): SubmissionView {
  return {
    id: s.id,
    documentId: s.document_id,
    versionNo: s.version_no,
    versionLabel: `v${s.version_no}`,
    fileTitle: s.file_title,
    fileType: fileTypeOfName(s.file_title, s.mime),
    tag: FILE_TYPE_TAG[fileTypeOfName(s.file_title, s.mime)],
    sha256: s.sha256,
    note: s.note ?? null,
    submittedAt: s.submitted_at,
    submitterOrgId: s.submitted_by.org_id,
    status: s.status,
    decidedAt: s.decision?.at ?? null,
    deciderOrgId: s.decision?.by.org_id ?? null,
    decisionComment: s.decision?.comment ?? null,
    downloadPath: taskDocumentDownloadPath(versionRefOf(s.document_id, s.version_no)),
  };
}

export function toDeliverableView(d: V2Deliverable): DeliverableView {
  const state = DELIVERABLE_STATE[d.status];
  const current = d.current ? toSubmissionView(d.current) : null;
  return {
    id: d.id,
    title: d.title,
    required: d.required,
    due: d.due,
    fromRfp: Boolean(d.source_rfp_id),
    status: d.status,
    stateLabel: current && d.status === 'submitted' ? `${current.versionLabel} submitted · review` : state.label,
    tone: state.tone,
    current,
    earlier: d.history.filter((h) => h.id !== d.current?.id).map(toSubmissionView),
    canDecide: d.can_decide === true,
  };
}

export interface DeliverablesView {
  requiredCount: number;
  approvedCount: number;
  doneBlocked: boolean;
  toReview: number;
  canEdit: boolean;
  canSubmit: boolean;
  items: DeliverableView[];
  /** "3 of 5 approved" — null when nothing is required. */
  progressLabel: string | null;
  progressPct: number;
}

export function toDeliverablesView(t: V2TaskDeliverables): DeliverablesView {
  return {
    requiredCount: t.required_count,
    approvedCount: t.approved_count,
    doneBlocked: t.done_blocked,
    toReview: t.to_review_count,
    canEdit: t.can_edit,
    canSubmit: t.can_submit,
    items: t.items.map(toDeliverableView),
    progressLabel: t.required_count ? `${t.approved_count} of ${t.required_count} approved` : null,
    progressPct: t.required_count ? Math.round((t.approved_count / t.required_count) * 100) : 0,
  };
}

/** The Files tab in one read (`task-files.ts` fetchTaskFiles). */
export interface TaskFilesView {
  taskId: string;
  files: FileView[];
  deliverables: DeliverablesView;
}

/** F-1: the Files tab label — `n to review` when deliverables wait on the viewer, else the file count. */
export function filesTabLabel(fileCount: number | null, toReview: number): string | null {
  if (toReview > 0) return `${toReview} to review`;
  return fileCount == null ? null : String(fileCount);
}

// ── add files (F-6, F-8) ─────────────────────────────────────────────────────

/** D-49: one cap for every kind; the server enforces it, this saves a wasted upload. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const ACCEPTED_FILES = '.pdf,.dwg,.dxf,.ifc,image/*';

export function fileTypeOfName(name: string, mime = ''): FileType {
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim())?.[1]?.toLowerCase() ?? '';
  if (ext === 'pdf' || ext === 'dwg' || ext === 'dxf' || ext === 'ifc') return ext;
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'tif', 'tiff', 'bmp'].includes(ext)) return 'image';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  return 'other';
}

/** Why a picked file cannot go up, or null — mirrors the server's 422s for a quick answer. */
export function uploadRefusal(file: { name: string; size: number; type?: string }): string | null {
  if (file.size > MAX_UPLOAD_BYTES) return `${file.name} is larger than 100 MB.`;
  if (file.size <= 0) return `${file.name} is empty.`;
  if (fileTypeOfName(file.name, file.type ?? '') === 'other') return `${file.name}: only PDF, DWG, DXF, IFC and images.`;
  return null;
}

function stem(name: string): string {
  return name.trim().toLowerCase().replace(/\.[a-z0-9]{1,8}$/, '').replace(/[\s_-]+/g, ' ');
}

/**
 * F-8: an existing project file this upload may be a new version of — same name
 * stem and same type. The person decides; this only offers.
 */
export function matchingFile(files: FileView[], fileName: string): FileView | null {
  const s = stem(fileName);
  const type = fileTypeOfName(fileName);
  return files.find((f) => stem(f.title) === s && f.fileType === type) ?? null;
}

export const PROJECT_FILE_FILTERS: Array<{ key: FileType | 'all'; label: string }> = [
  { key: 'all', label: 'All' }, { key: 'pdf', label: 'PDF' }, { key: 'dwg', label: 'DWG' },
  { key: 'dxf', label: 'DXF' }, { key: 'ifc', label: 'IFC' }, { key: 'image', label: 'Images' },
];

/** F-19: the latest deliverable state of each document, from the project's deliverables. */
export function deliverableStateByDocument(items: V2Deliverable[]): Map<string, DeliverableStatus> {
  const out = new Map<string, DeliverableStatus>();
  for (const d of items) {
    if (d.current) out.set(d.current.document_id, d.status);
  }
  return out;
}
