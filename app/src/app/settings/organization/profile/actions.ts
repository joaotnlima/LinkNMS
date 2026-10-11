'use server';

// /settings/organization/profile writes (PRD-03 R-13, R-20). Each action calls
// ONE v2 operation and lands back with `?saved=` or `?error=` — the server's
// reason as-is (422 field errors, 409 stale version). Nothing is decided here.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { V2Error } from '@/lib/v2/client';
import { addPortfolioEntry, deletePortfolioEntry, putMyProfile } from '@/lib/v2/directory';
import { profileWriteFromForm } from '@/lib/v2/directory-view';

const PATH = '/settings/organization/profile';
const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();

async function run(saved: string, fn: () => Promise<unknown>): Promise<never> {
  let target = `${PATH}?saved=${saved}`;
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof V2Error)) throw err;
    const reason = err.errors ? Object.entries(err.errors).map(([k, v]) => `${k}: ${v}`).join('; ') : err.message;
    target = `${PATH}?error=${encodeURIComponent(reason)}`;
  }
  revalidatePath(PATH);
  redirect(target);
}

export async function saveDirectoryProfileAction(fd: FormData): Promise<void> {
  const version = str(fd, 'version');
  const body = profileWriteFromForm((k) => String(fd.get(k) ?? ''), (k) => fd.getAll(k).map(String));
  await run('directory', () => putMyProfile(str(fd, 'org_id'), body, version ? Number(version) : null));
}

export async function addPortfolioAction(fd: FormData): Promise<void> {
  await run('portfolio', () => addPortfolioEntry(str(fd, 'org_id'), {
    title: str(fd, 'title'),
    ...(str(fd, 'municipality_code') ? { municipality_code: str(fd, 'municipality_code') } : {}),
    ...(str(fd, 'typology') ? { typology: str(fd, 'typology') } : {}),
    specialties: fd.getAll('specialties').map(String).filter(Boolean),
    ...(str(fd, 'end_date') ? { end_date: str(fd, 'end_date') } : {}),
  }));
}

export async function deletePortfolioAction(fd: FormData): Promise<void> {
  await run('portfolio_removed', () => deletePortfolioEntry(str(fd, 'org_id'), str(fd, 'entry_id')));
}
