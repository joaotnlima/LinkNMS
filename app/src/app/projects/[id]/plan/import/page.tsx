// D8–D10 — the import wizard's route (LINA-207; shell-unified LINA-224).
//
// A thin server shell: it proves there is a session, names the build for the
// switcher + breadcrumb, and hands off to the client machine that holds the file.
// The authorization that matters is NOT here — `IMPORT_PLAN` is decided in the
// schedule service on every one of the four calls (contract §5), so a non-GC who
// reaches this URL gets a 403 sentence from the server on the first step rather
// than a screen this file decided to withhold. The redirect below is the same
// routing convenience the rest of the app uses, never a security control.
//
// CHROME DECISION (LINA-224): the rail, not a standalone wizard takeover. Import
// is one operation on an already-live build's plan, not the modal build-creation
// task WizardChrome is for — so it wears PortalShell BUILD mode under section
// "plan", and the wizard keeps its own three-step header + "build › Plan › Import
// plan" breadcrumb (the extra leaf the rail cannot express, same as line detail).
import { redirect } from 'next/navigation';

import { getBuild, isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContext } from '@/server/portal-shell';
import { PlanImportWizard } from './PlanImportWizard';

export const dynamic = 'force-dynamic';

export default async function PlanImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/plan/import`);

  const build = await getBuild(id);
  const shell = await buildShellContext(id, build.name);

  return (
    <PortalShell
      user={shell.user}
      builds={shell.builds}
      activeBuild={{ id, name: build.name }}
      section="plan"
    >
      <PlanImportWizard projectId={id} projectName={build.name} />
    </PortalShell>
  );
}
