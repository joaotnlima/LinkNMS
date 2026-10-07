# 24 — BIM viewer (IFC 3D, view-only)

**Status:** Accepted (D-41) — founder chose `viewer` (IFC 3D view-only inside the RFP) on the LINA-406
depth question, 2026-10-06. Opened by the Architect for **LINA-409**.
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
| 2 | **The IFC is a Documents-module document**, `scope_type = 'rfp'`, `kind = 'bim'`. **No schema change** — `db/v2/0001_schema.sql` already models both. One model per RFP for Phase 1 (the schema allows many; the UI surfaces the first `bim` document). |
| 3 | **Authorization lives in the tendering module**, not Documents. New RFP-model routes reuse `requireRfpRead` / issuer checks (`modules/tendering`), and delegate persistence + storage to the injected Documents store/storage. The Documents module is **not** taught the RFP invite-only/open rule. |
| 4 | **Byte delivery = short-TTL presigned *inline* GET**, minted only after the authorization check passes, returned as JSON (`{ url, expiresAt }`) — not a 302. R2 bucket CORS is configured once for the app origins so the browser `fetch(...).arrayBuffer()` succeeds. We do **not** stream bytes through our origin (serverless size/duration limits, egress cost). |
| 5 | **Parsing runs in a Web Worker** (web-ifc WASM) so a large model never blocks the main thread; geometry is streamed into the scene in batches. |
| 6 | **File limits:** upload cap **100 MB** per `.ifc`; the viewer shows a "large model" notice above ~50 MB. IFC only (`application/x-step` / `.ifc`); other model formats are out of scope. |
| 7 | **Read-only, always.** No route writes to the model. The viewer never mounts an edit affordance. |

## Where the IFC lives (data model — no change)

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
3. Hand the buffer to **web-ifc in a Web Worker**; parse and extract geometry + property sets
   (`IfcBuildingStorey`, discipline via `IfcProject`/`IfcRelDefinesByProperties` where present).
4. Stream meshes into a Three.js scene in batches (keep the main thread responsive); `OrbitControls`
   for orbit / pan / zoom; fit-to-bounds on load.
5. Build a **discipline / storey tree** from property sets → isolate / hide toggles (client-only, no
   write-back).
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

Model editing / authoring, collaborative versioning (Yjs/Hocuspocus), per-discipline federation,
clash-check, award-time edit rights (LINA-406 result #2). Any of these requires its own ADR, budget and
founder approval.

## Decomposition (LINA-409 children)

- **A — BE (Back-End Dev):** storage `disposition` option + R2 CORS script; the five RFP-model routes;
  package-projection `models[]`; authorization via `requireRfpRead` / issuer; tests. Independent.
- **B — FE (Frontend Dev):** the `<IfcViewer>` client component (web-ifc + Three.js + Worker), deps,
  WASM asset wiring, a dev harness with a sample `.ifc`. Independent of A.
- **C — FE integration (Frontend Dev):** mount the viewer in the three surfaces + the owner attach/replace
  control. Depends on A (routes/projection) and B (component).

**Done (epic):** viewer merged to `main`, visible read-only in the project RFP package across all three
surfaces, honouring invite-only/open visibility, with this document registered.
