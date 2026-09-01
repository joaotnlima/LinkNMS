// FR1, first half — start a shared record with a baseline budget (LINA-57).
//
// The baseline is the number every later claim is measured against, so it is
// captured once, here, deliberately and explicitly. It is entered in currency
// units and converted to integer cents by a single parser that REJECTS anything
// it cannot represent exactly (see parseBudgetToCents) — the cost pillar is only
// as trustworthy as this one field.
import { redirect } from 'next/navigation';
import { TopBar } from '@/components/chrome';
import { ActionForm } from '@/components/ActionForm';
import { createProjectAction } from '@/app/actions';
import { isSignedIn } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function NewProjectPage() {
  if (!(await isSignedIn())) redirect('/sign-in?next=/projects/new');

  return (
    <>
      <TopBar back={{ href: '/', label: 'Home' }} />
      <main className="screen">
        <div>
          <div className="crumbs">New shared record</div>
          <h1 className="scr">Start a project</h1>
          <p className="sub">
            You are the owner. The baseline budget you set here is what every change is measured
            against — it never moves on its own.
          </p>
        </div>

        <section className="card">
          <ActionForm
            action={createProjectAction}
            submitLabel="Create project"
            pendingLabel="Creating…"
          >
            <label className="field">
              <span className="metric-lbl">Project name</span>
              <input name="name" type="text" required maxLength={200} placeholder="e.g. Maple Street rebuild" />
            </label>
            <label className="field">
              <span className="metric-lbl">Baseline budget</span>
              <input
                name="baselineBudget"
                type="text"
                inputMode="decimal"
                required
                placeholder="250000.00"
                aria-describedby="baseline-help"
              />
              <span id="baseline-help" className="cap">
                The agreed starting figure. Only an approved change order can move it.
              </span>
            </label>
          </ActionForm>
        </section>
      </main>
    </>
  );
}
