'use client';

import { useState } from 'react';

type View = 'owner' | 'builder';

// The Owner/Builder control and the section view are the SAME toggle: it owns
// the state and stamps `data-pricing-view` on the pricing root, which every
// server-rendered subtree (label-bar right, ribbon, plan cards, accent colour)
// reads through CSS. The label bar, head copy and audience hints are handed in
// as already-rendered server nodes so the client bundle stays this thin.
export function SectionPricingToggle({
  labelBar,
  head,
  hints,
  toggle,
  ariaLabel,
  children
}: {
  labelBar: React.ReactNode;
  head: React.ReactNode;
  hints: React.ReactNode;
  toggle: {
    owner: { title: string; sub: string };
    builder: { title: string; sub: string };
  };
  ariaLabel: string;
  children: React.ReactNode;
}) {
  const [view, setView] = useState<View>('owner');

  return (
    <div className="lp-pricing__root" data-pricing-view={view}>
      {labelBar}

      <div className="lp-pricing__head">
        <div className="lp-pricing__head-copy">{head}</div>

        <div className="lp-pricing__head-right">
          <div className="lp-pricing__toggle" role="tablist" aria-label={ariaLabel}>
            {(['owner', 'builder'] as View[]).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                data-opt={v}
                className="lp-pricing__toggle-opt"
                onClick={() => setView(v)}
              >
                <span className="t">{toggle[v].title}</span>
                <span className="s">{toggle[v].sub}</span>
              </button>
            ))}
          </div>
          <div className="lp-pricing__hints lp-micro">{hints}</div>
        </div>
      </div>

      {children}
    </div>
  );
}
