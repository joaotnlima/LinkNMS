// Screen 8 — "Import plan · choose file" (PRD-09 O-6, O-9, O-10; flows/01).
// `/projects/{id}/plan/import` is a real route again (it was a redirect while
// the import did not exist, PRD-01 C-1/C-2). The workbook is read on the
// server by the planning module; this page only takes the file — and says up
// front when the plan already has rows (import goes into an empty plan only).
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContextV2 } from '@/lib/v2/shell';
import { getProjectOverview } from '@/lib/v2/build-home';
import { planIsEmpty } from '@/lib/v2/build-home-view';
import { ImportDropzone } from './ImportDropzone';
import '../../build-home.css';

export const dynamic = 'force-dynamic';

export default async function PlanImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/plan/import`);
  const overview = await getProjectOverview(id);
  const name = overview?.project.name ?? 'This build';
  const shell = await buildShellContextV2(id, name);
  const hasPlan = overview ? !planIsEmpty(overview) : false;

  return (
    <PortalShell user={shell.user} builds={shell.builds} activeBuild={{ id, name }} section="plan" crumb="Import plan">
      <main className="imp">
        <p className="imp-steps">Import · step 1 of 3 · choose file</p>
        <h1 className="m14-title">Import your plan from Excel</h1>
        <p className="bh-note">
          Your schedule as you keep it: one row per action or sub-action, with start and end dates (or a duration).
          Next you tell us what each column means and check the result — nothing is written until you confirm.
        </p>
        {hasPlan && (
          <p className="imp-warn" role="status">
            This build already has a plan. An import goes into an empty plan only — reviewing a re-import as a diff is
            coming. <Link href={`/projects/${id}/plan`}>Open the plan</Link>
          </p>
        )}
        <ImportDropzone projectId={id} />
      </main>
    </PortalShell>
  );
}
