'use client';

// The drawing viewer (PRD-06 V-1..V-17; boards F5 PdfMarkup, F6 DwgView): a
// modal over the plan or the project files. Left — the files around this one
// and the sheets / layouts of the open file (V-1). Centre — the sheet with its
// markup layer. Right — markups (PDF) or layers + markups (DWG). Header — type,
// name, version, View / Markup, tools (V-2). Footer — what saving does (V-3).
//
// LinkNMS never authors drawings: markups are drafts here until "Save markups",
// which appends a "markups only" version with the same bytes (server-side). A
// changed drawing is a new upload by its author ("Upload revised …", V-10).
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { FileView } from '@/lib/v2/task-files-view';
import { versionRefOf } from '@/lib/v2/task-workspace-view';
import {
  draftBody, draftMarkup, markupsOnSheet, overlayBase, previewReason, ratioLabel, saveFooter, sheetScale,
  versionOptions, type MarkupView, type Point,
} from '@/lib/v2/viewer-view';
import { saveMarkupsAction, markupStateAction, markupToQuestionAction, markupToIssueAction } from '@/lib/v2/viewer-actions';
import { MarkupLayer, type Tool } from './MarkupLayer';
import { MarkupPanel } from './MarkupPanel';
import { PdfSheet } from './PdfSheet';
import { DwgSheet } from './DwgSheet';
import { DwgLayers } from './DwgLayers';
import { ViewerRail } from './ViewerRail';
import { RevisedUpload } from './RevisedUpload';
import { useMarkups, usePreview, useQuestionParties, useViewUrl } from './use-viewer-data';
import './viewer.css';

const TOOLS: Array<{ tool: Tool; label: string }> = [
  { tool: 'cloud', label: 'Cloud' }, { tool: 'arrow', label: 'Arrow + note' }, { tool: 'text', label: 'Text' },
  { tool: 'measure', label: 'Measure' }, { tool: 'calibration', label: 'Calibrate' },
];

export function FileViewer({
  projectId, taskId, label, files: initialFiles, initialFileId, orgName, onClose, onChanged,
}: {
  projectId: string;
  /** The task the viewer was opened from — an issue is raised on it (V-8). */
  taskId: string | null;
  /** "Files on 2.5 Roofing" / "Files of this build". */
  label: string;
  files: FileView[];
  initialFileId: string;
  /** Names the screen already knows; the build's participants fill the rest. */
  orgName?: (id: string | null) => string | null;
  onClose: () => void;
  /** A save or an upload changed a file — the caller reloads its list. */
  onChanged: () => void;
}) {
  const [files, setFiles] = useState(initialFiles);
  useEffect(() => { setFiles(initialFiles); }, [initialFiles]);
  const [activeId, setActiveId] = useState(initialFileId);
  const file = files.find((f) => f.id === activeId) ?? files[0];
  const [versionNo, setVersionNo] = useState(file.version);
  // A new current version (a save, an upload) becomes the open one.
  useEffect(() => { setVersionNo(file.version); }, [file.id, file.version]);
  const [mode, setMode] = useState<'view' | 'markup'>('view');
  const [tool, setTool] = useState<Tool | null>(null);
  const [page, setPage] = useState('1');
  const [pages, setPages] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [drafts, setDrafts] = useState<MarkupView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{ tool: Tool; points: Point[]; value: string } | null>(null);
  const [overlay, setOverlay] = useState(false);
  const [dark, setDark] = useState(true);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const isPdf = file.fileType === 'pdf';
  const ref = versionRefOf(file.id, versionNo);
  const { markups: saved, setMarkups: setSaved, error: markupsError } = useMarkups(file.id, tick);
  const { url, error: urlError } = useViewUrl(isPdf ? ref : null);
  const base = isPdf && overlay ? overlayBase(file.versions, versionNo) : null;
  const { url: overlayUrl } = useViewUrl(base ? versionRefOf(file.id, base) : null);
  const { preview, error: previewError } = usePreview(isPdf ? null : ref);
  const parties = useQuestionParties(projectId);
  const nameOf = (id: string | null) => (id ? orgName?.(id) ?? parties.find((p) => p.orgId === id)?.name ?? null : null);

  const shaOf = useCallback((no: number) => file.versions.find((v) => v.version_no === no)?.sha256 ?? null, [file.versions]);
  const all = useMemo(() => [...saved, ...drafts], [saved, drafts]);
  const onSheet = markupsOnSheet(all, { page, versionNo, shaOf });
  const mmPerUnit = sheetScale(all, { page, versionNo, shaOf });
  const calibrations = all.filter((m) => m.kind === 'calibration' && m.page === page && (m.draft || (m.versionNo ?? 0) <= versionNo));
  const viewingCurrent = versionNo === file.version;
  // Markup needs something to draw on: a PDF, or a DWG/DXF whose preview is ready.
  const canMark = viewingCurrent && (isPdf || preview?.status === 'ready');
  const sheets = isPdf
    ? Array.from({ length: pages }, (_, i) => ({ key: String(i + 1), label: `${i + 1}` }))
    : (preview?.layouts ?? []).map((l) => ({ key: l.name, label: l.name }));
  const sheetCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of all) if (x.kind !== 'calibration' && (x.draft || (x.versionNo ?? 0) <= versionNo)) m.set(x.page, (m.get(x.page) ?? 0) + 1);
    return m;
  }, [all, versionNo]);
  const layout = preview?.layouts.find((l) => l.name === page) ?? preview?.layouts[0] ?? null;
  useEffect(() => { if (!isPdf && layout && layout.name !== page) setPage(layout.name); }, [isPdf, layout, page]);

  const confirmDiscard = () => drafts.length === 0 || window.confirm(`Discard ${drafts.length} unsaved markup${drafts.length === 1 ? '' : 's'}?`);
  function reset(next: FileView) {
    setActiveId(next.id); setVersionNo(next.version); setDrafts([]); setSelectedId(null); setPrompt(null);
    setPage('1'); setPages(0); setOverlay(false); setHidden(new Set()); setMode('view'); setTool(null); setMessage(null); setZoom(1);
  }
  const close = useCallback(() => { if (drafts.length === 0 || window.confirm('Close and discard the unsaved markups?')) onClose(); }, [drafts.length, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  const onPages = useCallback((n: number) => setPages(n), []);

  function drawn(t: Tool, points: Point[]) {
    if (t === 'cloud' || t === 'measure') { add(t, points, null, null); return; }
    setPrompt({ tool: t, points, value: '' });
  }
  function add(t: Tool, points: Point[], text: string | null, lengthMm: number | null) {
    const m = draftMarkup({ id: crypto.randomUUID(), kind: t, page, points, text, lengthMm });
    setDrafts((d) => [...d, m]);
    if (t !== 'calibration') setSelectedId(m.id);
  }
  function commitPrompt() {
    if (!prompt) return;
    if (prompt.tool === 'calibration') {
      const mm = Number(prompt.value.replace(/\s/g, '').replace(',', '.'));
      if (!Number.isFinite(mm) || mm <= 0) { setMessage('Enter the real length of that dimension in millimetres, e.g. 11400.'); return; }
      add('calibration', prompt.points, null, mm);
    } else {
      if (!prompt.value.trim()) return;
      add(prompt.tool, prompt.points, prompt.value, null);
    }
    setPrompt(null); setMessage(null);
  }

  async function save() {
    setBusy(true); setMessage(null);
    const res = await saveMarkupsAction(file.id, file.version, drafts.map(draftBody));
    setBusy(false);
    if (!res.ok) { setMessage(res.message); return; }
    setFiles((fs) => fs.map((f) => (f.id === file.id ? res.value.file : f)));
    setSaved((s) => [...s, ...res.value.markups]);
    setDrafts([]); setVersionNo(res.value.file.version); setTool(null); setMode('view');
    setMessage(`Saved as v${res.value.file.version} — markups only, same file.`);
    onChanged();
  }
  async function act(fn: () => Promise<{ ok: true; value: MarkupView } | { ok: false; message: string }>) {
    setBusy(true); setMessage(null);
    const res = await fn();
    setBusy(false);
    if (!res.ok) { setMessage(res.message); return; }
    setSaved((s) => s.map((m) => (m.id === res.value.id ? res.value : m)));
  }

  const ratio = ratioLabel(mmPerUnit, file.fileType);
  const what = isPdf ? 'PDF' : file.fileType === 'dxf' ? '.dxf' : '.dwg';
  const failed = !isPdf && preview?.status === 'unavailable';
  const loadError = markupsError ?? urlError ?? previewError;
  const layer = (box: Parameters<typeof MarkupLayer>[0]['box']) => (
    <MarkupLayer box={box} markups={onSheet} calibrations={calibrations} mmPerUnit={mmPerUnit}
      tool={mode === 'markup' && canMark ? tool : null} selectedId={selectedId} onSelect={setSelectedId} onDrawn={drawn} />
  );

  return (
    <div className="vw-scrim" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <section className="vw" role="dialog" aria-modal="true" aria-label={`${file.title} — ${mode === 'markup' ? 'markup' : 'view'}`}>
        <header className="vw-top">
          <div className="vw-row">
            <i className={`ft is-${file.fileType}`}>{file.tag}</i>
            <b className="vw-title">{file.title}</b>
            <select className="vw-vsel" aria-label="Version" value={versionNo}
              onChange={(e) => { if (confirmDiscard()) { setDrafts([]); setVersionNo(Number(e.target.value)); setMode('view'); } }}>
              {versionOptions(file.versions, file.version).map((v) => <option key={v.versionNo} value={v.versionNo}>{v.label}</option>)}
            </select>
            <div className="vw-mode" role="group" aria-label="Mode">
              <button type="button" className={mode === 'view' ? 'is-on' : ''} aria-pressed={mode === 'view'} onClick={() => { setMode('view'); setTool(null); }}>View</button>
              <button type="button" className={mode === 'markup' ? 'is-on' : ''} aria-pressed={mode === 'markup'} disabled={!canMark}
                title={viewingCurrent ? undefined : 'Markups are added on the current version'} onClick={() => setMode('markup')}>Markup</button>
            </div>
          </div>
          <div className="vw-row">
            {!isPdf && preview && preview.layouts.length > 1 ? (
              <div className="vw-mode" role="tablist" aria-label="Layouts">
                {preview.layouts.map((l) => (
                  <button key={l.name} type="button" role="tab" aria-selected={l.name === page} className={l.name === page ? 'is-on' : ''} onClick={() => setPage(l.name)}>{l.name}</button>
                ))}
              </div>
            ) : null}
            {mode === 'markup' ? TOOLS.map((t) => (
              <button key={t.tool} type="button" className={`vw-tool${tool === t.tool ? ' is-on' : ''}`} aria-pressed={tool === t.tool}
                onClick={() => setTool(tool === t.tool ? null : t.tool)}>
                {t.tool === 'calibration' && ratio ? `Calibrate ${ratio}` : t.label}
              </button>
            )) : (
              <button type="button" className="vw-tool" disabled={!canMark} onClick={() => { setMode('markup'); setTool('measure'); }}>Measure</button>
            )}
            {isPdf && overlayBase(file.versions, versionNo) ? (
              <button type="button" className={`vw-tool${overlay ? ' is-on' : ''}`} aria-pressed={overlay} onClick={() => setOverlay(!overlay)}>
                Overlay v{overlayBase(file.versions, versionNo)}
              </button>
            ) : null}
            {!isPdf ? <button type="button" className="vw-tool" aria-pressed={!dark} onClick={() => setDark(!dark)}>Light / dark</button> : null}
            <a className="vw-tool" href={file.downloadPath ?? undefined} target="_blank" rel="noreferrer">Download {what}</a>
            <button type="button" className="btn sm" aria-label="Close" onClick={close}>✕</button>
          </div>
        </header>

        <div className="vw-body">
          <ViewerRail label={label} files={files} activeId={file.id} sheets={sheets} page={page} sheetCounts={sheetCounts}
            onOpen={(f) => { if (f.id !== file.id && confirmDiscard()) reset(f); }} onPage={setPage} />

          <div className={`vw-centre${mode === 'markup' ? ' is-markup' : ''}`}>
            {!isPdf && !failed ? (
              <div className="vw-banner" role="note">
                <span aria-hidden="true">ⓘ</span>
                <span>Preview generated from the {what} when it was uploaded. Measure and markup work on this preview; the {what} is never changed. To change the drawing, its author uploads a new {what} — it becomes v{file.version + 1}.</span>
              </div>
            ) : null}
            {prompt ? (
              <form className="vw-prompt" onSubmit={(e) => { e.preventDefault(); commitPrompt(); }}>
                <label htmlFor="vw-prompt">{prompt.tool === 'calibration' ? 'Real length of this dimension (mm)' : prompt.tool === 'arrow' ? 'Note for the arrow' : 'Text'}</label>
                <input id="vw-prompt" className="vw-input" autoFocus value={prompt.value} inputMode={prompt.tool === 'calibration' ? 'decimal' : undefined}
                  placeholder={prompt.tool === 'calibration' ? '11400' : ''} onChange={(e) => setPrompt({ ...prompt, value: e.target.value })} />
                <button type="submit" className="btn sm primary">Add</button>
                <button type="button" className="btn sm" onClick={() => setPrompt(null)}>Cancel</button>
              </form>
            ) : null}
            {loadError ? <p role="alert" className="vw-stage-note">{loadError}</p> : null}
            {isPdf && url ? (
              <PdfSheet url={url} overlayUrl={overlay ? overlayUrl : null} pageNo={Number(page) || 1} zoom={zoom} onPages={onPages}>{layer}</PdfSheet>
            ) : null}
            {!isPdf && preview?.status === 'pending' ? <p className="vw-stage-note" role="status">Making preview…</p> : null}
            {failed ? (
              <div className="vw-stage-note is-warn" role="status">
                <b>No preview, download only.</b>
                {previewReason(preview?.reason) ? <span> The reason: {previewReason(preview?.reason)}.</span> : null}
                <a className="btn sm" href={file.downloadPath ?? undefined} target="_blank" rel="noreferrer">Download {what}</a>
              </div>
            ) : null}
            {!isPdf && layout && preview?.status === 'ready' ? (
              <DwgSheet url={layout.view_url} zoom={zoom} dark={dark} hiddenLayers={hidden}>{layer}</DwgSheet>
            ) : null}
            <div className="vw-zoom">
              <button type="button" className="vw-tool" onClick={() => setZoom((z) => Math.max(0.5, z / 1.25))} aria-label="Zoom out">−</button>
              <span className="vw-note">{Math.round(zoom * 100)}%{isPdf && pages ? ` · ${page} / ${pages}` : ''}</span>
              <button type="button" className="vw-tool" onClick={() => setZoom((z) => Math.min(6, z * 1.25))} aria-label="Zoom in">+</button>
              <span className="vw-note">{mmPerUnit ? `Scale ${ratio ?? 'set'} · calibrated` : 'Not calibrated — measures show no units'}</span>
            </div>
          </div>

          <aside className="vw-props">
            {!isPdf && preview?.status === 'ready' ? (
              <DwgLayers preview={preview} layout={page} hidden={hidden}
                onToggle={(name, on) => setHidden((h) => { const n = new Set(h); if (on) n.delete(name); else n.add(name); return n; })} />
            ) : null}
            <MarkupPanel title={`Markups on ${isPdf ? `sheet ${page}` : page}`} markups={onSheet} mmPerUnit={mmPerUnit}
              selectedId={selectedId} parties={parties} orgName={nameOf} issueOn={taskId ? 'the task' : 'the build'} busy={busy}
              onSelect={setSelectedId} onRemoveDraft={(id) => setDrafts((d) => d.filter((m) => m.id !== id))}
              onState={(m, action) => void act(() => markupStateAction(m.id, action))}
              onAsk={(m, to, text) => void act(() => markupToQuestionAction({ markupId: m.id, documentId: file.id, addresseeOrgId: to, text }))}
              onIssue={(m, text, severity) => void act(() => markupToIssueAction({ markupId: m.id, projectId, taskId, text, severity }))} />
            {message ? <p className="vw-note" role="status">{message}</p> : null}
          </aside>
        </div>

        <footer className="vw-foot">
          <span className="vw-note">
            {viewingCurrent ? saveFooter(file.version, drafts.length, file.fileType) : `Viewing v${versionNo} · markups are added on the current version (v${file.version})`}
          </span>
          <div className="vw-row">
            <RevisedUpload projectId={projectId} file={file} label={`Upload revised ${what} (v${file.version + 1})`}
              onUploaded={() => { setMessage(`Uploaded — it becomes v${file.version + 1} once processed.`); setTick((t) => t + 1); onChanged(); }}
              onError={setMessage} />
            {drafts.length ? <button type="button" className="btn" onClick={() => { if (confirmDiscard()) setDrafts([]); }}>Discard</button> : null}
            <button type="button" className="btn primary" disabled={!drafts.length || busy || !viewingCurrent} onClick={() => void save()}>
              Save markups as v{file.version + 1}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
