// Pure v2-wire → view transforms for `/projects/{id}/quality` (PRD-12 N-3, N-4;
// flow C15). Who may assign, fix, close or reject a fix is the server's answer
// (`actions` on each non-conformity); this only names things and validates the
// forms before the round trip (the server validates again).

export type NcStatus = 'open' | 'assigned' | 'fixed' | 'rejected_fix' | 'closed';
export type NcAction = 'assign' | 'fix' | 'close' | 'reject_fix';
export type Severity = 'minor' | 'major' | 'critical';

export interface V2NonConformity {
  id: string;
  project_id: string;
  task_id?: string;
  kind: 'quality' | 'safety';
  severity: Severity;
  description: string;
  photo_document_ids: string[];
  raised_by: { person_id?: string; org_id: string };
  assigned_to_org_id?: string;
  status: NcStatus;
  location_id?: string;
  raised_at?: string;
  status_changed_at?: string;
  last_note?: string;
  actions?: NcAction[];
}

export interface V2Inspection {
  id: string;
  kind: 'quality' | 'safety';
  date: string;
  checklist: Array<{ item: string; ok: boolean; note?: string }>;
  findings?: string;
  task_ids: string[];
  location_ids?: string[];
  inspector_org_id?: string;
  recorded_at?: string;
}

export interface V2Verification {
  id: string;
  task_id: string;
  task_name?: string;
  requested_by: { org_id: string };
  criteria?: string;
  status: 'pending' | 'accepted' | 'rejected';
  reason?: string;
}

export type Names = { orgs: Map<string, string>; tasks: Map<string, string>; locations: Map<string, string> };

export const STATUS_LABEL: Record<NcStatus, string> = {
  open: 'Open — not assigned yet',
  assigned: 'Assigned — waiting for the fix',
  fixed: 'Fixed — waiting for the raiser to close it',
  rejected_fix: 'Fix rejected — back with the assignee',
  closed: 'Closed',
};

export const ACTION_LABEL: Record<NcAction, string> = {
  assign: 'Assign',
  fix: 'Mark fixed',
  close: 'Close',
  reject_fix: 'Reject the fix',
};

export const SEVERITIES: Severity[] = ['minor', 'major', 'critical'];

export const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: 'active', label: 'Not closed' },
  { value: 'fixed', label: 'Waiting to close' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

export interface NcCard {
  id: string;
  title: string;
  severity: Severity;
  kindLabel: string;
  statusLabel: string;
  status: NcStatus;
  where: string | null;
  raisedBy: string;
  assignedTo: string | null;
  lastNote: string | null;
  raisedOn: string | null;
  photos: Array<{ documentId: string; href: string }>;
  actions: NcAction[];
}

/** The photo as it was when the issue was raised (its first proven version). */
export function photoHref(documentId: string): string {
  return `/api/v2/document-versions/${encodeURIComponent(`${documentId}.1`)}:download`;
}

export function ncCard(nc: V2NonConformity, names: Names): NcCard {
  const place = [nc.location_id ? names.locations.get(nc.location_id) : null, nc.task_id ? names.tasks.get(nc.task_id) : null]
    .filter(Boolean).join(' · ');
  return {
    id: nc.id,
    title: nc.description,
    severity: nc.severity,
    kindLabel: nc.kind === 'safety' ? 'Safety' : 'Quality',
    statusLabel: STATUS_LABEL[nc.status] ?? nc.status,
    status: nc.status,
    where: place || null,
    raisedBy: names.orgs.get(nc.raised_by.org_id) ?? 'An organisation on this build',
    assignedTo: nc.assigned_to_org_id ? (names.orgs.get(nc.assigned_to_org_id) ?? 'An organisation on this build') : null,
    lastNote: nc.last_note ?? null,
    raisedOn: nc.raised_at ? nc.raised_at.slice(0, 10) : null,
    photos: (nc.photo_document_ids ?? []).map((d) => ({ documentId: d, href: photoHref(d) })),
    actions: nc.actions ?? [],
  };
}

export interface RaiseForm {
  description: string;
  severity: string;
  kind: string;
  taskId: string;
  locationId: string;
  assignedToOrgId: string;
  photoDocumentIds: string[];
}

/** The raise body, or the first thing to fix in the form. */
export function raiseBody(form: RaiseForm, id: string): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  const description = form.description.trim();
  if (!description) return { ok: false, message: 'Say what is wrong.' };
  if (description.length > 4000) return { ok: false, message: 'Keep the description under 4000 characters.' };
  if (!SEVERITIES.includes(form.severity as Severity)) return { ok: false, message: 'Pick a severity.' };
  return {
    ok: true,
    body: {
      id,
      description,
      severity: form.severity,
      kind: form.kind === 'safety' ? 'safety' : 'quality',
      ...(form.taskId ? { task_id: form.taskId } : {}),
      ...(form.locationId ? { location_id: form.locationId } : {}),
      ...(form.assignedToOrgId ? { assigned_to_org_id: form.assignedToOrgId } : {}),
      ...(form.photoDocumentIds.length ? { photo_document_ids: form.photoDocumentIds } : {}),
    },
  };
}

/** One line per checklist item; a leading "x" / "✗" / "no:" marks it not ok. */
export function parseChecklist(text: string): Array<{ item: string; ok: boolean }> {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const m = /^(?:x|✗|no:)\s*(.+)$/i.exec(line);
    const okMark = /^(?:✓|ok:)\s*(.+)$/i.exec(line);
    if (m) return { item: m[1].trim(), ok: false };
    return { item: (okMark ? okMark[1] : line).trim(), ok: true };
  });
}

export interface InspectionRow {
  id: string;
  date: string;
  kindLabel: string;
  inspector: string;
  passed: number;
  failed: number;
  failedItems: string[];
  findings: string | null;
  where: string[];
}

export function inspectionRow(i: V2Inspection, names: Names): InspectionRow {
  const failed = i.checklist.filter((c) => !c.ok);
  return {
    id: i.id,
    date: i.date,
    kindLabel: i.kind === 'safety' ? 'Safety' : 'Quality',
    inspector: i.inspector_org_id ? (names.orgs.get(i.inspector_org_id) ?? 'An organisation on this build') : 'Inspector',
    passed: i.checklist.length - failed.length,
    failed: failed.length,
    failedItems: failed.map((c) => c.item),
    findings: i.findings ?? null,
    where: [
      ...(i.location_ids ?? []).map((l) => names.locations.get(l) ?? 'a location'),
      ...i.task_ids.map((t) => names.tasks.get(t) ?? 'a task'),
    ],
  };
}
