import { defineRouting } from 'next-intl/routing';

// Locale codes are the URL segments (/pt /en /es); the plan targets pt-PT, EN, es-ES.
export const routing = defineRouting({
  locales: ['pt', 'en', 'es'],
  defaultLocale: 'pt',
  // Auto-detect from Accept-Language on first visit, then persist the choice in a cookie.
  localeDetection: true,
  localePrefix: 'always'
});

export type Locale = (typeof routing.locales)[number];
