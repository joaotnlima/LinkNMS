// POST /api/v1/rfp/token/:token/portfolio-images — upload one portfolio image as
// an external, unauthenticated contractor (LINA-279, LINA-284). No session: the
// token IS the credential. Server-side sniff to JPEG/PNG/WebP/HEIC only + 10 MB
// cap; returns the FileRef the page attaches to the still-editable proposal.
import { handleUpload, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  return handleUpload(req, ctx, (c) => container().http.schedule.uploadPortfolioImage(c));
}