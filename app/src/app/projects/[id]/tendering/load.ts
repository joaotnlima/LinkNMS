// The server reads every /projects/{id}/tendering route shares (PRD-08): the
// sign-in bounce, the project name for the breadcrumb, the shell, the plan's
// tasks (what a tender can be raised over) and whether the viewer may issue.
// One place, so the four routes read the same things the same way.
import 'server-only';
import { redirect } from 'next/navigation';

import { isSignedIn } from '@/lib/api';
import { buildShellContextV2 } from '@/lib/v2/shell';
import { getPlanGrid } from '@/lib/v2/planning';
import { collectRowOptions } from '@/lib/v2/planning-view';
import { getRecordV2 } from '@/lib/v2/record';
import { viewerCanIssueTenders, viewerHasActiveOrg } from '@/lib/v2/profile';
import type { TaskOption } from '@/components/tender/types';

export async function requireSignedIn(next: string): Promise<void> {
  if (!(await isSignedIn())) redirect(`/sign-in?next=${encodeURIComponent(next)}`);
}

/** Shell + name; `withTasks` also reads the plan (issuer-side routes only). */
export async function loadTenderingFrame(projectId: string, { withTasks = false } = {}) {
  const [record, canIssue, hasActiveOrg, grid] = await Promise.all([
    getRecordV2(projectId),
    viewerCanIssueTenders(),
    viewerHasActiveOrg(),
    withTasks ? getPlanGrid(projectId) : Promise.resolve(null),
  ]);
  const name = record?.name ?? 'This project';
  const shell = await buildShellContextV2(projectId, name);
  const tasks: TaskOption[] = grid ? collectRowOptions(grid.rows) : [];
  return { name, shell, canIssue, hasActiveOrg, tasks, isParticipant: record !== null };
}
