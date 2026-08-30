'use client';

import { useEffect } from 'react';
import { useLocale } from 'next-intl';
import { usePathname } from '@/i18n/navigation';
import {
  initPostHog,
  isAnalyticsEnabled,
  registerGlobals,
  resolveSource,
  track
} from '@/lib/analytics-client';
import { resolveRenderPath } from '@/lib/landing-render-path';

// Client analytics bootstrap (event map: `landing-event-map-v2`, LINA-78).
// Initializes PostHog (no-op without the key), registers the super-properties
// that every event has to carry, and fires `page_view` on each route change.
//
// `scroll_depth` is RETIRED here: with a pinned 300vh section, scroll
// percentage stops tracking reading progress, so the event map replaces it with
// `section_view`. `hero_view` is likewise gone — it is subsumed by
// `section_view{section:'hero'}`.
export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const locale = useLocale();
  const pathname = usePathname();

  // One-time: init and register the super-properties.
  useEffect(() => {
    initPostHog();
    if (!isAnalyticsEnabled()) return;

    const { renderPath, staticReason } = resolveRenderPath();
    registerGlobals({
      source: resolveSource(),
      locale,
      // Hard-separates pre/post-redesign data in every breakdown, which is what
      // makes it safe to reuse event names whose meaning shifted.
      page_version: 'v2',
      // Which scroll-sequence experience was actually served. On every event,
      // not just sequence events — otherwise we can compare engagement between
      // the two paths but not conversion.
      render_path: renderPath,
      static_reason: staticReason
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep `locale` in sync as a super-property when the user switches language.
  useEffect(() => {
    registerGlobals({ locale });
  }, [locale]);

  // page_view on every route/locale change.
  useEffect(() => {
    track('page_view', {
      path: pathname,
      referrer: (typeof document !== 'undefined' && document.referrer) || undefined
    });
  }, [pathname, locale]);

  return <>{children}</>;
}
