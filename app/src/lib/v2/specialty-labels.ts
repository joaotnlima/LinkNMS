// The plan picker's specialty data on `/api/v2` (LINA-380, PRD-03 R-2): the
// free-text labels (`/specialty-labels`, built-in ∪ the organisation's own)
// and the directory taxonomy (`/specialties`). I/O only; reads fail closed to
// empty (the picker is enhancement-only), the remember write is best-effort.
import 'server-only';
import { randomUUID } from 'node:crypto';

import { v2, V2Error } from './client';
import { listSpecialties } from './directory';

/** A taxonomy entry as the picker shows it: the child under its parent's name. */
export type TaxonomyOption = { code: string; label: string };

export async function listSpecialtyLabels(): Promise<string[]> {
  try {
    const res = await v2<{ items?: Array<{ label: string }> }>({ method: 'GET', path: '/specialty-labels' });
    return (res.items ?? []).map((s) => s.label);
  } catch (err) {
    if (err instanceof V2Error) return [];
    throw err;
  }
}

export async function listTaxonomyOptions(): Promise<TaxonomyOption[]> {
  const items = await listSpecialties();
  const names = new Map(items.map((s) => [s.code, s.name_en]));
  return items.map((s) => ({
    code: s.code,
    label: s.parent_code ? `${names.get(s.parent_code) ?? s.parent_code} › ${s.name_en}` : s.name_en,
  }));
}

/** POST /specialty-labels — remember a typed label for the organisation. */
export async function rememberSpecialtyLabel(label: string): Promise<boolean> {
  try {
    await v2({ method: 'POST', path: '/specialty-labels', body: { label }, idempotencyKey: randomUUID() });
    return true;
  } catch (err) {
    if (err instanceof V2Error) return false;
    throw err;
  }
}
