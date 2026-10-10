// Project files — `/projects/{id}/documents` (PRD-05 F-19, to-be/20). Every file
// of the build the viewer can read, with its type, version, the tasks that use it
// and its deliverable state; search by name and filter by type. The design is not
// drawn yet, so this is the plain, honest table the board's row anatomy implies.
//
// Three module reads in one round (no N+1): the files (Documents), the
// deliverables (Planning) and the schedule (task names). A viewer who is not on
// the build gets the sentence, never a crash. Rows open the file (PRD-06 renders
// PDF/DWG in place later; until then the download behind the V6 check).
import { redirect } from 'next/navigation';
import Link from 'next/link';

import { isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContextV2 } from '@/lib/v2/shell';
import { getRecordV2 } from '@/lib/v2/record';
import { getPlanGrid } from '@/lib/v2/planning';
import { collectRowOptions } from '@/lib/v2/planning-view';
import { fetchProjectFiles, fetchProjectDeliverables } from '@/lib/v2/task-files';
import {
  DELIVERABLE_STATE, PROJECT_FILE_FILTERS, deliverableStateByDocument,
  type FileType, type FileView, type V2Deliverable,
} from '@/lib/v2/task-files-view';
import { FileTypeTag, Badge } from '@/components/files/FileBits';
import '@/components/files/files.css';

export const dynamic = 'force-dynamic';

const TYPES = new Set(['pdf', 'dwg', 'dxf', 'ifc', 'image', 'other']);

export default async function ProjectDocumentsPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; type?: string; cursor?: string }>;
}) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/documents`);
  const sp = await searchParams;
  const q = (sp.q ?? '').slice(0, 200);
  const type = sp.type && TYPES.has(sp.type) ? (sp.type as FileType) : null;

  let files: FileView[] = [];
  let nextCursor: string | null = null;
  let deliverables: V2Deliverable[] = [];
  let error: string | null = null;
  const [record, grid] = await Promise.all([getRecordV2(id), getPlanGrid(id)]);
  try {
    const [page, dels] = await Promise.all([
      fetchProjectFiles(id, { q, type, cursor: sp.cursor ?? null, limit: 100 }),
      fetchProjectDeliverables(id),
    ]);
    files = page.files;
    nextCursor = page.nextCursor;
    deliverables = dels;
  } catch (err) {
    error = err instanceof Error ? err.message : 'The files of this build could not be loaded.';
  }
  const name = record?.name ?? 'This build';
  const shell = await buildShellContextV2(id, name);
  const taskName = new Map(collectRowOptions(grid.rows).map((t) => [t.id, t.name]));
  const stateOf = deliverableStateByDocument(deliverables);
  const href = (over: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const merged = { q: q || null, type, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return `/projects/${id}/documents${s ? `?${s}` : ''}`;
  };

  return (
    <PortalShell user={shell.user} builds={shell.builds} activeBuild={{ id, name }} section="documents">
      <main className="pfl">
        <header className="tfl-hd">
          <div>
            <h1 className="tfl-h" style={{ fontSize: 20 }}>Files</h1>
            <p className="tfl-note">Every file lives once in the build; tasks link to it, so a new version shows everywhere it is used.</p>
          </div>
          <Link className="btn" href={`/projects/${id}/plan`}>Open the plan</Link>
        </header>

        <form className="pfl-bar" method="get" action={`/projects/${id}/documents`}>
          <input className="tfl-input" name="q" defaultValue={q} placeholder="Search by sheet number or name" aria-label="Search files" />
          {type ? <input type="hidden" name="type" value={type} /> : null}
          <button type="submit" className="btn sm">Search</button>
          <span className="tfl-tools" role="group" aria-label="Filter by type">
            {PROJECT_FILE_FILTERS.map((f) => (
              <Link key={f.key} className={`tfl-tool${(type ?? 'all') === f.key ? ' is-on' : ''}`}
                href={href({ type: f.key === 'all' ? null : f.key, cursor: null })}
                aria-current={(type ?? 'all') === f.key ? 'page' : undefined}>{f.label}</Link>
            ))}
          </span>
        </form>

        {error ? <p role="alert" className="tfl-err">{error}</p> : null}
        {!error && files.length === 0 ? (
          <p className="tfl-note">{q || type ? 'No files match.' : 'No files on this build yet. Add them from a task’s Files tab in the plan.'}</p>
        ) : null}

        {files.length ? (
          <table className="pfl-table">
            <thead>
              <tr><th>Type</th><th>Name</th><th>Version</th><th>Used on</th><th>Deliverable</th><th>Preview</th></tr>
            </thead>
            <tbody>
              {files.map((f) => {
                const state = stateOf.get(f.id);
                return (
                  <tr key={f.id}>
                    <td><FileTypeTag type={f.fileType} tag={f.tag} /></td>
                    <td>{f.openPath ? <a href={f.openPath} target="_blank" rel="noreferrer">{f.title}</a> : f.title}</td>
                    <td>{f.versionLabel}</td>
                    <td>
                      {f.usedOn.length ? f.usedOn.map((u) => (
                        <Link key={u.taskId} href={`/projects/${id}/plan?task=${encodeURIComponent(u.taskId)}&tab=files`} style={{ display: 'block' }}>
                          {taskName.get(u.taskId) ?? 'A task'}{u.role === 'deliverable' ? ' · deliverable' : ''}{u.inherited ? ' · inherited' : ''}
                        </Link>
                      )) : <span className="tfl-note">Project file</span>}
                    </td>
                    <td>{state ? <Badge tone={DELIVERABLE_STATE[state].tone}>{DELIVERABLE_STATE[state].label}</Badge> : <span className="tfl-note">—</span>}</td>
                    <td>{f.preview.tone === 'ok' ? <span className="tfl-note">{f.preview.label}</span> : <Badge tone={f.preview.tone}>{f.preview.label}</Badge>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
        {nextCursor ? <Link className="btn sm" href={href({ cursor: nextCursor })} style={{ alignSelf: 'flex-start' }}>Next page</Link> : null}
      </main>
    </PortalShell>
  );
}
