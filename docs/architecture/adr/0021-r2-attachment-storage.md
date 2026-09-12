# ADR-0021 — Task-attachment object storage on Cloudflare R2 (S3 API)

- **Status:** Accepted
- **Date:** 2026-09-12
- **Issue:** LINA-266 (unblocks LINA-249 attachment uploads)
- **Supersedes:** the Vercel Blob adapter shipped with LINA-249 (never deployed — the store was never provisioned)

## Context

LINA-249 shipped the task-workspace attachment path behind a small `blob` port
(`services/schedule/blob-store.mjs`): `put({ fileName, contentType, buffer }) →
url`. The production adapter wrapped Vercel Blob and stored the returned public
URL in `schedule.stage_attachment.blob_url`. It never deployed: provisioning a
Vercel Blob store needs owner/dashboard access, and while that was pending the
founder called it — **use Cloudflare R2 instead, for CDN performance** — and
supplied the R2 S3 API endpoint for a `linknms` bucket.

## Decision

Store attachment bytes in **Cloudflare R2 via its S3-compatible API**, using
`@aws-sdk/client-s3` (`PutObjectCommand`) from the route handler. R2 replaces
Vercel Blob one-for-one behind the existing `blob` port — no change to the
service, route, schema, or read path.

- **Adapter:** `createR2BlobStore()` replaces `createVercelBlobStore()` in the
  composition root. Same surface; the SDK is a **lazy `import()`** so reads and
  non-upload paths never load it. Config is all-or-nothing: a missing R2_* value
  throws a loud wiring error on the first upload — never a silent fallback that
  looks wired and loses files (composition-root rule, carried over from LINA-249).
- **Reads = public CDN URLs.** Objects are written under
  `attachments/<uuid>-<fileName>` and served from the bucket's public base
  (`R2_PUBLIC_BASE_URL` — r2.dev dev URL or a custom domain). We store the fully
  resolved public URL in `blob_url`, so the read path stays a straight column
  read and attachments are served from R2's edge CDN (the founder's stated goal).
- **Bundling:** `@aws-sdk/client-s3` joins `pg`/`exceljs` in
  `serverExternalPackages` **and** the webpack alias to `app/node_modules`, the
  same bare-specifier pin those two need (Vercel Root Directory is `app`).

### Config (Vercel Production env on `linknms-portal`)

| Var | Value | Secret? |
|-----|-------|---------|
| `R2_S3_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` (account host, no bucket path) | no |
| `R2_BUCKET` | `linknms` | no |
| `R2_PUBLIC_BASE_URL` | bucket public base (r2.dev URL or custom domain) | no |
| `R2_ACCESS_KEY_ID` | R2 API token access key | **yes** |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret | **yes** |

## Trade-off — public CDN URL vs. presigned access-controlled reads

The founder chose R2 for **CDN performance**, so reads are public-object URLs:
anyone holding the URL can fetch the file. The URL is unguessable (random UUID in
the key), so this is **bearer-URL** security, not membership-checked access.

For a product whose value is an *auditable, access-controlled* record, the
stricter option is a **private bucket + presigned GET URLs** minted per read
behind `identity.requireMember`. That trades edge-cached delivery for
authz-gated delivery. We accept the public-CDN model for v1 because (a) it is the
founder's explicit call, (b) keys are unguessable, and (c) it keeps the read path
a plain column read. **Revisit when** attachments carry sensitive documents
(contracts, inspection reports) whose exposure via a leaked URL is unacceptable —
at which point switch `blob_url` to store the object *key* and mint presigned
GETs on read. That change is contained to the adapter + the read mapping in
`task-workspace.mjs`; the schema already holds an opaque string.

## Consequences

- Uploads work end-to-end once the five R2_* vars are set on `linknms-portal`.
- No schema change (migration 0011 stands); `blob_url` semantics unchanged
  (still a ready-to-serve URL string).
- Vercel Blob (`@vercel/blob`) is removed from both `package.json` files.
- LINA-166-class dependency on the founder: the two secret vars must be minted
  from a Cloudflare R2 API token and pasted into Vercel env — the scoped deploy
  token cannot create them.
