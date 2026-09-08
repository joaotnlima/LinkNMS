'use client';

// D8 → D9 → D10, the Excel plan import (LINA-207).
//
// Pen: "Desktop — Bootstrap flow (lg)" › Band C › D8 file and sheet, D9 map the
// columns, D10 preview and confirm. Contract: §2 (the four routes) and §7.
//
// ── WHY THREE PEN SCREENS ARE ONE ROUTE ──────────────────────────────────────
// The contract is stateless server-side: the same file is re-sent on each step
// (§2), so the only copy of it lives in this component's `File` handle. Three
// URLs would mean three navigations, and a `File` does not survive one — the
// second screen would have to ask for the file again, or the server would have
// to stage the bytes, which §2 explicitly refuses to own. So the three screens
// are three states of one machine, and `step` is what the pen calls a screen.
//
// ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
// No xlsx parsing (contract §0 — the browser uploads bytes). No money columns:
// the pen's Qty / Unit price / Line total and its CONTRACT VALUE totals are B3
// (LINA-201), not in B1's six-field mapping — see the note in @/lib/plan-import.
// No `.xls` / `.csv`: the pen's dropzone offers all three, the frozen parser
// accepts exactly `.xlsx` (§1), and the picker says the rule the server will
// actually enforce rather than the one the mock drew.
//
// ── WARNINGS DO NOT BLOCK, ERRORS DO ─────────────────────────────────────────
// The pen's D9/D10 footers say unreadable rows "import as warnings … they do not
// block". The frozen BE disagrees, and it is the authority: `:confirm` rejects
// any tree with `errors.length > 0` (`validation_failed`, 400) while
// `warnings[]` pass through untouched. Drawing the pen's sentence would promise
// a Confirm that 400s. So this screen keeps the two piles visibly apart —
// warnings are advisory and Confirm stays live; errors disable Confirm and say
// which rows to fix — which is the same honesty the pen was reaching for, told
// against the parser that actually exists.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

import {
  EMPTY_MAPPING, LIMITS, PLAN_FIELDS, PlanImportError,
  assign, barGeometry, confirmImport, dateRange, fieldByColumn, formatBytes, ganttScale,
  inspectColumns, inspectSheets, missingRequired, preflight, preorder, previewImport,
  type ColumnInfo, type PlanField, type PlanMapping, type PreviewResult, type SheetInfo,
  type WireLimits,
} from '@/lib/plan-import';
import '@/components/plan-import.css';

type Step = 'file' | 'map' | 'preview';

const STEPS: { key: Step; n: number; label: string }[] = [
  { key: 'file', n: 1, label: 'File' },
  { key: 'map', n: 2, label: 'Map columns' },
  { key: 'preview', n: 3, label: 'Preview' },
];

// Fresh key per import attempt (contract §2). `randomUUID` is unavailable on
// http:// origins in some browsers, and an import that cannot start because the
// key generator is missing would be a strange way to fail — the fallback only
// needs to be unique per attempt, never unguessable.
const freshKey = (): string =>
  globalThis.crypto?.randomUUID?.()
  ?? `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

export function PlanImportWizard({ projectId, projectName }: { projectId: string; projectName: string }) {
  const router = useRouter();

  const [step, setStep] = useState<Step>('file');
  const [file, setFile] = useState<File | null>(null);
  const [limits, setLimits] = useState<WireLimits>(LIMITS);

  const [sheets, setSheets] = useState<SheetInfo[] | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  // The D8 failure. Kept beside the file row rather than replacing it: contract
  // §7 wants the file KEPT for retry, so a rejected workbook leaves the picker
  // populated and the sentence next to it.
  const [fileError, setFileError] = useState<PlanImportError | null>(null);

  const [columns, setColumns] = useState<ColumnInfo[] | null>(null);
  /** The sheet `columns` describes — see `goToMapping`. */
  const [mappedFor, setMappedFor] = useState<string | null>(null);
  const [rowCount, setRowCount] = useState(0);
  const [mapping, setMapping] = useState<PlanMapping>(EMPTY_MAPPING);
  const [loadingColumns, setLoadingColumns] = useState(false);

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<PlanImportError | null>(null);

  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<PlanImportError | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string>(freshKey);

  const fileInput = useRef<HTMLInputElement>(null);

  const missing = missingRequired(mapping);
  const mappingKey = JSON.stringify(mapping);

  // ── D8 · the file ──────────────────────────────────────────────────────────

  const takeFile = useCallback(async (picked: File) => {
    // Everything downstream describes the PREVIOUS file; drop it all before the
    // round trip so a slow :inspect can never render new sheets beside an old
    // mapping.
    setFile(picked);
    setSheets(null); setSheet(null); setColumns(null); setMappedFor(null); setPreview(null);
    setMapping(EMPTY_MAPPING); setPreviewError(null); setConfirmError(null);
    setFileError(null);

    const local = preflight(picked, limits);
    if (local) { setFileError(local); return; }

    setInspecting(true);
    try {
      const res = await inspectSheets(projectId, picked);
      setSheets(res.sheets);
      if (res.limits) setLimits({ ...LIMITS, ...res.limits });
      // Contract §0: never auto-pick when the workbook has more than one sheet.
      // Exactly one sheet is not a guess — there is nothing to choose between —
      // and it is still rendered as a checked radio, so what was picked is
      // visible either way.
      const usable = res.sheets.filter((s) => s.rowCount > 0);
      if (usable.length === 1 && res.sheets.length === 1) setSheet(usable[0].name);
    } catch (err) {
      setFileError(asPlanError(err));
      setSheets(null);
    } finally {
      setInspecting(false);
    }
  }, [projectId, limits]);

  // ── D9 · the columns ───────────────────────────────────────────────────────

  const goToMapping = useCallback(async () => {
    if (!file || !sheet) return;
    // Stepping BACK to check the file and forward again must not cost the GC the
    // mapping they just built. Only a different sheet (or a different file, which
    // `takeFile` already clears everything for) re-reads the columns.
    if (columns && mappedFor === sheet) { setStep('map'); return; }
    setLoadingColumns(true);
    setFileError(null);
    try {
      const res = await inspectColumns(projectId, file, sheet);
      setColumns(res.columns);
      setRowCount(res.rowCount);
      setMappedFor(sheet);
      if (res.limits) setLimits({ ...LIMITS, ...res.limits });
      setMapping(EMPTY_MAPPING); // nothing inferred (contract §0)
      setPreview(null);
      setStep('map');
    } catch (err) {
      setFileError(asPlanError(err));
    } finally {
      setLoadingColumns(false);
    }
  }, [projectId, file, sheet, columns, mappedFor]);

  // The live "stored shape" preview (contract §7, D9). Debounced because it
  // re-parses the whole workbook server-side on every assignment, and sequenced
  // because a slow early response must never overwrite a newer one.
  const seq = useRef(0);
  useEffect(() => {
    if (!file || !sheet || step === 'file') return;
    const map: PlanMapping = JSON.parse(mappingKey);
    if (missingRequired(map).length > 0) { setPreview(null); setPreviewError(null); return; }

    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      setPreviewing(true);
      try {
        const res = await previewImport(projectId, file, sheet, map);
        if (mine !== seq.current) return;
        setPreview(res);
        setPreviewError(null);
      } catch (err) {
        if (mine !== seq.current) return;
        setPreview(null);
        setPreviewError(asPlanError(err));
      } finally {
        if (mine === seq.current) setPreviewing(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [projectId, file, sheet, mappingKey, step]);

  // A NEW import attempt needs a NEW key; a RETRY of the same attempt must reuse
  // one, which is the whole point of §2's idempotency (a serverless retry after
  // a lost response returns the original import instead of writing it twice).
  // Changing the file, the sheet or the mapping makes it a different attempt.
  useEffect(() => { setIdempotencyKey(freshKey()); }, [file, sheet, mappingKey]);

  // ── D10 · confirm ──────────────────────────────────────────────────────────

  const doConfirm = useCallback(async () => {
    if (!file || !sheet || confirming) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const res = await confirmImport(projectId, file, sheet, mapping, idempotencyKey);
      // The stamp travels in the URL, not in this component's state: the plan
      // page is a server render and the audit event id is the thing the GC came
      // for ("who imported this plan, when"). `replace`, so Back does not return
      // to a wizard whose file is already committed.
      router.replace(`/projects/${projectId}/plan?imported=${encodeURIComponent(res.auditEventId)}`);
    } catch (err) {
      setConfirmError(asPlanError(err));
      setConfirming(false);
    }
  }, [projectId, file, sheet, mapping, idempotencyKey, confirming, router]);

  const errors = preview?.errors ?? [];
  const warnings = preview?.warnings ?? [];
  const canConfirm = Boolean(preview) && errors.length === 0 && !confirming;

  return (
    <div className="pi">
      <nav className="pi-crumbs" aria-label="Breadcrumb">
        <Link href={`/projects/${projectId}`}>{projectName}</Link>
        <span aria-hidden="true">›</span>
        <Link href={`/projects/${projectId}/plan`}>Plan</Link>
        <span aria-hidden="true">›</span>
        <span aria-current="page">Import plan</span>
      </nav>

      <ol className="pi-steps">
        {STEPS.map((s) => (
          <li
            key={s.key}
            className={`pi-step ${s.key === step ? 'is-current' : ''} ${s.n < currentN(step) ? 'is-done' : ''}`.trim()}
            aria-current={s.key === step ? 'step' : undefined}
          >
            <span className="pi-step-n" aria-hidden="true">{s.n}</span>
            <span className="pi-step-label">{s.label}</span>
          </li>
        ))}
      </ol>
      <p className="pi-steps-caption">
        Step {currentN(step)} of {STEPS.length} · {STEPS[currentN(step) - 1].label}
      </p>

      {step === 'file' ? (
        <FileStep
          file={file}
          limits={limits}
          sheets={sheets}
          sheet={sheet}
          inspecting={inspecting}
          loadingColumns={loadingColumns}
          error={fileError}
          fileInput={fileInput}
          onPick={takeFile}
          onSheet={setSheet}
          onContinue={goToMapping}
        />
      ) : null}

      {step === 'map' && columns ? (
        <MapStep
          columns={columns}
          rowCount={rowCount}
          sheet={sheet ?? ''}
          mapping={mapping}
          missing={missing}
          preview={preview}
          previewing={previewing}
          previewError={previewError}
          onAssign={(col, field) => setMapping((m) => assign(m, col, field))}
          onBack={() => setStep('file')}
          onContinue={() => setStep('preview')}
        />
      ) : null}

      {step === 'preview' ? (
        <PreviewStep
          preview={preview}
          previewing={previewing}
          previewError={previewError}
          confirmError={confirmError}
          confirming={confirming}
          canConfirm={canConfirm}
          warnings={warnings}
          errors={errors}
          onBack={() => setStep('map')}
          onConfirm={doConfirm}
        />
      ) : null}
    </div>
  );
}

const currentN = (step: Step) => STEPS.find((s) => s.key === step)!.n;

const asPlanError = (err: unknown): PlanImportError =>
  err instanceof PlanImportError
    ? err
    : new PlanImportError(0, err instanceof Error ? err.message : 'Something went wrong.', 'error');

// ── D8 ───────────────────────────────────────────────────────────────────────

function FileStep({
  file, limits, sheets, sheet, inspecting, loadingColumns, error, fileInput,
  onPick, onSheet, onContinue,
}: {
  file: File | null;
  limits: WireLimits;
  sheets: SheetInfo[] | null;
  sheet: string | null;
  inspecting: boolean;
  loadingColumns: boolean;
  error: PlanImportError | null;
  fileInput: React.RefObject<HTMLInputElement | null>;
  onPick: (f: File) => void;
  onSheet: (name: string) => void;
  onContinue: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const accepted = limits.acceptedExtension ?? LIMITS.acceptedExtension;

  return (
    <section className="pi-col">
      <div className="pi-head">
        <h1 className="pi-title">Bring your plan in</h1>
        <p className="pi-lede">
          The file is accepted before anything is interpreted, and you choose the sheet yourself —
          a workbook with several tabs is the norm, so which one holds the plan is not a guess the
          machine gets to make.
        </p>
      </div>

      <div
        className={`pi-drop ${dragging ? 'is-over' : ''}`.trim()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const dropped = e.dataTransfer.files?.[0];
          if (dropped) onPick(dropped);
        }}
      >
        <p className="pi-drop-title">Drop your plan here</p>
        <p className="pi-drop-sub">
          {accepted} only, up to {formatBytes(limits.maxFileBytes ?? LIMITS.maxFileBytes)} — or browse for it
        </p>
        <button type="button" className="btn" onClick={() => fileInput.current?.click()}>
          {file ? 'Choose another file' : 'Choose file'}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="pi-file-input"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            // Reset the input so re-picking the SAME file after a rejection still
            // fires a change event — otherwise "retry" silently does nothing.
            e.target.value = '';
            if (picked) onPick(picked);
          }}
        />
      </div>

      {file ? (
        <div className="pi-filerow">
          <div>
            <p className="pi-filename">{file.name}</p>
            <p className="pi-filemeta">
              {formatBytes(file.size)}
              {inspecting ? ' · reading…' : null}
              {sheets ? ` · ${sheets.length} sheet${sheets.length === 1 ? '' : 's'} found · read successfully` : null}
              {error ? ' · not read' : null}
            </p>
          </div>
          <button type="button" className="btn" onClick={() => fileInput.current?.click()}>Replace</button>
        </div>
      ) : null}

      {/* The file stays put on a refusal (contract §7): the sentence appears
          beside it and the same file can be re-picked or replaced. */}
      {error ? <p className="form-error" role="alert">{error.message}</p> : null}

      {sheets ? (
        <fieldset className="pi-sheets">
          <legend className="grp">Which sheet holds the plan?</legend>
          {sheets.map((s) => {
            const empty = s.rowCount === 0;
            return (
              <label key={s.name} className={`pi-sheet ${empty ? 'is-empty' : ''}`.trim()}>
                <input
                  type="radio"
                  name="sheet"
                  value={s.name}
                  disabled={empty}
                  checked={sheet === s.name}
                  onChange={() => onSheet(s.name)}
                />
                <span className="pi-sheet-b">
                  <span className="pi-sheet-name">{s.name}</span>
                  <span className="cap">{empty ? 'empty — nothing to import' : `${s.rowCount} data row${s.rowCount === 1 ? '' : 's'}`}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
      ) : null}

      <div className="pi-footer">
        {/* The starter workbook is generated from the parser's own rules
            (scripts/build-plan-template.mjs) so it cannot drift from what the
            server accepts. Its copy and branding are the Product Designer's to
            take over — contract §8 open item. */}
        <a className="btn" href="/plan-template.xlsx" download>Download our template</a>
        <button
          type="button"
          className="btn primary"
          disabled={!file || !sheet || inspecting || loadingColumns}
          onClick={onContinue}
        >
          {loadingColumns ? 'Reading columns…' : 'Map the columns'}
        </button>
      </div>
    </section>
  );
}

// ── D9 ───────────────────────────────────────────────────────────────────────

function MapStep({
  columns, rowCount, sheet, mapping, missing, preview, previewing, previewError,
  onAssign, onBack, onContinue,
}: {
  columns: ColumnInfo[];
  rowCount: number;
  sheet: string;
  mapping: PlanMapping;
  missing: PlanField[];
  preview: PreviewResult | null;
  previewing: boolean;
  previewError: PlanImportError | null;
  onAssign: (column: number, field: PlanField | null) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const byColumn = useMemo(() => fieldByColumn(mapping), [mapping]);
  const unmapped = columns.length - byColumn.size;
  const rows = useMemo(() => (preview ? preorder(preview.roots).slice(0, 8) : []), [preview]);

  return (
    <section className="pi-wide">
      <div className="pi-head">
        <h1 className="pi-title">What does each column mean?</h1>
        <p className="pi-lede">
          Sheet “{sheet}” · {rowCount} row{rowCount === 1 ? '' : 's'} · {columns.length} column
          {columns.length === 1 ? '' : 's'} detected. Nothing is guessed from a header — a column
          becomes part of the record only because you said what it is.
        </p>
        <div className="pi-chips">
          <span className={`badge ${missing.length ? 'warn' : 'ok'}`}>
            {missing.length
              ? `Missing: ${missing.map((f) => PLAN_FIELDS.find((p) => p.key === f)!.label).join(', ')}`
              : 'Required fields mapped'}
          </span>
          {unmapped > 0 ? (
            <span className="badge neutral">{unmapped} column{unmapped === 1 ? '' : 's'} not imported</span>
          ) : null}
          {preview && preview.errors.length > 0 ? (
            <span className="badge bad">{preview.errors.length} row problem{preview.errors.length === 1 ? '' : 's'}</span>
          ) : null}
        </div>
      </div>

      <div className="pi-panes">
        <div className="pi-pane">
          <p className="grp pi-pane-hdr">Column in your sheet</p>
          <ul className="pi-cols">
            {columns.map((c) => {
              const assigned = byColumn.get(c.index) ?? '';
              const id = `col-${c.index}`;
              return (
                <li key={c.index} className={`pi-colrow ${assigned ? 'is-mapped' : ''}`.trim()}>
                  <label htmlFor={id} className="pi-colinfo">
                    <span className="pi-colname">{c.header || <em>column {c.index}, no header</em>}</span>
                    <span className="pi-colsample">
                      {c.sampleValues.length ? c.sampleValues.slice(0, 2).join(' · ') : 'no values'}
                    </span>
                  </label>
                  <select
                    id={id}
                    className="pi-select"
                    value={assigned}
                    onChange={(e) => onAssign(c.index, (e.target.value || null) as PlanField | null)}
                  >
                    <option value="">Not imported</option>
                    {PLAN_FIELDS.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}{f.required ? ' (required)' : ''}
                      </option>
                    ))}
                  </select>
                </li>
              );
            })}
          </ul>
        </div>

        {/* The pane's whole point is that it CHANGES as you map (contract §7,
            "live stored shape preview"). A sighted user sees the table redraw;
            polite is what says so to everyone else, and it is polite rather than
            assertive because it must never interrupt the select you are still
            operating. */}
        <div className="pi-pane" aria-live="polite">
          <p className="grp pi-pane-hdr">
            How it will be stored
            <span className="cap"> · {previewing ? 'updating…' : 'updates as you map'}</span>
          </p>

          {missing.length > 0 ? (
            <p className="notice">
              Assign {missing.map((f) => PLAN_FIELDS.find((p) => p.key === f)!.label).join(', ')} to see
              what will be stored. Those three are what a stage IS — a name and the dates it runs.
            </p>
          ) : previewError ? (
            <p className="form-error" role="alert">{previewError.message}</p>
          ) : preview ? (
            <>
              <table className="pi-table">
                <caption className="cap">
                  First {rows.length} of {preview.stats.stageCount} stage{preview.stats.stageCount === 1 ? '' : 's'}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Action</th>
                    <th scope="col">Sub-action</th>
                    <th scope="col">Start</th>
                    <th scope="col">End</th>
                    <th scope="col">Trade</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ node, depth }) => (
                    <tr key={node.ref}>
                      <td>{depth === 0 ? node.action : <span className="pi-dash" aria-label="same action as above">—</span>}</td>
                      <td>{depth === 0 ? '' : node.action}</td>
                      <td className="num">{node.start ?? '—'}</td>
                      <td className="num">{node.end ?? '—'}</td>
                      <td>{node.trade ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="cap pi-tally">
                {preview.stats.rootCount} action{preview.stats.rootCount === 1 ? '' : 's'} ·{' '}
                {preview.stats.subActionCount} sub-action{preview.stats.subActionCount === 1 ? '' : 's'}
              </p>
            </>
          ) : (
            <p className="notice">Reading the sheet…</p>
          )}
        </div>
      </div>

      <div className="pi-footer">
        <button type="button" className="btn" onClick={onBack}>Back</button>
        <button
          type="button"
          className="btn primary"
          disabled={missing.length > 0 || !preview}
          onClick={onContinue}
        >
          Preview the import
        </button>
      </div>
    </section>
  );
}

// ── D10 ──────────────────────────────────────────────────────────────────────

function PreviewStep({
  preview, previewing, previewError, confirmError, confirming, canConfirm, warnings, errors,
  onBack, onConfirm,
}: {
  preview: PreviewResult | null;
  previewing: boolean;
  previewError: PlanImportError | null;
  confirmError: PlanImportError | null;
  confirming: boolean;
  canConfirm: boolean;
  warnings: string[];
  errors: string[];
  onBack: () => void;
  onConfirm: () => void;
}) {
  const rows = useMemo(() => (preview ? preorder(preview.roots) : []), [preview]);
  const scale = useMemo(() => (preview ? ganttScale(preview.roots) : null), [preview]);

  if (previewError) {
    return (
      <section className="pi-wide">
        <p className="form-error" role="alert">{previewError.message}</p>
        <div className="pi-footer">
          <button type="button" className="btn" onClick={onBack}>Back to mapping</button>
        </div>
      </section>
    );
  }
  if (!preview) {
    return <section className="pi-wide"><p className="notice">{previewing ? 'Reading the sheet…' : 'Nothing to preview yet.'}</p></section>;
  }

  return (
    <section className="pi-wide">
      <div className="pi-head">
        <h1 className="pi-title">This is what will be created</h1>
        <p className="pi-lede">
          Nothing has been written yet. Confirm records the whole import as one stamped event —
          who imported this plan and when — not {preview.stats.stageCount} silent rows.
        </p>
        <span className="badge warn">Not yet committed</span>
      </div>

      <div className="pi-stats">
        <div className="pi-stat">
          <span className="grp">Actions</span>
          <span className="pi-stat-n">{preview.stats.rootCount}</span>
        </div>
        <div className="pi-stat">
          <span className="grp">Sub-actions</span>
          <span className="pi-stat-n">{preview.stats.subActionCount}</span>
        </div>
        <div className="pi-stat">
          <span className="grp">Stages in total</span>
          <span className="pi-stat-n">{preview.stats.stageCount}</span>
        </div>
        <div className={`pi-stat ${errors.length ? 'is-bad' : warnings.length ? 'is-warn' : ''}`.trim()}>
          <span className="grp">Rows needing attention</span>
          <span className="pi-stat-n">{errors.length}</span>
        </div>
      </div>

      <div className="pi-plan card">
        <div className="pi-planhdr">
          <span className="grp pi-cell-name">Action / sub-action</span>
          <span className="grp pi-cell-trade">Trade</span>
          <span className="grp pi-cell-dates">Dates</span>
          <span className="grp pi-cell-gantt" aria-hidden="true">
            {scale ? scale.months.map((m) => <span key={m.key} className="pi-month">{m.label}</span>) : null}
          </span>
        </div>
        {rows.map(({ node, depth }) => {
          const bar = scale ? barGeometry(node, scale) : null;
          return (
            <div key={node.ref} className={`pi-planrow ${depth ? 'is-sub' : ''}`.trim()}>
              <span className="pi-cell-name">{node.action}</span>
              <span className="pi-cell-trade">{node.trade ? <span className="badge neutral">{node.trade}</span> : null}</span>
              <span className="pi-cell-dates num">{dateRange(node)}</span>
              <span className="pi-cell-gantt">
                {/* The bar is decoration for a fact the Dates column already
                    states in words — FR9's rule that colour is never the only
                    signal, applied to a chart. */}
                {bar ? (
                  <span className="pi-bar" aria-hidden="true" style={{ left: `${bar.left}%`, width: `${bar.width}%` }} />
                ) : null}
              </span>
            </div>
          );
        })}
      </div>

      {errors.length > 0 ? (
        <div className="pi-problems is-bad" role="alert">
          <p className="pi-problems-t">
            {errors.length} row{errors.length === 1 ? '' : 's'} must be fixed before this can be imported
          </p>
          <ul>{errors.slice(0, 8).map((e) => <li key={e}>{e}</li>)}</ul>
          {errors.length > 8 ? <p className="cap">…and {errors.length - 8} more.</p> : null}
          <p className="cap">
            Fix them in the spreadsheet and choose the file again, or go back and map a different
            column. The import is refused as a whole — a plan is not half-written.
          </p>
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div className="pi-problems is-warn">
          <p className="pi-problems-t">{warnings.length} thing{warnings.length === 1 ? '' : 's'} to know</p>
          <ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          <p className="cap">These do not block the import.</p>
        </div>
      ) : null}

      {confirmError ? <p className="form-error" role="alert">{confirmError.message}</p> : null}

      <div className="pi-footer">
        <button type="button" className="btn" onClick={onBack} disabled={confirming}>Back to mapping</button>
        <button type="button" className="btn primary" disabled={!canConfirm} onClick={onConfirm}>
          {confirming ? 'Importing…' : 'Confirm import'}
        </button>
      </div>
    </section>
  );
}
