// /rfp/[token]/submitted — the proposal confirmation (LINA-360, S5; ADR-0023 §6).
//
// ── WHY IT READS THE RECORD BACK ──────────────────────────────────────────────
// It would be easier to hand the just-submitted bid across in memory. It would
// also be a lie the moment the contractor bookmarks this URL, forwards it, or
// reloads. So the details come from the same `GET /rfp-links/{token}` the form
// uses, and what is shown is what the backend actually holds — the "who decided
// this, when" promise applied to the one screen an outside party ever sees.
//
// Now a server component (the v2 link mints no cookie — see the form page): the
// read runs here, with no client transport and no loading flash.
//
// ── WHAT IT DOES WHEN THERE IS NO PROPOSAL ────────────────────────────────────
// A token that never carried a bid is someone who landed here without submitting;
// thanking them for a proposal that does not exist would be a plain falsehood, so
// they are sent to the form, which owns the dead-link and closed pages. A
// transient read failure still shows the thank-you WITHOUT the details: the bid
// was accepted, and an error page over a hiccup would tell them it vanished.
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { loadRfpLink } from '@/lib/v2/rfp-link';
import {
  formatDateOnly,
  formatEuro,
  formatWorkingDays,
  formPath,
  type ProposalEcho,
} from '@/lib/v2/rfp-link-view';

import { DoneGlyph, RfpShell, RfpState } from '../../RfpShell';

export const metadata: Metadata = {
  title: 'Proposal submitted · LinkNMS',
  robots: { index: false, follow: false, nosnippet: true, noarchive: true },
};

export default async function RfpSubmittedPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const load = await loadRfpLink(token);

  // A bad token is the one failure that is NOT softened: nobody reaches this URL
  // with a dead token except by typing it. Send them to the form's dead page.
  if (load.state === 'dead') redirect(formPath(token));

  // A live link with no bid yet → they have not submitted; the form owns that.
  if (load.state === 'ready' && !load.view.proposal) redirect(formPath(token));

  const proposal = load.state === 'ready' ? load.view.proposal : null;
  const projectName = load.state === 'ready' ? load.view.project.name : null;

  return (
    <RfpShell>
      <RfpState tone="done" glyph={DoneGlyph} title="Your proposal has been submitted.">
        <p>
          {projectName
            ? `The homeowner for ${projectName} will review it and be in touch.`
            : 'The homeowner will review and be in touch.'}
        </p>
      </RfpState>

      {proposal ? <Details proposal={proposal} /> : null}
    </RfpShell>
  );
}

function Details({ proposal }: { proposal: ProposalEcho }) {
  return (
    <section className="rfp-sec">
      <h2>What you sent</h2>
      <div className="card">
        <dl className="rfp-facts">
          {proposal.summary?.total ? (
            <Fact label="Total">
              {/* `.num` for tabular figures: the number the whole proposal turns on. */}
              <span className="num">{formatEuro(proposal.summary.total.amount_cents)}</span>
            </Fact>
          ) : null}

          {proposal.summary?.duration_wd != null ? (
            <Fact label="Duration">{formatWorkingDays(proposal.summary.duration_wd)}</Fact>
          ) : null}

          {proposal.validity_until ? (
            <Fact label="Valid until">{formatDateOnly(proposal.validity_until)}</Fact>
          ) : null}

          {proposal.conditions ? (
            <Fact label="Conditions" multiline>{proposal.conditions}</Fact>
          ) : null}

          {proposal.reference_notes ? (
            <Fact label="References" multiline>{proposal.reference_notes}</Fact>
          ) : null}

          {proposal.document_ids.length > 0 ? (
            <Fact label="Portfolio">
              {/* The echo carries ids, not names — the homeowner opens the files
                  from the proposal itself, so a count is the honest thing here. */}
              {proposal.document_ids.length === 1
                ? '1 file attached'
                : `${proposal.document_ids.length} files attached`}
            </Fact>
          ) : null}
        </dl>
      </div>
      <p className="hint">
        This is a read-only copy. To change anything, reply to the invitation
        email — a proposal cannot be re-sent from this link.
      </p>
    </section>
  );
}

function Fact({
  label, children, multiline = false,
}: {
  label: string;
  children: React.ReactNode;
  multiline?: boolean;
}) {
  return (
    <div className="rfp-fact">
      <dt>{label}</dt>
      <dd className={multiline ? 'rfp-multiline' : undefined}>{children}</dd>
    </div>
  );
}
