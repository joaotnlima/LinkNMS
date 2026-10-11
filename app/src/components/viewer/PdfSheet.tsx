'use client';

// One PDF sheet, rendered client-side (PRD-06 V-4), fitted to the canvas width
// times the zoom, with the markup layer laid over it in PDF points. With an
// `overlayUrl` the previous version of the same page is composited in as a
// two-colour diff (V-7: red = only in this version, blue = only in the previous).
import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

import { openPdf, renderPage, compositeDiff, type OpenPdf, type PageSize } from './pdf-render';
import type { SheetBox } from './MarkupLayer';

export function PdfSheet({
  url, overlayUrl, pageNo, zoom, onPages, children,
}: {
  url: string;
  overlayUrl: string | null;
  pageNo: number;
  zoom: number;
  onPages: (count: number) => void;
  children: (box: SheetBox) => React.ReactNode;
}) {
  const frame = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [opened, setOpened] = useState<OpenPdf | null>(null);
  const [prevOpened, setPrevOpened] = useState<OpenPdf | null>(null);
  const doc: PDFDocumentProxy | null = opened?.doc ?? null;
  const prev: PDFDocumentProxy | null = prevOpened?.doc ?? null;
  const [size, setSize] = useState<PageSize | null>(null);
  const [css, setCss] = useState<{ w: number; h: number } | null>(null);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setOpened(null); setError(null);
    openPdf(url)
      .then((o) => { if (live) { setOpened(o); onPages(o.doc.numPages); } else o.close(); })
      .catch(() => { if (live) setError('This PDF could not be opened here. Download it instead.'); });
    return () => { live = false; };
  }, [url, onPages]);

  useEffect(() => {
    let live = true;
    setPrevOpened(null);
    if (overlayUrl) openPdf(overlayUrl).then((o) => { if (live) setPrevOpened(o); else o.close(); }).catch(() => {});
    return () => { live = false; };
  }, [overlayUrl]);

  useEffect(() => () => { opened?.close(); }, [opened]);
  useEffect(() => () => { prevOpened?.close(); }, [prevOpened]);

  useEffect(() => {
    const el = frame.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!doc || !canvas.current || width < 50) return;
    let live = true;
    (async () => {
      const page = await doc.getPage(Math.min(pageNo, doc.numPages));
      const base = page.getViewport({ scale: 1 });
      const scale = ((width - 32) / base.width) * zoom;
      const target = canvas.current;
      if (!target || !live) return;
      if (prev && pageNo <= prev.numPages) {
        const cur = document.createElement('canvas');
        const old = document.createElement('canvas');
        const s = await renderPage(doc, pageNo, cur, scale);
        await renderPage(prev, pageNo, old, scale);
        if (!live) return;
        compositeDiff(cur, old, target);
        setSize(s);
      } else {
        setSize(await renderPage(doc, pageNo, target, scale));
      }
      if (live) setCss({ w: base.width * scale, h: base.height * scale });
    })().catch(() => { if (live) setError('This sheet could not be drawn.'); });
    return () => { live = false; };
  }, [doc, prev, pageNo, zoom, width]);

  return (
    <div ref={frame} className="vw-stage is-paper">
      {error ? <p role="alert" className="vw-stage-note">{error}</p> : null}
      {!doc && !error ? <p className="vw-stage-note" role="status">Opening the PDF…</p> : null}
      <div className="vw-sheet" style={css ? { width: css.w, height: css.h } : undefined}>
        <canvas ref={canvas} aria-label={`Sheet ${pageNo}`} />
        {size && css ? children({ x: 0, y: 0, width: size.width, height: size.height }) : null}
      </div>
    </div>
  );
}
