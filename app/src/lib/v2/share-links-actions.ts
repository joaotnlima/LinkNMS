'use server';

// The owner's share-link writes (PRD-12 N-12): create (the url — and its token
// — is answered ONCE, here, and shown once) and revoke. Serializable answers;
// a refusal carries the server's sentence.
import { revalidatePath } from 'next/cache';

import { V2Error } from './client';
import { createShareLinkV2, revokeShareLinkV2 } from './share-links';

export type ShareResult = { ok: true; url: string | null } | { ok: false; message: string };

async function run(projectId: string, fn: () => Promise<string | null>): Promise<ShareResult> {
  try {
    const url = await fn();
    revalidatePath(`/projects/${projectId}/documents/share`);
    return { ok: true, url };
  } catch (err) {
    if (err instanceof V2Error) {
      const field = err.errors ? Object.values(err.errors)[0] : null;
      return { ok: false, message: field ?? err.detail ?? err.message };
    }
    return { ok: false, message: 'Something went wrong. Try again.' };
  }
}

export async function createShareLinkAction(projectId: string, body: Record<string, unknown>): Promise<ShareResult> {
  return run(projectId, async () => (await createShareLinkV2(projectId, body)).url ?? null);
}

export async function revokeShareLinkAction(projectId: string, linkId: string): Promise<ShareResult> {
  return run(projectId, async () => { await revokeShareLinkV2(linkId); return null; });
}
