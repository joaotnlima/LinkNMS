'use client';

// The DWG side of the right panel (PRD-06 V-12, V-15): the file's layers with
// on/off — the viewer's own view, never written to the file — and what the
// conversion substituted or could not resolve (missing xrefs, fonts).
import type { V2Preview } from '@/lib/v2/viewer-view';

export function DwgLayers({
  preview, layout, hidden, onToggle,
}: {
  preview: V2Preview;
  layout: string;
  hidden: Set<string>;
  onToggle: (name: string, on: boolean) => void;
}) {
  return (
    <section className="vw-panel" aria-label="Layers">
      <div className="vw-panel-hd">
        <span className="vw-grp">Layers · {layout}</span>
        <span className="vw-note">From the file. Hiding a layer is your view only.</span>
      </div>
      {preview.layers.length ? (
        <div className="vw-layers">
          {preview.layers.map((l) => {
            const on = !hidden.has(l.name);
            return (
              <label key={l.name} className="vw-cat">
                <input type="checkbox" checked={on} onChange={(e) => onToggle(l.name, e.target.checked)} />
                <span className="vw-swatch" style={{ background: l.color ?? '#9b9890' }} aria-hidden="true" />
                {l.name}{l.on ? null : <span className="vw-note"> (off in the file)</span>}
                <span className="vw-n-count">{l.count ?? '—'}</span>
              </label>
            );
          })}
        </div>
      ) : <p className="vw-note">The converter did not list this file’s layers.</p>}
      {preview.warnings.length ? (
        <ul className="vw-warn">
          {preview.warnings.map((w) => <li key={w.code}>{w.detail ?? w.code.replace(/_/g, ' ')}</li>)}
        </ul>
      ) : null}
    </section>
  );
}
