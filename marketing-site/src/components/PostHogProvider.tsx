'use client';

import { useEffect, useRef } from 'react';
import { useLocale } from 'next-intl';
import { usePathname } from '@/i18n/navigation';
import {
  initPostHog,
  isAnalyticsEnabled,
  registerGlobals,
  resolveSource,
  track
} from '@/lib/analytics-client';

const SCROLL_THRESHOLDS = [25, 50, 75, 100];

// Client analytics bootstrap. Initializes PostHog (no-op without the key),
// registers the `source`/`locale` super-properties on every event, fires
// `page_view` on each route change, and emits `scroll_depth` at 25/50/75/100%.
// Mounted inside NextIntlClientProvider so useLocale()/usePathname() resolve.
export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const locale = useLocale();
  const pathname = usePathname();
  const firedScroll = useRef<Set<number>>(new Set());

  // One-time: init, register source, and wire the scroll-depth listener.
  useEffect(() => {
    initPostHog();
    if (!isAnalyticsEnabled()) return;
    registerGlobals({ source: resolveSource(), locale });

    const fired = firedScroll.current;
    const onScroll = () => {
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - doc.clientHeight;
      if (scrollable <= 0) return;
      const percent = Math.min(100, Math.round((doc.scrollTop / scrollable) * 100));
      for (const threshold of SCROLL_THRESHOLDS) {
        if (percent >= threshold && !fired.has(threshold)) {
          fired.add(threshold);
          track('scroll_depth', { percent: threshold });
        }
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
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
