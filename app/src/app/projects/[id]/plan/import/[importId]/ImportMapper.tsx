'use client';

// Screens 9–10 (PRD-09 O-7, O-8): the ImportMapping table (each spreadsheet
// column → a LinkNMS field, text labels, never colour coding), the live preview
// of the first rows the server parsed with that mapping, then the WBSTree with
// a mini Gantt and the row / warning counts, and Confirm. Every mapping change
// round-trips to the server's parser — nothing is inferred here. Only a missing
// REQUIRED mapping blocks; per-row problems are warnings.
import { useState, useTransition } from 'react';

import {
  FIELD_OPTIONS, fieldOfColumn, mappingFromSelects, missingSentence, ganttBars,
  type V2ScheduleImport,
} from '@/lib/v2/plan-import-view';
import { mapPlanAction, previewPlanAction, confirmPlanAction } from '../actions';

export function ImportMapper({ projectId, initial }: { projectId: string; initial: V2ScheduleImport }) {
  const [view, setView] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const byColumn = fieldOfColumn(view.mapping);
  const missing = missingSentence(view.missing_required);
  const previewing = view.status === 'previewed' && view.tree;

  const run = (fn: () => Promise<{ error?: string; view?: V2ScheduleImport }>) => start(async () => {
    const res = await fn();
    if (res.error) setError(res.error);
    else { setError(null); if (res.view) setView(res.view); }
  });

  const remap = (sheet: string, col: number | null, field: string) => {
    const selects: Array<[number, string]> = view.columns.map((c) => [c.index, c.index === col ? field : (byColumn.get(c.index) ?? '')]);
    // Choosing a field already on another column moves it here.
    const cleaned = selects.map(([i, f]) => [i, i !== col && f === field ? '' : f] as [number, string]);
    const { mapping, error: e } = mappingFromSelects(sheet === view.sheet ? cleaned : []);
    if (e) { setError(e); return; }
    run(() => mapPlanAction(view.id, sheet, mapping));
  };

  const sample = view.sample ?? [];
  const { bars, from, to } = previewing ? ganttBars(view.tree!) : { bars: [], from: null, to: null };
  const counts = view.counts;

  return (
    <div className="bh-sec">
      <p className="imp-steps">Import · step {previewing ? '3 of 3 · preview' : '2 of 3 · map columns'}</p>
      <h1 className="m14-title">{previewing ? 'Check the plan before it is written' : 'Map your columns'}</h1>
      <p className="bh-note">
        We read <strong>{view.filename}</strong>{view.sheet ? <> › <strong>{view.sheet}</strong></> : null}. Tell us what each
        column means — we don&rsquo;t guess.{view.mapping_suggested ? ' We pre-filled what the headers suggest; check each one.' : ''}
      </p>
      {view.plan_exists && (
        <p className="imp-warn" role="status">This build already has a plan — an import goes into an empty plan only, so Confirm is off.</p>
      )}
      {error && <p className="imp-warn" role="alert">{error}</p>}

      {!previewing && (
        <div className="imp-grid">
          <section className="bh-sec" aria-label="Column mapping">
            {view.sheets.length > 1 && (
              <label className="field">
                <span className="metric-lbl">Sheet</span>
                <select value={view.sheet ?? ''} onChange={(e) => run(() => mapPlanAction(view.id, e.target.value, {}))} disabled={pending}>
                  {view.sheets.map((s) => <option key={s.name} value={s.name}>{s.name} ({s.rows} rows)</option>)}
                </select>
              </label>
            )}
            <table className="imp-map">
              <thead><tr><th scope="col">Spreadsheet column</th><th scope="col">Maps to LinkNMS field</th></tr></thead>
              <tbody>
                {view.columns.map((c) => (
                  <tr key={c.index}>
                    <td>
                      <strong>{c.header}</strong>
                      <div className="imp-sample">{c.samples.map((s) => `“${s}”`).join(', ') || 'empty'}</div>
                    </td>
                    <td>
                      <select
                        aria-label={`Field for column ${c.header}`}
                        value={byColumn.get(c.index) ?? ''}
                        disabled={pending}
                        onChange={(e) => remap(view.sheet ?? '', c.index, e.target.value)}
                      >
                        <option value="">Not imported</option>
                        {FIELD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}{o.required ? ' (required)' : ''}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {missing ? <p className="imp-warn">{missing}</p> : <p className="imp-ok">Required fields (Action, Start, End) are all mapped.</p>}
          </section>

          <section className="bh-sec" aria-label="Live preview">
            <h2 className="bh-h">Live preview · first {sample.length} rows</h2>
            {view.status === 'uploaded' ? (
              <p className="bh-note">Confirm the mapping on the left (change any column, or press “Use this mapping”) to see the rows as we read them.</p>
            ) : (
              <div className="imp-scroll">
                <table className="imp-prev">
                  <thead><tr><th>Row</th><th>Action</th><th>Sub-action</th><th>Start</th><th>End</th><th>Trade</th><th>Depends on</th></tr></thead>
                  <tbody>
                    {sample.map((r) => (
                      <tr key={r.row} className={r.warnings.length ? 'has-warn' : ''} title={r.warnings.map((w) => w.message).join('\n') || undefined}>
                        <td>{r.row}{r.warnings.length ? ' ⚠' : ''}</td>
                        <td>{r.sub_action ? '' : r.action}</td><td>{r.sub_action ?? '—'}</td>
                        <td>{r.start ?? '—'}</td><td>{r.finish ?? (r.duration_wd ? `${r.duration_wd} wd` : '—')}</td>
                        <td>{r.trade ?? '—'}</td><td>{r.dependency ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {view.warnings.length > 0 && (
              <div className="imp-warn">
                <strong>{view.warnings.length} row{view.warnings.length === 1 ? '' : 's'} to check after import</strong> — warnings don&rsquo;t block.
                <ul>{view.warnings.slice(0, 8).map((w, i) => <li key={i}>{w.message}</li>)}</ul>
              </div>
            )}
            <div className="imp-foot">
              <a className="bh-link" href={`/projects/${projectId}/plan/import`}>Choose another file</a>
              {view.status === 'uploaded' && (
                <button type="button" className="btn" disabled={pending} onClick={() => run(() => mapPlanAction(view.id, view.sheet ?? '', view.mapping))}>
                  Use this mapping
                </button>
              )}
              <button type="button" className="btn primary" disabled={pending || !!missing || view.status === 'uploaded'} onClick={() => run(() => previewPlanAction(view.id))}>
                Preview import →
              </button>
            </div>
          </section>
        </div>
      )}

      {previewing && (
        <section className="bh-sec" aria-label="Preview">
          <p className="bh-note">{from && to ? `${from} → ${to}` : 'No dated rows'}</p>
          <ul className="imp-tree">
            {bars.map((b) => (
              <li key={b.key} className={b.depth ? 'sub' : 'act'}>
                <span className="imp-tn">{b.depth ? '↳ ' : ''}{b.name}</span>
                {b.dated ? (
                  <span className="imp-track" aria-label={`${b.start} to ${b.finish ?? b.start}`}>
                    <span className="imp-bar" style={{ left: `${b.left}%`, width: `${b.width}%` }} />
                  </span>
                ) : <span className="imp-undated">no dates — fill them in the plan</span>}
              </li>
            ))}
          </ul>
          {view.warnings.length > 0 && (
            <div className="imp-warn">
              <strong>{view.warnings.length} row{view.warnings.length === 1 ? '' : 's'} to check after import.</strong> Warnings
              don&rsquo;t block — you can import now and fix them in the plan.
              <ul>{view.warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
            </div>
          )}
          <div className="imp-foot">
            {counts && (
              <span className="imp-counts">
                Actions {counts.actions} · Sub-actions {counts.sub_actions} · Dependencies {counts.links} · Trades {counts.trades}
              </span>
            )}
            <button type="button" className="btn" disabled={pending} onClick={() => run(() => mapPlanAction(view.id, view.sheet ?? '', view.mapping))}>
              Back to mapping
            </button>
            <button type="button" className="btn primary" disabled={pending || view.plan_exists}
              onClick={() => run(() => confirmPlanAction(projectId, view.id))}>
              {pending ? 'Importing…' : 'Confirm import →'}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
