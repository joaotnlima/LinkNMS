import { NextResponse } from 'next/server';

// Swagger UI is served only on non-production environments (ADR-0006 §2).
// On Vercel, VERCEL_ENV is "production" on the production deployment and
// "preview" on PR deployments. In local dev it is absent.
const IS_PROD = process.env.VERCEL_ENV === 'production';

export function GET() {
  if (IS_PROD) {
    return new NextResponse('Not found', { status: 404 });
  }

  const specUrl = '/api/docs/openapi.yaml';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LinkNMS API — R0</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '${specUrl}',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
    });
  </script>
</body>
</html>`;

  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
