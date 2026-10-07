// /rfp/[token] — the public, token-gated proposal form (LINA-360, S5; ADR-0023
// §6). Cut from the v1 surface to the v2 tendering `security: []` link
// (LINA-322).
//
// ── WHY THIS IS NOW A SERVER COMPONENT (it was a client one on v1) ────────────
// The v1 read had to run in the browser because `GET /api/v1/rfp/token/:token`
// MINTED a scoped cookie, and a Set-Cookie on a server-side fetch never reaches
// the visitor. The v2 link mints no cookie — the token is re-supplied on every
// call from the route param — so the read runs here, on the server, with no
// loading flash and no client transport. The only interactive part, the bid
// form, is the one client island (ProposalForm), and it writes through a server
// action (actions.ts).
//
// ── noindex, and no middleware entry ─────────────────────────────────────────
// The URL carries a live credential. `noindex,nofollow,nosnippet,noarchive` keep
// a token out of every index and cache — there is no revoking one that leaks.
// `/rfp` is deliberately absent from `isProtectedRoute` (src/middleware.ts): a
// rule that granted access here would be a rule that could be got wrong.
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { loadRfpLink } from '@/lib/v2/rfp-link';
import {
  formatDateOnly,
  submittedPath,
  type PackageItem,
  type RfpLinkView,
} from '@/lib/v2/rfp-link-view';

import { DeadGlyph, RfpShell, RfpState } from '../RfpShell';
import { ProposalForm } from './ProposalForm';

export const metadata: Metadata = {
  title: 'Submit a proposal · LinkNMS',
  robots: { index: false, follow: false, nosnippet: true, noarchive: true },
};

/** The dead-link and closed-window pages both say a version of this one line. */
const CLOSED_TITLE = 'This request is no longer accepting proposals.';

export default async function RfpTokenPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const load = await loadRfpLink(token);

  if (load.state === 'dead') {
    return (
      <RfpShell>
        <RfpState tone="dead" glyph={DeadGlyph} title="This link is not open.">
          <p>This link is not valid. Ask whoever invited you to send a new one.</p>
        </RfpState>
      </RfpShell>
    );
  }

  if (load.state === 'error') {
    // A transient failure is NOT a closed RFP — offer the reload, do not send
    // them away from a bid they could still place.
    return (
      <RfpShell>
        <RfpState tone="dead" glyph={DeadGlyph} title="We could not load this request.">
          <p>Check your connection and reload the page.</p>
        </RfpState>
      </RfpShell>
    );
  }

  const { view } = load;

  // Already bid → the confirmation page holds their details. A returning visitor
  // sees what they sent, not a second form they cannot use.
  if (view.proposal) redirect(submittedPath(token));

  // Live token, but the window has since closed and no bid was placed → the same
  // end-of-visit page, worded as a closure (the GET told us in one call).
  if (view.closed) {
    return (
      <RfpShell>
        <RfpState tone="dead" glyph={DeadGlyph} title={CLOSED_TITLE}>
          <p>The window for this request has closed. There is nothing to send.</p>
        </RfpState>
      </RfpShell>
    );
  }

  return (
    <RfpShell>
      <div className="rfp-head">
        <h1>Submit a proposal</h1>
        <p className="rfp-project">{view.project.name}</p>
        {view.project.location ? <p className="rfp-where">{view.project.location}</p> : null}
        <p className="rfp-where">Invitation sent to {view.recipient_email}</p>
      </div>

      <Scope view={view} />

      <section className="rfp-sec">
        <h2>Your proposal</h2>
        <ProposalForm token={token} mode={view.rfp.mode} />
      </section>
    </RfpShell>
  );
}

/** The read-only ask: scope text, trades, deadline and the package to price. */
function Scope({ view }: { view: RfpLinkView }) {
  const { rfp } = view;
  const items = rfp.package.items;
  return (
    <section className="rfp-sec">
      <h2>{rfp.title}</h2>
      <div className="card">
        <div className="rfp-body">
          {rfp.scope_text ? <p className="rfp-scope">{rfp.scope_text}</p> : null}

          {rfp.specialties.length > 0 ? (
            <div className="rfp-chips">
              {rfp.specialties.map((s) => (
                <span className="badge neutral" key={s}>{s}</span>
              ))}
            </div>
          ) : null}

          {rfp.submission_deadline ? (
            <p className="hint">
              Proposals are due by {formatDateOnly(rfp.submission_deadline.slice(0, 10))}.
            </p>
          ) : null}

          {items.length > 0 ? <PackageTable items={items} /> : null}
        </div>
      </div>
    </section>
  );
}

/**
 * The bill of quantities to price — structure and quantities, never prices (the
 * package carries none, doc 05 §10). Rendered as a plain read-only table so the
 * bidder can see exactly what the single total is being asked to cover.
 */
function PackageTable({ items }: { items: PackageItem[] }) {
  return (
    <table className="rfp-package">
      <thead>
        <tr>
          <th scope="col">Code</th>
          <th scope="col">Description</th>
          <th scope="col">Unit</th>
          <th scope="col" className="num">Qty</th>
        </tr>
      </thead>
      <tbody>
        {items.map((it) => (
          <tr key={it.rfp_item_id}>
            <td>{it.code}</td>
            <td>{it.description}</td>
            <td>{it.unit}</td>
            <td className="num">{it.quantity}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
