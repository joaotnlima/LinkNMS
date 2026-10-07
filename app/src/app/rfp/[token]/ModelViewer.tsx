'use client';

// The public token form mounts the IFC viewer through here (LINA-409 / doc 24).
// The token is the authority: `resolveModelUrlAction` re-supplies it server-side
// and mints the presigned INLINE GET there — the token never reaches R2, only
// the short-TTL URL reaches the browser (doc 24 §Authorization). The page route
// already sends `Referrer-Policy: no-referrer` (next.config.mjs), so the token
// in the URL is not leaked in the fetch's `Referer`.
import RfpModelViewer from '@/components/ifc/RfpModelViewer';

import { resolveModelUrlAction } from './actions';

export default function TokenModelViewer({
  token, documentId, fileName, sizeBytes,
}: {
  token: string;
  documentId: string;
  fileName: string;
  sizeBytes: number;
}) {
  // resolveModelUrlAction already returns { url } | { error } — the exact shape.
  const resolve = () => resolveModelUrlAction(token, documentId);
  return <RfpModelViewer resolve={resolve} fileName={fileName} sizeBytes={sizeBytes} />;
}
