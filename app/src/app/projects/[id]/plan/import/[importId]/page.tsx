// Screens 9–10 — "Map columns" and "Preview" (PRD-09 O-7, O-8, O-9; flows/01).
// `/projects/{id}/plan/import/{importId}`: the import as the planning module
// holds it (sheets, columns, the suggested or saved mapping, the sample, the
// tree). Desktop-first, usable on a phone. A confirmed import goes to the plan.
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContextV2 } from '@/lib/v2/shell';
import { getProjectOverview } from '@/lib/v2/build-home';
import { getPlanImport } from '@/lib/v2/plan-import';
import { ImportMapper } from './ImportMapper';
import '../../../build-home.css';

export const dynamic = 'force-dynamic';

export default async function PlanImportMapPage({ params }: { params: Promise<{ id: string; importId: string }> }) {
  const { id, importId } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/plan/import/${importId}`);
  const [overview, view] = await Promise.all([getProjectOverview(id), getPlanImport(importId)]);
  if (view?.status === 'confirmed') redirect(`/projects/${id}/plan?imported=${importId}`);
  const name = overview?.project.name ?? 'This build';
  const shell = await buildShellContextV2(id, name);

  return (
    <PortalShell user={shell.user} builds={shell.builds} activeBuild={{ id, name }} section="plan" crumb="Import plan">
      <main className="imp">
        {!view || view.project_id !== id ? (
          <p className="bh-note">This import could not be found. <Link href={`/projects/${id}/plan/import`}>Start again</Link></p>
        ) : view.sheets.every((s) => s.rows === 0) ? (
          <section className="bh-sec">
            <h1 className="m14-title">Nothing to import in {view.filename}</h1>
            <p className="imp-warn">
              No sheet in this workbook has rows under a header row. Put one row per action or sub-action under a
              header (Action, Start, End…), or start from the template.
            </p>
            <div className="bh-actions">
              <Link className="btn primary" href={`/projects/${id}/plan/import`}>Choose another file</Link>
              <a className="btn" href="/plan-template.xlsx" download>Download the template</a>
            </div>
          </section>
        ) : (
          <ImportMapper projectId={id} initial={view} />
        )}
      </main>
    </PortalShell>
  );
}
