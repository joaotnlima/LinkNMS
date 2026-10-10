// /projects/{id}/tendering/rfps/{rfpId} — the RFP detail (PRD-08 H-2).
//
// The issuer gets the full tender workspace (the PRD-02 step components:
// overview with bidders, files, emailed bids, clarifications to answer); a
// bidder org gets the scope, the published answers and the ask box. Which one
// is decided by the module's own read (listProjectRfps' `viewer_role`), never
// guessed here. `?tab=` opens a workspace section (view state, to-be/20 rule 6).
import { PortalShell } from '@/components/PortalShell';
import type { WorkspaceSection } from '@/components/tender/TenderPanel';
import { getRfp } from '@/lib/v2/tendering';
import { listProjectRfps } from '@/lib/v2/tendering-home';
import { BidderRfpView } from '../../BidderRfpView';
import { loadTenderingFrame, requireSignedIn } from '../../load';
import { RfpWorkspaceRoute } from '../../RfpWorkspaceRoute';
import '@/components/tender/tender.css';
import '@/components/plan-import.css';

export const dynamic = 'force-dynamic';

const TABS = new Set<WorkspaceSection>(['overview', 'matrix', 'files', 'emailed', 'clarifications']);

export default async function RfpDetailPage({
  params, searchParams,
}: {
  params: Promise<{ id: string; rfpId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id, rfpId } = await params;
  const { tab } = await searchParams;
  await requireSignedIn(`/projects/${id}/tendering/rfps/${rfpId}`);
  const [items, rfp] = await Promise.all([listProjectRfps(id), getRfp(rfpId)]);
  const item = items?.find((r) => r.id === rfpId) ?? null;
  const issuer = item?.viewer_role === 'issuer';
  const frame = await loadTenderingFrame(id, { withTasks: issuer });
  const section = tab && TABS.has(tab as WorkspaceSection) ? (tab as WorkspaceSection) : 'overview';

  return (
    <PortalShell user={frame.shell.user} builds={frame.shell.builds} activeBuild={{ id, name: frame.name }}
      crumb={item ? `Tendering › ${item.title}` : 'Tendering'} align="start">
      <main className="pi">
        {!item || !rfp || rfp.project_id !== id ? (
          <p className="tnd-note is-strong">This tender does not exist, or it is not yours to open.</p>
        ) : issuer ? (
          <RfpWorkspaceRoute projectId={id} rfp={rfp} tasks={frame.tasks} initialSection={section}
            openQuestions={item.open_question_count ?? 0} />
        ) : (
          <BidderRfpView projectId={id} rfp={rfp} myProposalStatus={item.my_proposal?.status ?? null} />
        )}
      </main>
    </PortalShell>
  );
}
