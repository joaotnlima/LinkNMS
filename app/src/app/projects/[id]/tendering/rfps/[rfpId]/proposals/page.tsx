// /projects/{id}/tendering/rfps/{rfpId}/proposals — the proposals inbox and the
// full comparison (PRD-08 H-3). The same ProposalsInbox + Compare drill-down
// the workspace always had (PRD-02 components), now at a shareable address;
// `?compare=` names the bids the drill-down is over (view state). Issuer only:
// a bidder never reads another lane (V8), so it lands on the RFP detail.
import { redirect } from 'next/navigation';

import { PortalShell } from '@/components/PortalShell';
import { getRfp } from '@/lib/v2/tendering';
import { listProjectRfps } from '@/lib/v2/tendering-home';
import { rfpPath } from '@/lib/v2/tendering-home-view';
import { loadTenderingFrame, requireSignedIn } from '../../../load';
import { RfpWorkspaceRoute } from '../../../RfpWorkspaceRoute';
import '@/components/tender/tender.css';
import '@/components/plan-import.css';

export const dynamic = 'force-dynamic';

export default async function RfpProposalsPage({
  params, searchParams,
}: {
  params: Promise<{ id: string; rfpId: string }>;
  searchParams: Promise<{ compare?: string }>;
}) {
  const { id, rfpId } = await params;
  const { compare } = await searchParams;
  await requireSignedIn(`/projects/${id}/tendering/rfps/${rfpId}/proposals`);
  const items = await listProjectRfps(id);
  const item = items?.find((r) => r.id === rfpId) ?? null;
  if (item && item.viewer_role !== 'issuer') redirect(rfpPath(id, rfpId));
  const [rfp, frame] = await Promise.all([item ? getRfp(rfpId) : Promise.resolve(null), loadTenderingFrame(id, { withTasks: true })]);

  return (
    <PortalShell user={frame.shell.user} builds={frame.shell.builds} activeBuild={{ id, name: frame.name }}
      crumb={item ? `Tendering › ${item.title} › Proposals` : 'Tendering'} align="start">
      <main className="pi">
        {!item || !rfp ? (
          <p className="tnd-note is-strong">This tender does not exist, or it is not yours to open.</p>
        ) : rfp.status === 'draft' ? (
          <RfpWorkspaceRoute projectId={id} rfp={rfp} tasks={frame.tasks} />
        ) : (
          <RfpWorkspaceRoute projectId={id} rfp={rfp} tasks={frame.tasks} initialSection="proposals"
            initialCompare={compare ?? null} openQuestions={item.open_question_count ?? 0} />
        )}
      </main>
    </PortalShell>
  );
}
