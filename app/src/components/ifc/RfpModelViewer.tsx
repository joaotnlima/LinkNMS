'use client';

// Thin client wrapper that mounts <IfcViewer> with `ssr: false`, so Three.js +
// web-ifc (and the WASM asset) are bundled for the BROWSER only and never enter
// the server runtime / build trace (LINA-409 / doc 24). Every RFP surface mounts
// the viewer through this wrapper; they differ only in the `resolve` thunk they
// pass (an authed server action, or the public token fetcher).
import dynamic from 'next/dynamic';

import type { ModelUrlResolve } from './IfcViewer';

const IfcViewer = dynamic(() => import('./IfcViewer'), {
  ssr: false,
  loading: () => (
    <div style={{ padding: '14px 12px', color: 'var(--muted, #6b7280)', border: '1px solid var(--border, #e3e5e8)', borderRadius: 10 }}>
      Preparing the 3D viewer…
    </div>
  ),
});

export interface RfpModelViewerProps {
  resolve: () => Promise<ModelUrlResolve>;
  fileName: string;
  sizeBytes: number;
}

export default function RfpModelViewer({ resolve, fileName, sizeBytes }: RfpModelViewerProps) {
  return <IfcViewer resolveUrl={resolve} fileName={fileName} sizeBytes={sizeBytes} />;
}
