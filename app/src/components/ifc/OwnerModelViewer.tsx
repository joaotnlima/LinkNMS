'use client';

// The authed read surfaces (owner inbox + composer preview) mount the IFC viewer
// through here (LINA-409 / doc 24). It binds the authed `:view-url` server action
// into the no-arg `resolve` thunk <IfcViewer> wants: the URL is minted fresh
// (short TTL) at click time, after `requireRfpRead` passes server-side.
import { rfpModelViewUrlAction } from '../procurement-actions';

import RfpModelViewer from './RfpModelViewer';

export default function OwnerModelViewer({
  rfpId, documentId, fileName, sizeBytes,
}: {
  rfpId: string;
  documentId: string;
  fileName: string;
  sizeBytes: number;
}) {
  const resolve = async () => {
    const res = await rfpModelViewUrlAction(rfpId, documentId);
    return res.ok ? { url: res.data.url } : { error: res.message };
  };
  return <RfpModelViewer resolve={resolve} fileName={fileName} sizeBytes={sizeBytes} />;
}
