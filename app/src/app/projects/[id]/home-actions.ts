'use server';

// The build home's one write (PRD-09 O-1; PRD-03 R-12): the owner allows or
// withdraws showing this build's name on its companies' public profiles. The
// server decides who may (project.owner); this only carries the choice.
import { revalidatePath } from 'next/cache';

import { putPortfolioConsent } from '@/lib/v2/directory';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function setPortfolioConsentAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get('projectId') ?? '');
  if (!UUID.test(projectId)) return;
  await putPortfolioConsent(projectId, formData.get('show') === 'yes');
  revalidatePath(`/projects/${projectId}`);
}
