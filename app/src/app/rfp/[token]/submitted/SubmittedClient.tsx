'use client';

// /rfp/[token]/submitted — the confirmation (LINA-284, ADR-0023 §6).
//
// ── WHY THIS PAGE READS THE API AGAIN ────────────────────────────────────────
// It would be easier to hand the just-submitted proposal across in memory from
// the form. It would also be a lie the moment the contractor bookmarks this URL,
// forwards it to a colleague, or simply reloads — three things people do with a
// page that says "we got it". So the details come from the same
// `GET /api/rfp/token/:token` the form uses, and what is shown is what the
// server actually holds. This is the "who decided this, when" promise applied to
// the one screen an outside party ever sees: the read-back is the record, not a
// souvenir of a form submission.
//
// ── WHAT IT DOES WHEN THE READ FAILS ─────────────────────────────────────────
// The thank-you is still shown, without the details. The proposal was accepted —
// the server said so — and an error page over a transport hiccup would tell the
// contractor their bid vanished. The read-back is the bonus; the confirmation is
// the point. The one case that is NOT softened is a token that never had a
// proposal: that is someone who has landed here without submitting, and telling
// them their proposal is in would be a plain falsehood, so they are sent to the
// form.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import {
  RfpTokenError,
  fetchRfpByToken,
  formatBudgetRange,
  formatTimeline,
  type ProposalView,
  type RfpProjectView,
} from '@/lib/rfp-proposal';
import { formatDateTime } from '@/lib/format';

import { DoneGlyph, RfpState, RfpShell } from '../../RfpShell';

type Load =
  | { phase: 'loading' }
  | { phase: 'bare' }
  | { phase: 'detail'; proposal: ProposalView; project: RfpProjectView };

export function SubmittedClient({ token }: { token: string }) {
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ phase: 'loading' });

  useEffect(() => {
    let live = true;
    fetchRfpByToken(token)
      .then((view) => {
        if (!live) return;
        if (!view.proposal) { router.replace(`/rfp/${encodeURIComponent(token)}`); return; }
        setLoad({ phase: 'detail', proposal: view.proposal, project: view.project });
      })
      .catch((e: unknown) => {
        if (!live) return;
        // An unknown token is the one failure that is NOT softened: nobody
        // reaches this URL with a bad token except by typing it, and thanking
        // them for a proposal that does not exist would be a plain falsehood.
        // Send them to the form, which owns the dead-link page.
        //
        // Everything else — a closed window, a network blip, and
        // `already_submitted` if the server ever starts refusing the read once a
        // bid is in — leaves the confirmation standing without its details.
        const code = e instanceof RfpTokenError ? e.code : 'internal';
        if (code === 'not_found') { router.replace(`/rfp/${encodeURIComponent(token)}`); return; }
        setLoad({ phase: 'bare' });
      });
    return () => { live = false; };
  }, [token, router]);

  if (load.phase === 'loading') {
    return (
      <RfpShell>
        <RfpState tone="wait" glyph={null} title="Loading…" />
      </RfpShell>
    );
  }

  return (
    <RfpShell>
      <RfpState tone="done" glyph={DoneGlyph} title="Your proposal has been submitted.">
        <p>
          {load.phase === 'detail'
            ? `The homeowner for ${load.project.name} will review it and be in touch.`
            : 'The homeowner will review and be in touch.'}
        </p>
      </RfpState>

      {load.phase === 'detail' ? (
        <section className="rfp-sec">
          <h2>What you sent</h2>
          <div className="card">
            <dl className="rfp-facts">
              <Fact label="Company">{load.proposal.companyName}</Fact>

              {load.proposal.websiteUrl ? (
                <Fact label="Website">
                  <a href={load.proposal.websiteUrl} target="_blank" rel="noopener noreferrer">
                    {load.proposal.websiteUrl}
                  </a>
                </Fact>
              ) : null}

              <Fact label="Budget range">
                {/* `.num` for tabular figures: this is the number the whole
                    proposal turns on, and it should line up wherever it is read
                    back. */}
                <span className="num">
                  {formatBudgetRange(load.proposal.budgetMinCents, load.proposal.budgetMaxCents)}
                </span>
              </Fact>

              <Fact label="Timeline">{formatTimeline(load.proposal.timelineDays)}</Fact>

              {load.proposal.portfolioImages.length > 0 ? (
                <Fact label="Portfolio">
                  <span className="rfp-tray">
                    {load.proposal.portfolioImages.map((image) => (
                      <span className="rfp-thumb" key={image.key}>
                        
                        <img src={image.url} alt={image.filename} />
                      </span>
                    ))}
                  </span>
                </Fact>
              ) : null}

              {load.proposal.comment ? (
                <Fact label="Comments" multiline>{load.proposal.comment}</Fact>
              ) : null}

              <Fact label="Sent">{formatDateTime(load.proposal.submittedAt)}</Fact>
            </dl>
          </div>
          <p className="hint">
            This is a read-only copy. To change anything, reply to the invitation
            email — a proposal cannot be re-sent from this link.
          </p>
        </section>
      ) : null}
    </RfpShell>
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
