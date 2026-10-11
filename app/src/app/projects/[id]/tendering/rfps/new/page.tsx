// /projects/{id}/tendering/rfps/new — compose an RFP not started from a row
// (PRD-08 H-5). Composing normally happens in the task panel (PRD-02); this is
// the door for the rest, and per D-29 an RFP still launches from a row or
// subtree: the workspace asks for the task FIRST, then opens the same 3-step
// composer the panel uses. `?task=` pre-picks it (the old "Start tendering"
// deep link); `?mode=light` presets a design tender. Once saved, the draft
// moves to its own address.
import { PortalShell } from '@/components/PortalShell';
import { loadTenderingFrame, requireSignedIn } from '../../load';
import { RfpWorkspaceRoute } from '../../RfpWorkspaceRoute';
import '@/components/tender/tender.css';
import '@/components/plan-import.css';

export const dynamic = 'force-dynamic';

export default async function NewRfpPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ task?: string; mode?: string }>;
}) {
  const { id } = await params;
  const { task, mode } = await searchParams;
  await requireSignedIn(`/projects/${id}/tendering/rfps/new`);
  const frame = await loadTenderingFrame(id, { withTasks: true });
  const seed = task && frame.tasks.some((t) => t.id === task) ? task : null;

  return (
    <PortalShell user={frame.shell.user} builds={frame.shell.builds} activeBuild={{ id, name: frame.name }}
      crumb="Tendering › New RFP" align="start">
      <main className="pi">
        {!frame.hasActiveOrg ? (
          <p className="tnd-note is-strong">Select an organisation to run a tender.</p>
        ) : !frame.canIssue || !frame.isParticipant ? (
          <p className="tnd-note is-strong">Only a team member who can issue tenders on this project can start one.</p>
        ) : (
          <RfpWorkspaceRoute projectId={id} rfp={null} tasks={frame.tasks} seedTaskId={seed}
            initialMode={mode === 'light' ? 'light' : 'detailed'} />
        )}
      </main>
    </PortalShell>
  );
}
