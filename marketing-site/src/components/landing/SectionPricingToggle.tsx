'use client';

import { useRef, useState } from 'react';
import {
  PRICING_VIEWS as VIEWS,
  pricingPanelId,
  pricingTabId,
  type PricingView as View
} from './pricingTabs';

// The Owner/Builder control and the section view are the SAME toggle: it owns
// the state and stamps `data-pricing-view` on the pricing root, which every
// server-rendered subtree (label-bar right, ribbon, plan cards, accent colour)
// reads through CSS. The label bar, head copy and audience hints are handed in
// as already-rendered server nodes so the client bundle stays this thin.
//
// The control is a full WAI-ARIA tabs widget (LINA-170): tablist / tab /
// tabpanel with id ↔ aria-controls ↔ aria-labelledby linkage, roving tabindex
// (only the selected tab is in the tab sequence) and arrow/Home/End roving.
// Activation is automatic — selection follows focus — which the pattern allows
// because both panels are already server-rendered, so switching is free.
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
  const tabRefs = useRef<Partial<Record<View, HTMLButtonElement | null>>>({});

  // Arrow keys move selection (and focus) along the tablist and wrap; Home/End
  // jump to the ends. Everything else falls through to the browser.
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (index + 1) % VIEWS.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (index - 1 + VIEWS.length) % VIEWS.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = VIEWS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    setView(VIEWS[next]);
    tabRefs.current[VIEWS[next]]?.focus();
  };

  return (
    <div className="lp-pricing__root" data-pricing-view={view}>
      {labelBar}

      <div className="lp-pricing__head">
        <div className="lp-pricing__head-copy">{head}</div>

        <div className="lp-pricing__head-right">
          <div className="lp-pricing__toggle" role="tablist" aria-label={ariaLabel}>
            {VIEWS.map((v, i) => (
              <button
                key={v}
                type="button"
                role="tab"
                id={pricingTabId(v)}
                aria-selected={view === v}
                aria-controls={pricingPanelId(v)}
                tabIndex={view === v ? 0 : -1}
                ref={(node) => {
                  tabRefs.current[v] = node;
                }}
                data-opt={v}
                className="lp-pricing__toggle-opt"
                onClick={() => setView(v)}
                onKeyDown={(event) => onKeyDown(event, i)}
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
