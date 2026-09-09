// Shell context for build-scoped surfaces (LINA-219).
//
// Every page that wears PortalShell in BUILD mode needs the same three things:
// the seated user (the rail footer identity), the full list of builds (the
// switcher dropdown), and the active build's name (the switcher value + the top
// breadcrumb). This assembles them in one place so the record home, the plan,
// and every other build-scoped page stay identical chrome, one fetch shape.
import { getMe, listProjects } from '@/lib/api';
import { roleLabel } from '@/lib/format';
import { stepFor, hrefForStep } from '@/lib/build-creation';
import type { Role } from '@/lib/types';
import type { BuildRef, PortalUser } from '@/components/PortalShell';

export type BuildShellContext = { user: PortalUser; builds: BuildRef[] };

// `activeName` is the caller's already-fetched build name — the page has it in
// hand (getProject/getBuild), so we do not re-fetch it here. It is guaranteed to
// be present in the switcher even if the list call races or omits a draft.
export async function buildShellContext(
  activeBuildId: string,
  activeName: string,
): Promise<BuildShellContext> {
  const [me, projects] = await Promise.all([getMe(), listProjects()]);
  const user = { displayName: me.displayName, roleLabel: roleLabel(me.role as Role) };
  // A draft switches BACK INTO the wizard at the step it stalled on, not to a
  // half-built record — the same routing the portfolio cards use (PortfolioList).
  const builds: BuildRef[] = projects.map((p) => ({
    id: p.id,
    name: p.name,
    href: hrefForStep(p.id, stepFor(p)),
  }));
  if (!builds.some((b) => b.id === activeBuildId)) {
    builds.unshift({ id: activeBuildId, name: activeName, href: `/projects/${activeBuildId}` });
  }
  return { user, builds };
}
