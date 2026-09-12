// POST /api/v1/projects/:id/plan/stages/:stageKey/attachments — upload a task
// file (LINA-249), multipart as the $file part. Server-side content-type sniff
// (allowlist: images + pdf + common office docs), 10 MB cap, uploader stamped
// from the session party. Bytes go to Vercel Blob; the returned URL + metadata
// land in schedule.stage_attachment. Project members only.
// Contract: docs/architecture/slice-task-workspace-contract.md.
import { handleUpload, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function POST(req: Request, ctx: { params: Promise<{ id: string; stageKey: string }> }) {
  return handleUpload(req, ctx, (c) => container().http.schedule.addStageAttachment(c));
}