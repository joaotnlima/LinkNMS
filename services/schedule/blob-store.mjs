// Blob storage for task attachments (LINA-249) — the `blob` port behind
// task-workspace.mjs.
//
// Two adapters, same small surface:
//
//   put({ fileName, contentType, buffer }) → Promise<string>  the object's URL
//
// - `createVercelBlobStore()` — production. Wraps `@vercel/blob`'s `put()`
//   (server-side upload from the route handler; the `blob_url` column stores
//   the returned public URL). **Lazy import**: `@vercel/blob` is loaded only on
//   the first upload, so reads (and any code path that never uploads) stay
//   lean. The token is `BLOB_READ_WRITE_TOKEN`; a missing token is a clear,
//   loud wiring error — NOT a silent fallback that would look wired and lose
//   every upload. Vercel Blob ships inside every Vercel plan (no paid add-on
//   strictly required); enabling the store + minting the token in the traggo
//   dashboard is a deploy prerequisite owned by the Full-Stack Architect.
// - `createInMemoryBlobStore()` — tests / local. Objects live in memory and
//   never leave the process; URLs are `blob://<id>/<fileName>`. The stored map
//   is exposed as `_objects` so a test can assert exactly what was stored.
import { randomUUID } from 'node:crypto';

export function createInMemoryBlobStore() {
  const objects = new Map();

  async function put({ fileName, contentType, buffer }) {
    const id = randomUUID();
    const url = `blob://${id}/${encodeURIComponent(fileName)}`;
    objects.set(url, { id, fileName, contentType, size: buffer.byteLength, buffer });
    return url;
  }

  return { put, _objects: objects };
}

export function createVercelBlobStore({ token = process.env.BLOB_READ_WRITE_TOKEN } = {}) {
  // Credentials resolve inside the SDK (`token` defaults to the
  // BLOB_READ_WRITE_TOKEN env, which Vercel injects for the project's Blob
  // store, or OIDC trust where the deployed runtime offers it). We only check
  // that SOME credential exists so a hung-first-upload reads as a clear wiring
  // error, not an SDK stack.
  const canAuthenticate = () =>
    Boolean(token) || Boolean(process.env.VERCEL_OIDC_TOKEN);

  async function put({ fileName, contentType, buffer }) {
    if (!canAuthenticate()) {
      throw new Error(
        'Vercel Blob is not configured: create a Blob store in the Vercel ' +
        'dashboard (per the deploy note) so BLOB_READ_WRITE_TOKEN / OIDC exists ' +
        'before accepting uploads',
      );
    }
    // Lazy: the npm package is only needed when bytes actually arrive.
    const { put: blobPut } = await import('@vercel/blob');
    const result = await blobPut(`attachments/${randomUUID()}-${fileName}`, buffer, {
      access: 'public',
      contentType,
      addRandomSuffix: true,
    });
    return result.url;
  }

  return { put };
}