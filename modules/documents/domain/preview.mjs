// DWG / DXF previews (PRD-06 V-11..V-17, D-49) — pure: the reasons a file has
// no preview, the normalised result of a conversion, the SVG hygiene applied
// before a generated drawing is ever served, the derived-object key, and the
// wire body. No I/O — the converter itself is a port (application/dwg-converter.mjs).

/** Why a DWG / DXF is download-only. Anything else a converter says maps to conversion_failed. */
export const PREVIEW_REASONS = Object.freeze([
  'converter_not_configured', 'unsupported_version', 'conversion_failed', 'conversion_timeout',
  'empty_drawing', 'preview_too_large',
]);

export const MAX_LAYOUTS = 20;
/** A preview layout above this is refused (served inline to a browser). */
export const MAX_SVG_BYTES = 40 * 1024 * 1024;
const NAME_MAX = 200;
const MAX_LAYERS = 2000;
const MAX_WARNINGS = 50;

/** Strip what must never run or load from a generated drawing (defence in depth; served inline). */
export function sanitizeSvg(svg) {
  return String(svg)
    .replace(/<!DOCTYPE[^>[]*(\[[^\]]*\])?>/gi, '')
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // Only in-document references survive (#symbol-…); no external or javascript: hrefs.
    .replace(/\s(xlink:href|href)\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, '');
}

/** The viewBox width/height of an SVG, or nulls when it has none. */
export function svgSize(svg) {
  const m = /<svg\b[^>]*\bviewBox\s*=\s*["']\s*([-\d.eE+]+)[\s,]+([-\d.eE+]+)[\s,]+([-\d.eE+]+)[\s,]+([-\d.eE+]+)\s*["']/i.exec(String(svg));
  if (!m) return { width: null, height: null };
  const w = Number(m[3]);
  const h = Number(m[4]);
  return { width: Number.isFinite(w) && w > 0 ? w : null, height: Number.isFinite(h) && h > 0 ? h : null };
}

/** Does the SVG draw anything at all? */
export function svgHasGeometry(svg) {
  return /<(path|line|polyline|polygon|circle|ellipse|rect|text|use)\b/i.test(String(svg));
}

function cleanText(v, max) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/**
 * Normalise whatever a converter answered into what the store keeps:
 *   { status: 'ready', layouts: [{name, svg, width, height}], layers, warnings }
 *   { status: 'unavailable', reason, layers: [], warnings }
 * A converter is untrusted input here: shapes are checked, sizes capped, SVG
 * sanitised. A "ready" answer with nothing drawable is `empty_drawing`.
 */
export function normalizeConversion(result) {
  const warnings = Array.isArray(result?.warnings)
    ? result.warnings.slice(0, MAX_WARNINGS)
      .map((w) => ({ code: cleanText(w?.code, 80), detail: cleanText(w?.detail, 500) }))
      .filter((w) => w.code)
      .map((w) => (w.detail ? w : { code: w.code }))
    : [];
  if (!result || result.ok !== true) {
    const reason = PREVIEW_REASONS.includes(result?.reason) ? result.reason : 'conversion_failed';
    return { status: 'unavailable', reason, layouts: [], layers: [], warnings };
  }
  const layouts = [];
  for (const l of Array.isArray(result.layouts) ? result.layouts.slice(0, MAX_LAYOUTS) : []) {
    if (typeof l?.svg !== 'string' || !svgHasGeometry(l.svg)) continue;
    const svg = sanitizeSvg(l.svg);
    if (Buffer.byteLength(svg) > MAX_SVG_BYTES) {
      return { status: 'unavailable', reason: 'preview_too_large', layouts: [], layers: [], warnings };
    }
    const size = svgSize(svg);
    layouts.push({ name: cleanText(l.name, NAME_MAX) ?? `Layout ${layouts.length + 1}`, svg, ...size });
  }
  if (!layouts.length) return { status: 'unavailable', reason: 'empty_drawing', layouts: [], layers: [], warnings };
  const layers = Array.isArray(result.layers)
    ? result.layers.slice(0, MAX_LAYERS)
      .map((l) => ({
        name: cleanText(l?.name, NAME_MAX),
        on: l?.on !== false,
        ...(typeof l?.color === 'string' && /^#[0-9a-f]{6}$/i.test(l.color) ? { color: l.color.toLowerCase() } : {}),
        ...(Number.isInteger(l?.count) && l.count >= 0 ? { count: l.count } : {}),
      }))
      .filter((l) => l.name)
    : [];
  return { status: 'ready', reason: null, layouts, layers, warnings };
}

/** The derived object key of one preview layout — its own key, never the source's. */
export function previewKey({ documentId, sha256, index }) {
  return `v2/documents/${documentId}/previews/${sha256}/${index}.svg`;
}

/**
 * Wire body (schema DocumentPreview). `preview` is the stored row (or null =
 * not converted yet); `layouts` carry their minted inline URLs.
 */
export function previewBody({ documentId, versionNo, fileType, converted, preview, layouts = [] }) {
  const base = { document_id: documentId, version_no: versionNo, file_type: fileType };
  if (!converted) return { ...base, status: 'ready', layouts: [], layers: [], warnings: [] };
  if (!preview) return { ...base, status: 'pending', layouts: [], layers: [], warnings: [] };
  if (preview.status !== 'ready') {
    return { ...base, status: 'unavailable', reason: preview.reason, layouts: [], layers: [], warnings: preview.warnings ?? [] };
  }
  return {
    ...base,
    status: 'ready',
    layouts: layouts.map((l) => ({
      index: l.layout_index,
      name: l.name,
      ...(l.width ? { width: l.width } : {}),
      ...(l.height ? { height: l.height } : {}),
      view_url: l.view_url,
      expires_at: l.expires_at,
    })),
    layers: preview.layers ?? [],
    warnings: preview.warnings ?? [],
  };
}
