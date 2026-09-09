// M3/D3 — "New build · Operating model", step 2 of Band B (LINA-179).
//
// Pen source: Bootstrap Flow Board, screen 03, plus its design note "Operating
// model asked once" — the Turnkey / Direct-to-specialty / Hybrid choice is
// captured here and never asked again, because it shapes who may be invited and
// who has to approve what for the life of the build (ADR-0011 decision 1).
//
// Since the choice is permanent, this screen SAYS SO, and says what each option
// decides. The pen files that under "design decision"; a decision the user cannot
// revisit and was never told about is the exact class of surprise this product
// exists to eliminate.
//
// Two guards, both of which turn a would-be 4xx into a sensible screen. The
// service remains the authority on each (owner-only, draft-only):
//   * not the owner  → their own build page. This is a wizard the owner is in
//                      the middle of; a joined GC landing here has nothing to do.
//   * already active → the build page. The model is fixed once the first invite
//                      commits the build, and the PATCH would 409.
import { redirect } from 'next/navigation';
import Link from 'next/link';

import { TopBar } from '@/components/chrome';
import { WizardSteps } from '@/components/WizardSteps';
import { OperatingModelPicker } from './OperatingModelPicker';
import { getBuild } from '@/lib/api';
import { stepFor, type OperatingModel } from '@/lib/build-creation';
import '../../../build-wizard.css';

export const dynamic = 'force-dynamic';

export default async function OperatingModelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const build = await getBuild(id);

  if (build.actingRole !== 'owner') redirect(`/projects/${id}`);
  // `stepFor` is the one place that reads the draft truth table. 'invite' is NOT
  // redirected: stepping back to change the model before committing is legitimate
  // and the service allows it (the build is still a draft).
  if (stepFor(build) === 'done') redirect(`/projects/${id}`);

  return (
    <>
      <TopBar back={{ href: '/projects/new', label: 'Basics' }} />
      <main className="bw">
        <WizardSteps current="model" />

        <div className="bw-head">
          <div className="crumbs">{build.name}</div>
          <h1 className="bw-title">How is this build contracted?</h1>
          <p className="bw-lede">
            This shapes who you invite and who fills in the plan. It is asked once, now — the rest
            of the build assumes your answer, and you will not be asked again.
          </p>
        </div>

        <section className="bw-card">
          <OperatingModelPicker
            projectId={id}
            selected={(build.operatingModel ?? null) as OperatingModel | null}
          />

          <p className="bw-once">
            You cannot change this after you invite someone — the record would then carry parties
            whose permissions came from a different answer.
          </p>
          {/* The draft is already saved server-side, so leaving is not losing
              anything; the build keeps its permanent URL. */}
          <Link className="bw-skip" href={`/projects/${id}`}>
            Not sure yet? Leave it as a draft and come back
          </Link>
        </section>
      </main>
    </>
  );
}
