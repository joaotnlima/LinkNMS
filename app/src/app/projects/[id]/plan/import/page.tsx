// D8–D10 — the import wizard's route (LINA-207).
//
// A thin server shell: it proves there is a session, names the build for the
// breadcrumb, and hands off to the client machine that holds the file. The
// authorization that matters is NOT here — `IMPORT_PLAN` is decided in the
// schedule service on every one of the four calls (contract §5), so a non-GC who
// reaches this URL gets a 403 sentence from the server on the first step rather
// than a screen this file decided to withhold. The redirect below is the same
// routing convenience the rest of the app uses, never a security control.
import { redirect } from 'next/navigation';

import { getBuild, isSignedIn } from '@/lib/api';
import { TopBar } from '@/components/chrome';
import { PlanImportWizard } from './PlanImportWizard';

export const dynamic = 'force-dynamic';

export default async function PlanImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/plan/import`);

  const build = await getBuild(id);

  return (
    <>
      <TopBar back={{ href: `/projects/${id}/plan`, label: 'Plan' }} />
      <main>
        <PlanImportWizard projectId={id} projectName={build.name} />
      </main>
    </>
  );
}
