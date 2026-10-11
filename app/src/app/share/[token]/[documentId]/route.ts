// /share/{token}/{documentId} — opens or downloads one shared document for the
// link holder (PRD-12 N-12). Dispatches `downloadSharedDocument` in-process
// (the token never becomes an API wire URL, gap S1) and redirects the browser
// to the short-lived signed URL; the module logs the access first. A closed
// link goes back to the holder's page, which says why.
import { NextRequest, NextResponse } from 'next/server';

import { sharedDocumentLocationV2 } from '@/lib/v2/share-links';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string; documentId: string }> }) {
  const { token, documentId } = await params;
  const disposition = req.nextUrl.searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment';
  const res = await sharedDocumentLocationV2(token, documentId, disposition);
  const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
  if (res.ok) return NextResponse.redirect(res.url, { status: 302, headers });
  if (res.status === 410) return NextResponse.redirect(new URL(`/share/${encodeURIComponent(token)}`, req.url), { status: 303, headers });
  return new NextResponse('Not found', { status: 404, headers });
}
