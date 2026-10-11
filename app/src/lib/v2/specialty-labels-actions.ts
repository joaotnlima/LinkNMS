'use server';

// The session-bound door the CLIENT plan picker reaches `./specialty-labels.ts`
// through (the same pattern as `model-actions.ts`): serializable answers only.
import { listSpecialtyLabels, listTaxonomyOptions, rememberSpecialtyLabel, type TaxonomyOption } from './specialty-labels';

export async function loadSpecialtyCatalogAction(): Promise<{ specialties: string[]; taxonomy: TaxonomyOption[] }> {
  const [specialties, taxonomy] = await Promise.all([listSpecialtyLabels(), listTaxonomyOptions()]);
  return { specialties, taxonomy };
}

export async function rememberSpecialtyLabelAction(label: string): Promise<boolean> {
  const trimmed = label.trim();
  if (!trimmed) return false;
  return rememberSpecialtyLabel(trimmed);
}
