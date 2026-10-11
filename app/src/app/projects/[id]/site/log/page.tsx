// Log the day on site — `/projects/{id}/site/log` (PRD-10 E-7, E-8). Phone
// first: who is on site and how many, the weather, work against tasks, issues,
// and photos from the camera, tagged to a task or a location. The server page
// reads what the form offers (the build's organisations, its rows, its
// locations); the capture itself is a client component that uploads photos
// through the documents flow and sends one atomic capture.
import { redirect } from 'next/navigation';

import { isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContextV2 } from '@/lib/v2/shell';
import { getRecordV2 } from '@/lib/v2/record';
import { getPlanGrid } from '@/lib/v2/planning';
import { collectRowOptions } from '@/lib/v2/planning-view';
import { listParticipants } from '@/lib/v2/participants';
import { listLocationsV2 } from '@/lib/v2/execution';
import { DailyLogCapture } from '@/components/DailyLogCapture';
import '@/components/site.css';

export const dynamic = 'force-dynamic';

export default async function LogTodayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/site/log`);
  const [record, grid, participants, locations] = await Promise.all([
    getRecordV2(id), getPlanGrid(id), listParticipants(id), listLocationsV2(id),
  ]);
  const name = record?.name ?? 'This build';
  const shell = await buildShellContextV2(id, name);
  const orgs = [...new Map(participants.map((p) => [p.org.id, { id: p.org.id, name: p.org.legal_name }])).values()];

  return (
    <PortalShell user={shell.user} builds={shell.builds} activeBuild={{ id, name }} crumb="Log today">
      <main className="ste-page">
        <DailyLogCapture
          projectId={id}
          today={new Date().toISOString().slice(0, 10)}
          orgs={orgs}
          tasks={collectRowOptions(grid.rows)}
          locations={locations.map((l) => ({ id: l.id, name: l.name }))}
        />
      </main>
    </PortalShell>
  );
}
