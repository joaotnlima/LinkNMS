// Drain a cursor-paginated `/api/v2` list (doc 11: `?cursor=&limit=`, response
// `{ items, next_cursor }`) for a screen that needs the whole set. Bounded by
// `maxPages` so a runaway list never loops; errors propagate to the caller's
// own fail-closed handling.
import 'server-only';

import { v2, type V2Request } from './client';

export async function allPages<T>(
  req: Omit<V2Request, 'method'> & { method?: 'GET' },
  { limit = 200, maxPages = 25 }: { limit?: number; maxPages?: number } = {},
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const res: { items?: T[]; next_cursor?: string | null } = await v2<{ items?: T[]; next_cursor?: string | null }>({
      ...req, method: 'GET', query: { ...(req.query ?? {}), limit, cursor: cursor ?? undefined },
    });
    out.push(...(res.items ?? []));
    cursor = res.next_cursor ?? null;
    if (!cursor) break;
  }
  return out;
}
