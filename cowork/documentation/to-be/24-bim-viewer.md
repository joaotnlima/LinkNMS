# 24 — BIM viewer (IFC 3D) and the shared project model

**Status:** Accepted (D-41), **amended by D-45** (2026-10-10, PRD-07): the model is now the **build's**
(project scope), read by every participant at `/projects/{id}/model`, and awarded companies **edit
record-side only** — element ↔ task links, issue pins and new versions by upload. LinkNMS never writes
into the IFC. Opened by the Architect for **LINA-409**; §"Shared project model (PRD-07)" below supersedes
the RFP-only scope where they differ.
**Scope:** a read-only, in-browser IFC 3D viewer embedded in the **project (design) RFP** package, so
specialties can *see* the building model before pricing. It does **not** design model authoring,
versioning, federation, clash-check, or award-time edit rights — that is the "collaborative authoring"
epic the founder explicitly deferred (result #2 of LINA-406, future epic, own ADR + budget).

Related: [06 — Tendering & contracting](./06-tendering-and-contracting.md),
[23 — Design tendering](./23-design-tendering.md) (the phase this viewer serves),
[08 — Supporting domains](./08-supporting-domains.md) (the Documents module),
[04 — Visibility & access](./04-visibility-and-access.md) (the invite-only / open rule),
[11 — API conventions](./11-api-conventions.md).

## Why this document exists

In design tendering ([23](./23-design-tendering.md)) the deliverable being priced is *the project
itself* — drawings and a material specification — modelled as an **IFC** file (`.ifc`). Today that file
can only ride along the RFP as a **download attachment**: a bidder must own desktop BIM software to open
it. The founder chose the cheaper of the two LINA-406 options — a **view-only web viewer** embedded in
the RFP — over full collaborative authoring. This document locks the technology, the loading strategy,
the file limits, where the IFC lives, the new read surfaces, and the three UI mount points, so the work
can be decomposed and built against a fixed contract.

## Decisions locked here

| # | Decision |
|---|---|
| 1 | **Renderer:** [`web-ifc`](https://github.com/ThatOpen/engine_web-ifc) (WASM IFC parser) + **Three.js** (`three`) + `OrbitControls`. Client-only. No `@thatopen/components` umbrella — we drive Three.js directly to keep the bundle lean and the surface small for a view-only tool. |
| 2 | **The IFC is a Documents-module document**, `kind = 'bim'`. *(D-45, 0019)* It is the **build's** model: `scope_type = 'project'`, `is_project_model`, one live per project. RFPs **reference** it (`tendering.rfp.model_document_id` + an optional pinned `model_version_no`) instead of owning one; 0019 migrated the LINA-409 RFP models. |
| 3 | **Authorization lives in the tendering module**, not Documents. New RFP-model routes reuse `requireRfpRead` / issuer checks (`modules/tendering`), and delegate persistence + storage to the injected Documents store/storage. The Documents module is **not** taught the RFP invite-only/open rule. |
| 4 | **Byte delivery = short-TTL presigned *inline* GET**, minted only after the authorization check passes, returned as JSON (`{ url, expiresAt }`) — not a 302. R2 bucket CORS is configured once for the app origins so the browser `fetch(...).arrayBuffer()` succeeds. We do **not** stream bytes through our origin (serverless size/duration limits, egress cost). |
| 5 | **Parsing is lazy — nothing loads until the reader clicks "Load 3D model".** As built, the web-ifc WASM parse runs on the main thread behind that explicit click (with a "Loading…" state and a "large model" notice >50 MB), not in a Web Worker. The worker was scoped out of Phase 1: it is a pure performance refinement (the main thread blocks only during the one deliberate parse, never on page load), adds Next worker-bundling complexity, and changes nothing a bidder can do. It is the first optimisation if a real model proves too heavy — tracked as a future refinement, not a gap in the view-only capability. |
| 6 | **File limits:** upload cap **100 MB** per `.ifc`; the viewer shows a "large model" notice above ~50 MB. IFC only (`application/x-step` / `.ifc`); other model formats are out of scope. |
| 7 | **The IFC bytes are never written.** *(D-45)* The only "edits" are record-side (links, pins), saved as a new version that re-points the same bytes; a new `.ifc` comes only by upload from the model's author. |

## Where the IFC lived in Phase 1 (LINA-409, superseded by 0019)

`documents.document` (`db/v2/0001_schema.sql:756-778`) already carries:

- `scope_type` includes `'rfp'`; `scope_id` = the RFP id.
- `kind` includes `'bim'`.
- `document_version` holds `storage_key`, `mime`, `size_bytes`, `sha256`, uploader org/person.

So attaching the model is: **create a `bim` document scoped to the RFP → presigned PUT to R2 → complete**
— the exact reserve→PUT→complete flow the `RecordOfflineForm` already uses against the Documents module
(`app/src/lib/v2/tendering.ts:315-351`). Storage is R2 (ADR-0021 / [08](./08-supporting-domains.md)),
`createR2ObjectStorage` in `modules/documents/infra/storage.mjs`.

## Authorization — one rule, reused

The RFP read rule already exists and is the single source of truth; the model inherits it verbatim:

> `requireRfpRead` (`modules/tendering/application/use-cases.mjs:1102-1117`): the **issuer** reads it;
> otherwise an **invited** recipient (`store.isRecipient`) reads it, or anyone if the RFP is
> **`open` and `published`**. Non-readers get **404** (existence hiding), never 403.

- **Authenticated** surfaces (owner inbox, marketplace editor) → `requireRfpRead(rfpId, viewer)`.
- **Public token** surface (`/rfp/[token]`) → the **token is the authority**; resolve the RFP by token
  (`getRfpByToken`, uniform `not_found` for unknown/revoked/expired) and apply the same invite-only/open
  gate. The token is **never put on the wire to R2** — the presigned URL is minted server-side after the
  gate and only the time-limited URL reaches the browser. `/rfp/:path*` already sends
  `Referrer-Policy: no-referrer` (`app/next.config.mjs`).
- **Attach / replace** the model → **issuer only** (`canEdit`-equivalent in tendering), while the RFP is
  in a state where its package is still editable (draft / pre-publish per [09](./09-state-machines.md)).

## API surface (net-new, on `/api/v2`)

All routes follow [11 — API conventions](./11-api-conventions.md) and mount through the tendering module
(`modules/tendering/http/register.mjs`). The registry injects the Documents `store` + `storage` into
tendering (new dep) so tendering owns the authorization and Documents owns persistence/storage.

| Method & path | Op | Auth | Returns |
|---|---|---|---|
| `POST /rfps/{rfpId}/model` | `reserveRfpModel` | issuer | presigned PUT ticket (reserve) |
| `POST /rfps/{rfpId}/model/{documentId}:complete` | `completeRfpModel` | issuer | the stored model descriptor |
| `DELETE /rfps/{rfpId}/model/{documentId}` | `removeRfpModel` | issuer | 204 |
| `GET /rfps/{rfpId}/model/{documentId}:view-url` | `rfpModelViewUrl` | `requireRfpRead` | `{ url, expiresAt }` (presigned **inline** GET) |
| `GET /rfp-links/{token}/model/{documentId}:view-url` | `rfpModelViewUrlByToken` | token + invite/open gate | `{ url, expiresAt }` (presigned **inline** GET) |

The RFP **package projection gains the model list** so the three surfaces can render without an extra
round trip. Extend `packageBody` / `getRfp` / `getRfpByToken` / `rfpLinkView`
(`modules/tendering/domain/wire.mjs`) with:

```jsonc
"models": [
  {
    "documentId": "uuid",
    "version": 1,
    "fileName": "casa-silva.ifc",
    "mime": "application/x-step",
    "sizeBytes": 18234112,
    "sha256": "…"
  }
]
```

### Storage change — inline disposition

`storage.signDownload` currently forces `ResponseContentDisposition: attachment` (`storage.mjs:77`). Add
an option `disposition: 'inline' | 'attachment'` (default keeps `attachment`, so existing
download routes are unchanged). The two `:view-url` routes pass `inline`.

### R2 CORS (one-time infra)

The browser must `fetch` the presigned URL cross-origin and read it as an `ArrayBuffer`, so the R2 bucket
needs a CORS rule allowing `GET` from `https://portal.linknms.com`, `https://dev.portal.linknms.com`, the
Vercel preview origin, and `http://localhost:3000`, exposing `ETag`/`Content-Length`. We hold the R2 S3
credentials, so this is applied programmatically via `PutBucketCors` (a small script in `scripts/`), not
a founder-gated dashboard task.

## Loading strategy (the viewer)

1. Fetch the model descriptor from the package projection (`models[0]`), then the `:view-url` for its
   `documentId`.
2. `fetch(url)` → `ArrayBuffer`. Enforce the client-side size notice.
3. Hand the buffer to **web-ifc** (main thread, behind the explicit "Load 3D model" click — see
   decision 5); parse and extract geometry, grouping meshes by **IFC category** (`IfcWall`, `IfcSlab`,
   …) — the category is the "discipline" dimension a bidder isolates. Geometry is merged into one
   `BufferGeometry` per (category, colour) to keep the mesh count — and WebGL cost — low.
4. Add meshes to a Three.js scene; `OrbitControls` for orbit / pan / zoom; fit-to-bounds on load.
5. Build a **category tree** → isolate / hide toggles (client-only, no write-back).
6. **Measure:** basic point-to-point distance (two picked points → world-space Euclidean distance).
7. Dispose geometry + worker on unmount; abort in-flight fetch on route change.

web-ifc ships a `web-ifc.wasm` asset. It is **client-only** — never import it in a server component or a
module under `serverExternalPackages`. The WASM path is configured via web-ifc's `SetWasmPath` pointing
at a copied-to-`public/` asset (see the FE slice spec) so Next's bundler does not try to trace it.

## The three mount points

| Surface | File | Today | Change |
|---|---|---|---|
| Owner inbox | `app/src/components/ProcurementSection.tsx` (`ProposalsInbox`) | no document shown | render the viewer for `package.models[0]` via the authed `:view-url` |
| Public token form | `app/src/app/rfp/[token]/page.tsx` + a `'use client'` viewer island | BoQ table only | render the viewer via the **token** `:view-url` |
| Marketplace composer | `ProcurementSection.tsx` (`Composer` / `DraftEditor`) | no attach control | **attach / replace `.ifc`** (reserve→PUT→complete) + inline preview |

The composer is where the owner **attaches** the model; the inbox and public form are **read-only**
consumers. When LINA-407 lands, the viewer replaces the download link in the RFP package.

## Out of scope (future epic — do not build here)

Model authoring (writing the IFC), real-time co-editing (Yjs/Hocuspocus), per-discipline federation,
clash-check (LINA-406 result #2). Any of these requires its own ADR, budget and founder approval.
Award-time **record-side** edit rights and versioning are now in scope — see "Shared project model" below.

## Decomposition (LINA-409 children)

- **A — BE (Back-End Dev):** storage `disposition` option + R2 CORS script; the five RFP-model routes;
  package-projection `models[]`; authorization via `requireRfpRead` / issuer; tests. Independent.
- **B — FE (Frontend Dev):** the `<IfcViewer>` client component (web-ifc + Three.js + Worker), deps,
  WASM asset wiring, a dev harness with a sample `.ifc`. Independent of A.
- **C — FE integration (Frontend Dev):** mount the viewer in the three surfaces + the owner attach/replace
  control. Depends on A (routes/projection) and B (component).

**Done (epic):** viewer merged to `main`, visible read-only in the project RFP package across all three
surfaces, honouring invite-only/open visibility, with this document registered.

## Shared project model (PRD-07, D-45)

**Where it lives.** `documents.document` with `scope_type='project'`, `kind='bim'`, `is_project_model`
(0019). Author = the org whose upload is v1. Every participant reads it (V1/V6); bidders who are not
participants see it only through the RFP that references it, under the RFP read rule above (M-7).

**Record-side data (Documents).** `documents.element_link` (GlobalId ↔ task, `added_in_version` /
`removed_in_version`) and `documents.element_pin` (an issue on 1–200 GlobalIds naming ≤ 20 tasks). Owned by
Documents because a record edit *is* a model version — the links, the pins and the version commit in one
transaction with the ledger entry; planning remains the one writer of rows and of the D-33 scope, answering
through its task port (`modelScopes`). Pins are not Quality non-conformities: an issue here spans several
elements and tasks during design and has no verification lifecycle.

**Edit scope (M-8/M-9, server-side).** Author and owner: the whole model. Every other org: elements already
linked to rows in its live D-33 edit scope (GC: its branch; an awarded company: its awarded rows), closed when
the contract is cancelled, terminated or closed. Only the author uploads a new `.ifc`; author and owner restore.

**Saving (M-11..M-14).** The draft lives in the browser until saved. `POST /projects/{id}/model:save`
appends `change_kind: edit`, `base_version_no` = the draft's base, re-pointing the current bytes; a required
note; ledgered + `documents.model.edited` (the author is notified when someone else saved). Concurrent drafts
merge per element: untouched elements apply on top of the latest version; an element changed since the base
answers 409 with `conflicts[]` until the caller chooses `mine`/`theirs` per element.

**Versions (M-15..M-18).** History from `Document.versions` (`upload` / `edit` / `restore`). Restore vN
appends v(n+1) over vN's bytes and re-applies vN's links (pins stay). Compare: record changes from
`/model/record-diff`; file changes (added / removed / properties changed by GlobalId) computed in the viewer
from the two IFC files. A new upload keeps links and pins (GlobalId-keyed); the viewer lists linked elements
missing from the new file and warns when an export regenerated its GlobalIds.

**Viewer.** `ifc-loader` keeps per-element geometry — still one merged buffer per IFC class (batched draw
calls), with per-element vertex ranges and vertex colours, so picking (face → element), highlight, colour by
task / status / who edits and isolate (`?task=`) recolour ranges instead of adding meshes. Components:
`app/src/components/model/`.

**Still out of scope.** IFC property editing and dimensional-property warnings (M-10 properties, M-13),
geometry authoring, federation, clash detection, server-side IFC parsing.

