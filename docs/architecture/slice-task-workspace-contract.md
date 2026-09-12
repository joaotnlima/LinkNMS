# Slice LINA-249 — Task workspace v1: per-stage comments, attachments, stable stage identity

- **Status:** Frozen (build against this) — 2026-09-12
- **Author:** Full-Stack Architect (Technical Lead)
- **Issue:** LINA-249 · **Parent:** LINA-204
- **Anchors:** ADR-0002 (hash chain — comments are NOT ledger events), ADR-0004
  (permissions), ADR-0005 (schedule service), ADR-0006 (service isolation, grants).
- **Pen screens:** task drawer / task workspace (comment thread + file list on a
  schedule task).

This doc freezes the data model and API contract for the **task workspace** v1:
a per-stage comment thread and a per-stage file list on plan tasks, alongside the
**stable stage identity** change (`schedule.stage.key`) that anchors them. The
delegated **BE** builds the migration, the store, and the service; the **FE**
builds the two surfaces against the wire shapes below.

## 0. Non-negotiables

- **Anchor by key, not row id.** Plan tasks get a stable, client-minted `key`
  per WBS node. Workspace rail fetches address a stage **by key**, so the
  annotation rails survive stage row churn (re-saves delete + reinsert stages as
  new UUIDs). The key column is the anchor; the FK-ish relationship is enforced
  at the service layer (append-time stage liveness), not by a hard FK.
- **Comments are chatter, not agreement change.** A comment is **NOT** appended
  to the hash chain (ADR-0002). The ledger is for what was agreed, what changed,
  and what it cost — a comment changes nothing. No ledger grant is added.
- **Append-only.** Both rails only grow. No edit, no delete in v1. A typo earns
  a new comment. This is deliberate: it keeps the workspace honest and removes an
  entire class of moderation/audit surface for a v1.
- **Members only, both rails shared.** Any project member may read or write
  either rail. This is shared build context — *not* a private draft. There is no
  party scoping.
- **Actor is server-derived.** The acting party comes from the session (`ctx`
  actor, ADR-0004), never the body. A client-supplied "author"/"uploader" field
  is rejected or ignored (see §4).
- **Content types are sniffed server-side.** Browser-declared file types are
  never trusted for the allowlist. The server re-derives the type from magic
  bytes.

## 1. Stable stage identity — `schedule.stage.key`

Stage keys are client-minted in the authoring surface and already appear in the
plan document today, but the key was **never persisted** — it was used only to
resolve `dependsOn` at author time, and re-saving stages minted fresh UUIDs. The
workspace rail needs a stable address, so this slice persists it.

Migration `services/schedule/migrations/0011_task_workspace.sql`:

```sql
ALTER TABLE schedule.stage ADD COLUMN key text
  CHECK (char_length(key) <= 200);
CREATE INDEX stage_key_project_idx ON schedule.stage (project_id, key, plan_version_id);
```

Collected rules:

- `key` is `NULL`able (import-seeded and legacy stages have none), `≤ 200`
  characters, **unique only per `(project_id, key, plan_version_id)`**, enforced
  by the index above (service-level liveness keeps read/latest-write selection
  deterministic: see `stageLiveByKey`).
- `insertAuthoredStages` persists `node.key ?? null` (the `:author` payload row
  now carries the key). The `stageTree` read shape already emits `key`; the plan
  document contract gains an authoritative `key` on each WBS node (previously
  best-effort — the value written by the FE at author time).
- Stage rows are still re-minted UUIDs per save; the **key survives by being
  re-sent by the authoring client**. The workspace rails therefore key on
  `(project_id, stage_key)` and resolve the live stage at append/read time.

## 2. Data model — migration `services/schedule/migrations/0011_task_workspace.sql`

Owned by the schedule service (`schedule_app`). Create in dependency order
(stage is the anchor). **No ledger grant.**

```sql
-- ── schedule.stage_comment ─────────────────────────────────────────────────
CREATE TABLE schedule.stage_comment (
  id             uuid PRIMARY KEY,
  project_id     uuid NOT NULL,
  stage_key      text NOT NULL CHECK (char_length(stage_key) <= 200),
  author_party_id uuid NOT NULL,
  body           text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stage_comment_project_key_idx
  ON schedule.stage_comment (project_id, stage_key, created_at);

-- ── schedule.stage_attachment ──────────────────────────────────────────────
CREATE TABLE schedule.stage_attachment (
  id             uuid PRIMARY KEY,
  project_id     uuid NOT NULL,
  stage_key      text NOT NULL CHECK (char_length(stage_key) <= 200),
  uploader_party_id uuid NOT NULL,
  file_name      text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  content_type   text NOT NULL CHECK (char_length(content_type) BETWEEN 1 AND 127),
  size_bytes     bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  blob_url       text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stage_attachment_project_key_idx
  ON schedule.stage_attachment (project_id, stage_key, created_at);

GRANT SELECT, INSERT ON TABLE schedule.stage_comment    TO schedule_app;
GRANT SELECT, INSERT ON TABLE schedule.stage_attachment TO schedule_app;
```

Collected rules:

- **Append-only by grant:** `SELECT, INSERT` only. There is no UPDATE or DELETE
  grant on either table — a path that tries to edit or delete fails at the
  database, not just the service (ADR-0002 §4 defense in depth).
- `body`: trimmed, `1..4000` characters (service rejects empty/oversized as 400).
- `size_bytes`: `1..10485760` (the 10 MB cap is service-side too; a path that
  bypasses it hits the CHECK). `blob_url`: the public URL the blob store returned.
- No FK to `schedule.stage`: workspaces anchor on `(project_id, stage_key)` and
  stages re-mint UUIDs per save. Liveness is checked at service time
  (`stageLiveByKey`), never cached.

## 3. Attachment storage — Cloudflare R2 (S3 API) — see ADR-0021

- Bytes go to **Cloudflare R2** via its S3-compatible API
  (`@aws-sdk/client-s3` `PutObjectCommand`), written under
  `attachments/<uuid>-<fileName>`. The adapter returns the object's **public CDN
  URL** (`R2_PUBLIC_BASE_URL/<key>`); the URL + metadata land in
  `schedule.stage_attachment`. R2 replaced Vercel Blob (LINA-266) for CDN
  performance — same `blob` port, no schema/read-path change.
- **Deploy prerequisite, not a code blocker:** the five `R2_*` vars (see
  ADR-0021) must be set on the `linknms-portal` Vercel project. The adapter fails
  **loudly** on the first upload if any is missing — there is no silent in-memory
  fallback in the deployed composition root (a memory fallback would look wired
  and lose every upload to a serverless cold start).
- Local dev: `vercel env pull` to obtain the `R2_*` vars; the contract tests use
  an in-memory fake (`createInMemoryBlobStore`).
- **Allowlist** (server-side magic-byte sniff, browser type ignored):
  images (PNG/JPEG/GIF/WebP/SVG), PDF, and common office documents
  (doc/xls/ppt/docx/xlsx/pptx). Anything else → 415.
- **Cap:** 10 MB decoded bytes → 413 (`attachment_too_large`). Empty file → 400.
- **File name:** basename only (`path.basename`), trimmed, ≤ 255 chars,
  empty → 400.

## 4. API contract — build the FE in parallel against this

All routes are project-scoped, live in the `schedule` service, and derive the
actor from the session (ADR-0004). `stageKey` passes through `params`
normalisation untouched (not a UUID).

| # | Route | Body | Returns |
|---|-------|------|---------|
| 1 | `GET /api/v1/projects/{projectId}/plan/stages/{stageKey}/workspace` | — | `WorkspaceView` |
| 2 | `POST /api/v1/projects/{projectId}/plan/stages/{stageKey}/comments` | `{ body: string }` | `{ comment: CommentView }` (`201`) |
| 3 | `POST /api/v1/projects/{projectId}/plan/stages/{stageKey}/attachments` | multipart, `$file` part | `{ attachment: AttachmentView }` (`201`) |

```jsonc
// WorkspaceView — one fetch for the task drawer (oldest → newest)
{
  "stageKey": "pre-construction",
  "comments": [ { "id": "uuid", "body": "…", "authorPartyId": "uuid", "createdAt": "…" } ],
  "attachments": [ { "id": "uuid", "fileName": "…", "contentType": "image/png",
                     "sizeBytes": 1234, "uploaderPartyId": "uuid",
                     "blobUrl": "…", "createdAt": "…" } ]
}
```

- Route 2: `{ body }` is validated server-side (trimmed, `1..4000`); `author`
  in the body is **ignored** — the actor is the session party.
- Route 3: the uploader is the session party; a client-supplied uploader is
  ignored. `contentType` in the response is the server-sniffed type, not what
  the browser sent.
- Both rails resolve the stage by `(project_id, stageKey)` **at request time**
  and require the stage to be live (`stageLiveByKey`: `draft`/`proposed`/
  `accepted` stage rows, or any stage whose `plan_version_id IS NULL`). Unknown /
  never-existed key → 404. A stale key that no longer maps to a live stage →
  404 too (the rails drop out from under a removed task).

## 5. Permissions (ADR-0004)

Two actions, project-scoped, via the identity port `requireMember`:

- `READ_TASK_WORKSPACE` — route 1.
- `WRITE_TASK_WORKSPACE` — routes 2 and 3.

Both are plain **membership** checks (403 for a project member gone non-member;
401 for an unauthenticated party). Membership is evaluated **before** stage
lookup, so an unknown stage under a project the party can't see is 403, never
404 (no existence leak).

## 6. Error map

| Code | Meaning | Status |
|------|---------|--------|
| `unauthenticated` / `not_member` | identity gate (403 before 404) | 401 / 403 |
| `not_found` | no live stage for `(projectId, stageKey)` | 404 |
| `bad_request` | malformed/oversized `stageKey` (→ 400) | 400 |
| `invalid_comment` | body empty / > 4000 after trim | 400 |
| `empty_file` | attachment with no bytes | 400 |
| `attachment_too_large` | > 10 MB | 413 |
| `invalid_filename` | empty / > 255 chars / not a basename | 400 |
| `unsupported_content_type` | not on the allowlist | 415 |

## 7. Open items (finalised in children / follow-ups, not here)

- Comment edit/delete (an explicit future, gated by a moderation story).
- Pagination for very long threads / many attachments (v1 returns all rows;
  bounded per project in practice; revisit with the FE if a drawer must page).
- Whether a re-baselined (frozen) plan's stages stop accepting new comments
  (the `stageLiveByKey` set is decided in the BE child and re-verified in review;
  this doc defaults to *live stages do*).
- Presigned/access-controlled reads (v1 serves public CDN URLs from R2; the
  `blobStore` port + opaque `blob_url` keep the door open — see ADR-0021 trade-off).

## 7a. What the FE built against this (LINA-250, shipped)

- **`/projects/:id/plan/tasks/:stageKey`** — a task's own URL. It resolves the
  key against the version the caller may read (`getPlan`) and `notFound()`s an
  unknown one. On the author's own **draft** it renders the authoring grid with
  the task's drawer already open; on a **proposed/accepted** version it renders a
  read-only task page carrying the same workspace section (opening the editor
  over a version that is out for approval would invite a save the service
  refuses). Opening a task from the grid rewrites the address bar to this URL via
  `history.replaceState` — a Next navigation would discard the unsaved draft.
- **Drawer section** (`app/src/components/TaskWorkspace.tsx`): thread, append-only
  composer, file list + upload. No edit/delete affordance anywhere, mirroring the
  grants. Authors are named from the project's members, never from the row.
- **Stage keys now survive a resume.** `hydrateDraft` reuses the persisted `key`
  instead of minting a fresh one (and pushes its key counter past the saved
  suffixes so the next add cannot collide). Without this the workspace address
  changed on every save and every shared link rotted — the FE half of §1.
- A task the author has just added in the editor has no persisted key yet, so its
  section reads "save the plan to start the conversation" rather than opening a
  thread whose first write would 404.

## 8. What this unblocks

The task workspace drawer (comments + files on any task) and — mechanically — any
future rail that needs a stable per-task address without a per-save row-id
churn. The persisted `stage.key` also lets the authoring surface validate
`dependsOn` references against persisted keys rather than in-memory only.