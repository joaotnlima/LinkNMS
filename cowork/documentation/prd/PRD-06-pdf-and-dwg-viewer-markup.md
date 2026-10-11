# PRD-06 — 2D drawings: PDF and DWG viewer, markup and versions

| | |
|---|---|
| Status | Draft — for founder review |
| Date | 2026-10-10 |
| Validated against | `main` @ `18b0ec4` |
| Design boards | 3c · F5 PdfMarkup, F6 DwgView, Component · Sheet |
| Related decisions | D-41 (scope of "edit"), D-39 |
| Depends on | PRD-05 (files, links, versions) |

## 1. Problem

Many tasks have no model at all, only PDF sheets or DWG files. People need to:

- see them inside the task;
- point at a problem on a sheet;
- measure;
- turn a remark into a question or issue;

all without downloading the file and emailing screenshots.

**Principle.** LinkNMS does not author drawings. "Edit" for 2D means a **markup layer kept on the record**. The PDF or DWG bytes are never rewritten. A changed drawing is a new upload by its author.

## 2. Today (as-built)

There is no PDF viewer (no pdf.js), no DWG conversion and no markup or annotation anywhere. Files download via a presigned URL (`modules/documents`).

## 3. Goals

1. Open any PDF sheet or DWG layout in a modal from the Files tab, switch between the task's files without closing, and see sheets and layouts.
2. Mark up (cloud, arrow + note, text), measure with a calibrated scale, and turn a markup into an issue or question.
3. Saving markups creates a new version labelled **markups only**, so history stays honest.

### Non-goals

- Editing PDF or DWG content.
- Model (IFC) viewing (PRD-07).

## 4. Requirements

### 4.1 Shared viewer shell

| ID | Requirement | Priority |
|---|---|---|
| V-1 | Modal with a left rail: the task's files grouped by type, plus the sheets or layouts of the open file. A centre canvas. A right panel with markups (PDF) or layers and markups (DWG). | Must |
| V-2 | Header: type tag, name, version selector, View / Markup mode, tools, close. | Must |
| V-3 | Footer states what save does: "saving makes v{n+1} = same file + markups". | Must |

### 4.2 PDF (F5)

| ID | Requirement | Priority |
|---|---|---|
| V-4 | Render pages client-side. pdf.js is the usual choice: **confirm the licence and bundle size**. Multi-page: list every sheet, and markups pin to a page. | Must |
| V-5 | Tools: Cloud, Arrow + note, Text, Measure, Calibrate. | Must |
| V-6 | **Calibrate** per sheet, e.g. 1:50 on a known dimension. Until calibrated, Measure shows "not calibrated" and no units. | Must |
| V-7 | Overlay the previous version (two-colour diff) for "what changed". | Should |
| V-8 | Each markup: author, date, state (open/closed). It can become a **question to** a named party or an **issue** on the task. An issue can point at a PDF page, a DWG layout and a model element at once. | Must |
| V-9 | Read sheet titles and numbers from the title block on upload, with user confirmation. | Could |
| V-10 | "Upload revised PDF" creates a new version from the author. Markups on unchanged pages carry over. | Should |

### 4.3 DWG (F6)

| ID | Requirement | Priority |
|---|---|---|
| V-11 | Convert on upload, server-side, to a viewable format such as SVG or PDF per layout. Show "Making preview…" until it is ready. | Must |
| V-12 | Layout tabs (Model, sheet layouts), layer list with on/off (view-only), light/dark background, measure. | Must |
| V-13 | Banner: the preview is generated from the DWG, and the .dwg is never changed. | Must |
| V-14 | Failure state: "No preview, download only", with the reason when known, e.g. unsupported version or proxy objects. Also shown in the Files list (PRD-05 F-7). | Must |
| V-15 | Warnings: missing xrefs, substituted fonts. | Should |
| V-16 | Markup works on the preview exactly as on PDF. | Must |
| V-17 | DXF: same pipeline. | Should |

## 5. Data and API

- `documents.markup (id, document_id, version_no, page_or_layout, geometry jsonb, kind, text, author_person, author_org, created_at, state, issue_id null)`.
- Saving markups appends a `document_version` row with `change_kind='markup_only'` that points at the same `storage_key` and sha256 (no byte copy) plus a markup snapshot. Confirm that the append-only trigger allows a row that reuses a storage key.
- DWG pipeline: an async job on upload (the outbox pattern exists in `platform/outbox.mjs`) writes preview artefacts as derived objects with their own storage keys.

## 6. Acceptance criteria

1. A 4-sheet PDF opens on sheet 1; switching to sheet 3 keeps markups pinned to their pages.
2. Measure on an uncalibrated sheet shows no units. After calibrating on an 11 400 mm dimension, a measure of that dimension reads 11.40 m ±1%.
3. Saving 1 new markup on v2 creates v3 labelled "markups only"; the file bytes are unchanged (same sha256).
4. A DWG that fails conversion shows "No preview, download only" in both the Files list and the viewer and is still downloadable.

## 7. Decisions needed

> **Decided — D-49:** DWG via LibreDWG server-side (GPL: legal check before release). PDF client-side.

1. **DWG converter.** The options known to me are:
   - ODA Drawings SDK: commercial membership.
   - Autodesk Platform Services (formerly Forge) Model Derivative: paid per use.
   - LibreDWG: GPL.

   **I have not verified the current pricing or licence terms.** Check them before committing. GPL in a server process may be acceptable; it needs a legal check. If none fits, ship PDF first and keep DWG as download-only.
2. Should a markup-only save be a new **version number** (v3) or a revision of the markup layer (v2 · r3)? This PRD follows the founder's rule "save = new version" and labels it.
