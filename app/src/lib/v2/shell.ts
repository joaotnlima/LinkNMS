// The build-scoped shell chrome, on `/api/v2` (LINA-353, S2). The v2 counterpart
// of `server/portal-shell.ts::buildShellContext`, which every PortalShell BUILD-
// mode page (the record, the plan, …) needs: the seated user (rail footer
// identity) and the full build list (switcher dropdown).
//
// S1 cut the standalone portfolio page onto v2 but left the SHARED shell helper
// on v1 (`getMe`/`listProjects`). The record surface is the first build-scoped
// page to go v2, so it is the first that needs this — and it is deliberately a
// thin reuse of S1's already-cut reads (`getViewerProfile` + `listPortfolio`
// from `./profile`) rather than a second v2 read path, so S3–S7 adopt one shell.
//
// Fail-closed, like S1: a viewer we cannot name yet (not mirrored) gets a neutral
// shell (blank identity, empty switcher) rather than a crash — the account menu
// simply has nothing to show until the Clerk mirror lands their person row.
import 'server-only';

import { hrefForStep, stepFor } from '@/lib/build-creation';
import type { BuildRef, PortalUser } from '@/components/PortalShell';
import { getViewerProfile, listPortfolio } from './profile';

export interface BuildShellContextV2 {
  user: PortalUser;
  builds: BuildRef[];
}

const NEUTRAL_USER: PortalUser = { displayName: '', roleLabel: '' };

/**
 * The switcher entries + rail identity for a v2 build-scoped page. `activeName`
 * is the name the caller already fetched (the record read has it), so the active
 * build is guaranteed present in the switcher even if the org portfolio read
 * races or omits it — the same guarantee the v1 helper gives.
 */
export async function buildShellContextV2(
  activeBuildId: string,
  activeName: string,
): Promise<BuildShellContextV2> {
  const [user, projects] = await Promise.all([getViewerProfile(), listPortfolio()]);
  // A draft still switches BACK INTO the wizard at the step it stalled on — the
  // same routing the portfolio cards use — so the switcher never lands someone on
  // a half-built record.
  const builds: BuildRef[] = projects.map((p) => ({
    id: p.id,
    name: p.name,
    href: hrefForStep(p.id, stepFor(p)),
  }));
  if (!builds.some((b) => b.id === activeBuildId)) {
    builds.unshift({ id: activeBuildId, name: activeName, href: `/projects/${activeBuildId}` });
  }
  return { user: user ?? NEUTRAL_USER, builds };
}
