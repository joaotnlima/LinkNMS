#!/usr/bin/env node
// R2 bucket CORS for the BIM viewer (LINA-409 / doc 24, decision 4 + §"R2 CORS").
//
//   cd app && node scripts/r2-cors.mjs show
//   cd app && node scripts/r2-cors.mjs apply
//
// The viewer fetch()es a short-TTL presigned INLINE GET for the `.ifc` and reads
// it as an ArrayBuffer. That is a cross-origin read (our origin → the R2 S3
// endpoint), so the bucket must answer the browser preflight with CORS allowing
// GET from the app origins and exposing ETag/Content-Length. We hold the R2 S3
// credentials, so this is applied programmatically here — NOT a founder-gated
// dashboard task (doc 24 §"R2 CORS (one-time infra)").
//
// Idempotent: `apply` overwrites the single rule below; `show` prints the live
// config without changing anything. Reads the same R2_* env the app uses
// (modules/documents/infra/storage.mjs). Run once per bucket (prod + dev share
// the credentials but are different buckets — run against each R2_BUCKET).
//
// Resolves @aws-sdk from app/node_modules, so it lives under app/scripts, not the
// repo-root scripts/ (which has no node_modules of its own).
import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3';

const endpoint = process.env.R2_S3_ENDPOINT;
const bucket = process.env.R2_BUCKET;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

const missing = [
  ['R2_S3_ENDPOINT', endpoint],
  ['R2_BUCKET', bucket],
  ['R2_ACCESS_KEY_ID', accessKeyId],
  ['R2_SECRET_ACCESS_KEY', secretAccessKey],
].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`error: Cloudflare R2 is not configured — set ${missing.join(', ')}`);
  process.exit(1);
}

// The app origins that mint the presigned URL and fetch the bytes. Vercel preview
// origins are wildcard-matched (R2/S3 CORS supports one leading `*`).
const ALLOWED_ORIGINS = [
  'https://portal.linknms.com',
  'https://dev.portal.linknms.com',
  'https://*.vercel.app',
  'http://localhost:3000',
];

// GET is all the viewer needs (the PUT of a new model is a presigned upload the
// browser sends with its own signed headers — same-rule, already working for
// every document upload). HEAD lets a client read size/etag cheaply.
const RULE = {
  AllowedMethods: ['GET', 'HEAD'],
  AllowedOrigins: ALLOWED_ORIGINS,
  AllowedHeaders: ['*'],
  ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type'],
  MaxAgeSeconds: 3600,
};

const client = new S3Client({
  region: 'auto',
  endpoint,
  credentials: { accessKeyId, secretAccessKey },
});

const cmd = process.argv[2] ?? 'show';

async function show() {
  try {
    const res = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
    console.log(`CORS on ${bucket}:`);
    console.log(JSON.stringify(res.CORSRules ?? [], null, 2));
  } catch (err) {
    if (err?.name === 'NoSuchCORSConfiguration') {
      console.log(`No CORS configured on ${bucket}.`);
      return;
    }
    throw err;
  }
}

async function apply() {
  await client.send(new PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: { CORSRules: [RULE] },
  }));
  console.log(`Applied CORS to ${bucket}:`);
  console.log(JSON.stringify(RULE, null, 2));
}

try {
  if (cmd === 'apply') await apply();
  else if (cmd === 'show') await show();
  else {
    console.error(`usage: node scripts/r2-cors.mjs [show|apply]`);
    process.exit(1);
  }
} catch (err) {
  console.error('error:', err?.message ?? err);
  process.exit(1);
}
