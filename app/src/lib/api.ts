// Data-access layer for the R0 surfaces.
//
// Slices 1-4 own the HTTP routes (§6). Until those land in this deployment, the
// UI reads the "Maple Street" demo fixtures so FR1-FR9 are demonstrable end to
// end. Set LINKNMS_API_BASE (e.g. the preview URL, or "" for same-origin) to
// switch every read to the live contract endpoints — the shapes are identical,
// so no component changes. `isDemo()` lets surfaces show an honest banner.

import type { Project, Decision, ChangeOrderDetail, ChangeOrderSummary, AuditResult } from './types';
import {
  demoProject,
  demoDecisions,
  demoChangeOrders,
  demoAudit,
  summarize,
} from './fixtures';

const API_BASE = process.env.LINKNMS_API_BASE;

export function isDemo(): boolean {
  return API_BASE === undefined;
}

async function get<T>(path: string): Promise<T> {
  const base = API_BASE ?? '';
  const res = await fetch(`${base}/api/v1${path}`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body?.error?.message ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function getProject(id: string): Promise<Project> {
  if (isDemo()) return demoProject;
  return get<Project>(`/projects/${id}`);
}

export async function getDecisions(projectId: string): Promise<Decision[]> {
  if (isDemo()) return demoDecisions;
  return get<Decision[]>(`/projects/${projectId}/decisions`);
}

export async function getChangeOrders(projectId: string): Promise<ChangeOrderSummary[]> {
  if (isDemo()) return demoChangeOrders.map(summarize);
  return get<ChangeOrderSummary[]>(`/projects/${projectId}/change-orders`);
}

export async function getChangeOrder(id: string): Promise<ChangeOrderDetail> {
  if (isDemo()) {
    const co = demoChangeOrders.find((c) => c.id === id);
    if (!co) throw new ApiError(404, 'Change order not found');
    return co;
  }
  return get<ChangeOrderDetail>(`/change-orders/${id}`);
}

export async function getAudit(projectId: string): Promise<AuditResult> {
  if (isDemo()) return demoAudit;
  return get<AuditResult>(`/projects/${projectId}/audit`);
}
