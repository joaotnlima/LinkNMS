// Blob storage for task attachments (LINA-249) — the `blob` port behind
// task-workspace.mjs.
//
// Two adapters, same small surface:
//
//   put({ fileName, contentType, buffer })    → Promise<string>  the object's URL
//   putRef({ fileName, contentType, buffer }) → Promise<{key,url}> the object's URL
//                                                  + R2 key (for FileRef shapes)
//
// - `createR2BlobStore()` — production (LINA-266). Cloudflare R2 via its
//   S3-compatible API (`@aws-sdk/client-s3` `PutObjectCommand`; server-side
//   upload from the route handler; the `blob_url` column stores the object's
//   public CDN URL). R2 was chosen over Vercel Blob for CDN performance
//   (founder call, LINA-266). **Lazy import**: `@aws-sdk/client-s3` is loaded
//   only on the first upload, so reads (and any code path that never uploads)
//   stay lean. Config comes from R2_* env; a missing credential is a clear,
//   loud wiring error — NOT a silent fallback that would look wired and lose
//   every upload. Keys carry a random UUID so the public URL is unguessable
//   (bearer-URL access; see ADR-0021 for the public-CDN vs presigned trade-off).
// - `createInMemoryBlobStore()` — tests / local. Objects live in memory and
//   never leave the process; URLs are `blob://<id>/<fileName>`. The stored map
//   is exposed as `_objects` so a test can assert exactly what was stored.
import { randomUUID } from 'node:crypto';

export function createInMemoryBlobStore() {
  const objects = new Map();

  async function putRef({ fileName, contentType, buffer }) {
    const id = randomUUID();
    const key = `attachments/${id}-${fileName}`;
    const url = `blob://${id}/${encodeURIComponent(fileName)}`;
    objects.set(url, { key, id, fileName, contentType, size: buffer.byteLength, buffer });
    return { key, url };
  }

  async function put(input) {
    return (await putRef(input)).url;
  }

  return { put, putRef, _objects: objects };
}

// Strip a leading/trailing slash so join is unambiguous whatever the env holds.
const trimSlashes = (s) => String(s).replace(/^\/+|\/+$/g, '');

export function createR2BlobStore({
  endpoint = process.env.R2_S3_ENDPOINT,
  bucket = process.env.R2_BUCKET,
  accessKeyId = process.env.R2_ACCESS_KEY_ID,
  secretAccessKey = process.env.R2_SECRET_ACCESS_KEY,
  publicBaseUrl = process.env.R2_PUBLIC_BASE_URL,
} = {}) {
  // Fail loud at the FIRST upload if any piece of the wiring is missing, so a
  // half-configured store reads as an explicit error rather than an SDK stack
  // (or, worse, a successful put to a bucket whose objects nothing can serve).
  function assertConfigured() {
    const missing = [
      ['R2_S3_ENDPOINT', endpoint],
      ['R2_BUCKET', bucket],
      ['R2_ACCESS_KEY_ID', accessKeyId],
      ['R2_SECRET_ACCESS_KEY', secretAccessKey],
      ['R2_PUBLIC_BASE_URL', publicBaseUrl],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      throw new Error(
        `Cloudflare R2 is not configured: set ${missing.join(', ')} on the ` +
        'linknms-portal Vercel project (per the LINA-266 deploy note) before ' +
        'accepting uploads',
      );
    }
  }

  // One client per adapter instance, built lazily on first use so construction
  // stays free and the SDK never loads on read-only paths. `region: 'auto'` is
  // R2's required value; the S3 client just needs a non-empty region.
  let clientPromise;
  async function getClient() {
    if (!clientPromise) {
      clientPromise = import('@aws-sdk/client-s3').then(({ S3Client }) =>
        new S3Client({
          region: 'auto',
          endpoint,
          credentials: { accessKeyId, secretAccessKey },
        }),
      );
    }
    return clientPromise;
  }

  async function putRef({ fileName, contentType, buffer }) {
    assertConfigured();
    // Random UUID prefix: two uploads of the same name never collide, and the
    // resulting public URL is unguessable.
    const key = `attachments/${randomUUID()}-${fileName}`;
    const client = await getClient();
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }));
    // The public CDN URL the FE renders. R2 objects are served from the bucket's
    // public base (r2.dev dev URL or a custom domain); we store the ready URL so
    // the read path stays a straight column read.
    return { key, url: `${trimSlashes(publicBaseUrl)}/${key}` };
  }

  async function put(input) {
    return (await putRef(input)).url;
  }

  return { put, putRef };
}
