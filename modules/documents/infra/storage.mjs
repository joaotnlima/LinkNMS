// Object storage port of the documents module — Cloudflare R2 behind the
// S3 API (ADR-0021 bucket), but PRESIGNED both ways, unlike the v1 attachment
// store (public CDN URLs): doc 08 wants downloads via short-lived signed URLs
// after a visibility check (V6), so the v2 bucket contents are private and
// every read is minted per request.
//
//   signUpload({ key, mime, sha256Hex })  → { url, expiresAt }
//   signDownload({ key, fileName })       → { url, expiresAt }
//   head({ key })                         → { sizeBytes } | null
//
// The declared sha256 is pinned into the presigned PUT as the
// `x-amz-checksum-sha256` signed header, so the storage itself refuses bytes
// that do not match what the client declared — completeUpload then only has
// to prove the object EXISTS with the declared size.
//
// Lazy AWS-SDK imports (same rationale as services/schedule/blob-store.mjs):
// construction is free, read-only paths never load the SDK. Missing R2_* env
// is a loud error at first use, never a silent fallback.
import { randomUUID } from 'node:crypto';

const UPLOAD_TTL_S = 15 * 60; // generous for site photos on site connections
const DOWNLOAD_TTL_S = 5 * 60;

export function createR2ObjectStorage({
  endpoint = process.env.R2_S3_ENDPOINT,
  bucket = process.env.R2_BUCKET,
  accessKeyId = process.env.R2_ACCESS_KEY_ID,
  secretAccessKey = process.env.R2_SECRET_ACCESS_KEY,
} = {}) {
  function assertConfigured() {
    const missing = [
      ['R2_S3_ENDPOINT', endpoint],
      ['R2_BUCKET', bucket],
      ['R2_ACCESS_KEY_ID', accessKeyId],
      ['R2_SECRET_ACCESS_KEY', secretAccessKey],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      throw new Error(`Cloudflare R2 is not configured: set ${missing.join(', ')} before accepting documents`);
    }
  }

  let sdkPromise;
  async function sdk() {
    if (!sdkPromise) {
      sdkPromise = Promise.all([
        import('@aws-sdk/client-s3'),
        import('@aws-sdk/s3-request-presigner'),
      ]).then(([s3, presigner]) => ({
        client: new s3.S3Client({ region: 'auto', endpoint, credentials: { accessKeyId, secretAccessKey } }),
        s3,
        presigner,
      }));
    }
    return sdkPromise;
  }

  return {
    async signUpload({ key, mime, sha256Hex }) {
      assertConfigured();
      const { client, s3, presigner } = await sdk();
      const command = new s3.PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: mime,
        ChecksumSHA256: Buffer.from(sha256Hex, 'hex').toString('base64'),
      });
      const url = await presigner.getSignedUrl(client, command, { expiresIn: UPLOAD_TTL_S });
      return { url, expiresAt: new Date(Date.now() + UPLOAD_TTL_S * 1000).toISOString() };
    },

    async signDownload({ key, fileName }) {
      assertConfigured();
      const { client, s3, presigner } = await sdk();
      const command = new s3.GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${String(fileName).replace(/["\\]/g, '_')}"`,
      });
      const url = await presigner.getSignedUrl(client, command, { expiresIn: DOWNLOAD_TTL_S });
      return { url, expiresAt: new Date(Date.now() + DOWNLOAD_TTL_S * 1000).toISOString() };
    },

    async head({ key }) {
      assertConfigured();
      const { client, s3 } = await sdk();
      try {
        const res = await client.send(new s3.HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { sizeBytes: Number(res.ContentLength) };
      } catch (err) {
        if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return null;
        throw err;
      }
    },
  };
}

/**
 * Test/local double. `_objects` is exposed so a test can "upload" by setting
 * the key it was given a ticket for; head() then sees it.
 */
export function createInMemoryObjectStorage() {
  const objects = new Map();
  return {
    _objects: objects,
    async signUpload({ key }) {
      return { url: `memory://upload/${key}?sig=${randomUUID()}`, expiresAt: new Date(Date.now() + UPLOAD_TTL_S * 1000).toISOString() };
    },
    async signDownload({ key }) {
      return { url: `memory://download/${key}?sig=${randomUUID()}`, expiresAt: new Date(Date.now() + DOWNLOAD_TTL_S * 1000).toISOString() };
    },
    async head({ key }) {
      const obj = objects.get(key);
      return obj ? { sizeBytes: obj.sizeBytes } : null;
    },
  };
}
