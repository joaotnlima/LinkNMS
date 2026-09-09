// Surface 3b — Raise a change order (the "Log a change" top-bar action).
//
// A thin server shell so the form wears the unified left-rail chrome like every
// other build-scoped surface (LINA-224): it proves the session, names the build
// for the switcher + breadcrumb, and hands off to the client form that holds the
// input state. The write is authorised server-side on POST — this page decides
// chrome, not permission.
import { redirect } from 'next/navigation';

import { getBuild, isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContext } from '@/server/portal-shell';
import { RaiseChangeOrderForm } from './RaiseChangeOrderForm';

export const dynamic = 'force-dynamic';

export default async function RaiseChangeOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/change-orders/new`);

  const build = await getBuild(id);
  const shell = await buildShellContext(id, build.name);

  return (
    <PortalShell
      user={shell.user}
      builds={shell.builds}
      activeBuild={{ id, name: build.name }}
      crumb="Log a change"
    >
      <main className="screen">
        <div>
          <h1 className="scr">Raise change order</h1>
          <p className="sub">Opens as <strong>proposed</strong>. The budget only moves once the other party approves.</p>
        </div>

        <RaiseChangeOrderForm projectId={id} />
      </main>
    </PortalShell>
  );
}
