// The build home's data layer on `/api/v2` (PRD-09 O-1, O-2). I/O only; the
// wording lives in `./build-home-view.ts`. Two reads, each ONE server query:
// the overview (composed server-side from the owning modules' ports) and the
// viewer's unread notifications by category on this build — no app-side
// aggregation of many endpoints. Both fail closed to null.
import 'server-only';

import { v2, V2Error } from './client';
import type { V2NotificationSummary, V2ProjectOverview } from './build-home-view';

const enc = encodeURIComponent;

async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof V2Error) return null;
    throw err;
  }
}

export function getProjectOverview(projectId: string): Promise<V2ProjectOverview | null> {
  return orNull(v2<V2ProjectOverview>({ method: 'GET', path: `/projects/${enc(projectId)}/overview` }));
}

export function getWaitingForMe(projectId: string): Promise<V2NotificationSummary | null> {
  return orNull(v2<V2NotificationSummary>({ method: 'GET', path: '/me/notification-summary', query: { project_id: projectId } }));
}
