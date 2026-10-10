// The build's shared model — `/projects/{id}/model` (PRD-07 M-1, to-be/20).
// Every participant reads it; `?task=` (id or outline code) isolates a task,
// `?version=` opens a version, `?tab=versions` the history. The server answers
// the model, its record-side links and pins, and the viewer's edit scope (M-8)
// in one read; the participants list names the organisations. A viewer who is
// not on the build gets the sentence, never a crash. The 3D island is a client
// component (web-ifc + Three.js, never in the server bundle).
import { redirect } from 'next/navigation';

import { isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContextV2 } from '@/lib/v2/shell';
import { getRecordV2 } from '@/lib/v2/record';
import { fetchProjectModel } from '@/lib/v2/model';
import { fetchQuestionParties } from '@/lib/v2/viewer';
import type { V2ProjectModel } from '@/lib/v2/model-view';
import { ModelPage } from '@/components/model/ModelPage';

export const dynamic = 'force-dynamic';

export default async function ProjectModelPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ task?: string; version?: string; tab?: string }>;
}) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/model`);
  const sp = await searchParams;
  const version = sp.version && /^\d{1,6}$/.test(sp.version) ? Number(sp.version) : null;

  let model: V2ProjectModel | null = null;
  let error: string | null = null;
  let orgNames: Record<string, string> = {};
  const record = await getRecordV2(id);
  try {
    const [m, parties] = await Promise.all([fetchProjectModel(id, null), fetchQuestionParties(id).catch(() => [])]);
    model = m;
    orgNames = Object.fromEntries(parties.map((p) => [p.orgId, p.name]));
  } catch (err) {
    error = err instanceof Error ? err.message : 'The model of this build could not be loaded.';
  }
  const name = record?.name ?? 'This build';
  const shell = await buildShellContextV2(id, name);

  return (
    <PortalShell user={shell.user} builds={shell.builds} activeBuild={{ id, name }} section="model">
      {model ? (
        <ModelPage projectId={id} projectName={name} initial={model} orgNames={orgNames}
          taskParam={sp.task ?? null} versionParam={version} initialTab={sp.tab === 'versions' ? 'versions' : 'model'} />
      ) : (
        <main className="mdl"><p role="alert">{error}</p></main>
      )}
    </PortalShell>
  );
}
