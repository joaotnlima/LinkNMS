// /api/v2 router — pure, framework-free (phase 0).
//
// Modules register their operations here (`register(...)`) and the Next.js
// catch-all adapter (app/src/app/api/v2) does nothing but translate
// Request → dispatch() → Response. Route templates use the OpenAPI shapes
// verbatim, including the colon-command convention:
//     /projects/{id}            /contracts/{id}:sign
// so a registered route is greppable against api/v2/openapi.yaml by string.
//
// A handler receives { viewer, params, query, body, headers } and returns
// { status, body, headers? }. It may throw ProblemError; anything else that
// escapes is a 500 with no internals leaked.
import { ProblemError, problemResponse } from './errors.mjs';

const SEGMENT = /^\{([a-z_]+)\}(?::([a-z_-]+))?$/i; // {id} or {id}:sign

export function createRouter() {
  const routes = [];

  /** register('POST', '/contracts/{id}:sign', operationId, handler) */
  function register(method, template, operationId, handler) {
    if (!template.startsWith('/')) throw new Error(`route must start with /: ${template}`);
    if (routes.some((r) => r.method === method && r.template === template)) {
      throw new Error(`duplicate route: ${method} ${template}`);
    }
    routes.push({ method: method.toUpperCase(), template, operationId, handler, parts: template.slice(1).split('/') });
  }

  function match(method, path) {
    const parts = path.replace(/\/+$/, '').replace(/^\/+/, '').split('/');
    for (const route of routes) {
      if (route.method !== method.toUpperCase()) continue;
      if (route.parts.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i += 1) {
        const want = route.parts[i];
        const got = parts[i];
        const m = SEGMENT.exec(want);
        if (m) {
          // A command segment ({id}:sign) must carry the same :command suffix.
          const [value, cmd] = splitCommand(got);
          if ((m[2] ?? null) !== cmd) { ok = false; break; }
          params[m[1]] = decodeURIComponent(value);
        } else if (want !== got) { ok = false; break; }
      }
      if (ok) return { route, params };
    }
    return null;
  }

  /**
   * @param {{ method: string, path: string, viewer?: unknown,
   *           query?: Record<string, string>, body?: unknown,
   *           headers?: Record<string, string> }} req
   * @returns {Promise<{status: number, body: any, headers: Record<string, string>}>}
   */
  async function dispatch({ method, path, viewer, query = {}, body = null, headers = {} }) {
    const found = match(method, path);
    if (!found) return problemResponse('not_found', `no ${method} ${path} on /api/v2`);
    try {
      const res = await found.route.handler({ viewer, params: found.params, query, body, headers });
      return {
        status: res.status ?? 200,
        body: res.body ?? null,
        headers: { 'content-type': 'application/json', ...(res.headers ?? {}) },
      };
    } catch (err) {
      if (err instanceof ProblemError) {
        return { ...problemResponse(err.problem.code), body: err.problem };
      }
      // Log server-side; answer with a clean problem and nothing internal.
      console.error(`[api/v2] ${found.route.operationId} failed:`, err);
      return problemResponse('internal');
    }
  }

  return { register, match, dispatch, routes: () => routes.map(({ method, template, operationId }) => ({ method, template, operationId })) };
}

function splitCommand(segment) {
  const idx = segment.indexOf(':');
  if (idx === -1) return [segment, null];
  return [segment.slice(0, idx), segment.slice(idx + 1)];
}
