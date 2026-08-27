import { NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const IS_PROD = process.env.VERCEL_ENV === 'production';

export function GET() {
  if (IS_PROD) {
    return new NextResponse('Not found', { status: 404 });
  }

  // Read the stub merged spec from the repo root (bundled at build time).
  // Replace with the real merged spec generator in a later slice.
  const spec = readFileSync(join(process.cwd(), 'openapi.yaml'), 'utf8');
  return new NextResponse(spec, {
    headers: { 'Content-Type': 'application/yaml' },
  });
}
