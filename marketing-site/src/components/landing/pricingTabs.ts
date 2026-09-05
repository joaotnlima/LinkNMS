// Shared vocabulary for the pricing Owner/Builder tabs (LINA-170).
//
// The tabs live in the client `SectionPricingToggle`; the panels they control
// are server-rendered in `SectionPricing`. The id ↔ aria-controls ↔
// aria-labelledby linkage has to agree across that boundary, so it lives here
// — a plain module both sides can import (a `'use client'` module's exports
// become client references and cannot be called while rendering on the server).

export type PricingView = 'owner' | 'builder';

export const PRICING_VIEWS: PricingView[] = ['owner', 'builder'];

export const pricingTabId = (view: PricingView) => `lp-pricing-tab-${view}`;
export const pricingPanelId = (view: PricingView) => `lp-pricing-panel-${view}`;
