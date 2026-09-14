// POST /api/v1/projects/:id/procurement/rfp/attachments — append one RFP
// attachment (LINA-279), multipart as the $file part. Server-side content-type
// sniff + 10 MB cap (shared with task-workspace); the FileRef is appended to
// the live draft and returned so the FE renders it straight away. MANAGE_RFP.
import { handleUpload, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleUpload(req, ctx, (c) => container().http.schedule.addRfpAttachment(c));
}