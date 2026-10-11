'use client';

// One DWG / DXF layout (PRD-06 V-11..V-13, V-16): the SVG the server generated
// from the file, fetched from its short-lived inline URL, sanitised again here
// (it is inlined so layers can be hidden by CSS), on a light or dark ground, with
// the same markup layer as a PDF laid over it in the SVG's own units. The .dwg
// itself is never touched.
import { useEffect, useMemo, useRef, useState } from 'react';

import { hiddenLayersCss } from '@/lib/v2/viewer-view';
import type { SheetBox } from './MarkupLayer';

const BANNED = 'script,foreignObject,iframe,object,embed,audio,video';

/** Parse, strip what must not run, and read the viewBox. Null when it is not an SVG. */
function cleanSvg(text: string): { markup: string; box: SheetBox } | null {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length) return null;
  root.querySelectorAll(BANNED).forEach((n) => n.remove());
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      else if ((name === 'href' || name === 'xlink:href') && !attr.value.trim().startsWith('#')) el.removeAttribute(attr.name);
    }
  }
  const vb = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || vb.some((v) => !Number.isFinite(v)) || vb[2] <= 0 || vb[3] <= 0) return null;
  root.setAttribute('width', '100%');
  root.setAttribute('height', '100%');
  root.setAttribute('preserveAspectRatio', 'none');
  return { markup: new XMLSerializer().serializeToString(root), box: { x: vb[0], y: vb[1], width: vb[2], height: vb[3] } };
}

export function DwgSheet({
  url, zoom, dark, hiddenLayers, children,
}: {
  url: string;
  zoom: number;
  dark: boolean;
  hiddenLayers: Set<string>;
  children: (box: SheetBox) => React.ReactNode;
}) {
  const frame = useRef<HTMLDivElement | null>(null);
  const [svg, setSvg] = useState<{ markup: string; box: SheetBox } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    let live = true;
    setSvg(null); setError(null);
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => {
        if (!live) return;
        const clean = cleanSvg(t);
        if (clean) setSvg(clean); else setError('This preview could not be read. Download the file instead.');
      })
      .catch(() => { if (live) setError('The preview could not be loaded. Try again, or download the file.'); });
    return () => { live = false; };
  }, [url]);

  useEffect(() => {
    const el = frame.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const css = useMemo(() => hiddenLayersCss(hiddenLayers, (s) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s)), [hiddenLayers]);
  const w = Math.max(0, (width - 32) * zoom);
  const h = svg ? (w * svg.box.height) / svg.box.width : 0;

  return (
    <div ref={frame} className={`vw-stage ${dark ? 'is-dark' : 'is-light'}`}>
      {error ? <p role="alert" className="vw-stage-note">{error}</p> : null}
      {!svg && !error ? <p className="vw-stage-note" role="status">Loading the preview…</p> : null}
      {svg && w > 0 ? (
        <div className="vw-sheet" style={{ width: w, height: h }}>
          <style>{css}</style>
          {/* Sanitised above (no scripts, handlers, foreign content or external refs). */}
          <div className="vw-dwg" dangerouslySetInnerHTML={{ __html: svg.markup }} />
          {children(svg.box)}
        </div>
      ) : null}
    </div>
  );
}
