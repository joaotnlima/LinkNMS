'use client';

import { useState } from 'react';

type View = 'owner' | 'builder';

export function SectionPricingToggle({
  labelOwner,
  labelBuilder,
  children
}: {
  labelOwner: string;
  labelBuilder: string;
  children: React.ReactNode;
}) {
  const [view, setView] = useState<View>('owner');

  return (
    <div data-pricing-view={view}>
      <div className="lp-pricing__tabbar lp-micro" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'owner'}
          className="lp-pricing__tab"
          onClick={() => setView('owner')}
        >
          {labelOwner}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'builder'}
          className="lp-pricing__tab"
          onClick={() => setView('builder')}
        >
          {labelBuilder}
        </button>
      </div>
      {children}
    </div>
  );
}
