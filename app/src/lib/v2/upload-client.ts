// Client-only R2 upload helpers for the direct browser → object-storage PUT
// (step 2 of the reserve → PUT → complete protocol). This module is deliberately
// NOT `server-only` and imports neither the v2 client nor `next` — it runs in a
// client component that owns the `<input type=file>`. The reserve and complete
// steps still funnel through server actions (they call `/api/v2`, LINA-309); only
// the presigned PUT — which never touches our server — happens here.
//
// It exists because `lib/v2/task-workspace.ts` carries the equivalent helpers but
// is `server-only`, so a client component cannot import them. These are the plain
// Web-platform calls (SubtleCrypto, fetch) a browser can run directly.

/**
 * The blob's SHA-256 as both hex (what the reserve declares) and base64 (the
 * `x-amz-checksum-sha256` header the presigned PUT is signed for). Computed from
 * the exact bytes so the declaration and the upload cannot disagree.
 */
export async function digestSha256(blob: Blob): Promise<{ hex: string; base64: string }> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return { hex, base64: btoa(binary) };
}

/**
 * PUT the bytes to the presigned ticket URL. The checksum header and content type
 * must match what the ticket was signed for, or storage refuses the object. On
 * failure the caller aborts before completing — an unproven version stays
 * invisible everywhere.
 */
export async function putToTicket(
  uploadUrl: string, file: Blob, mime: string, sha256Base64: string,
): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': mime, 'x-amz-checksum-sha256': sha256Base64 },
    body: file,
  });
  if (!res.ok) throw new Error('That file did not upload. Try again.');
}
