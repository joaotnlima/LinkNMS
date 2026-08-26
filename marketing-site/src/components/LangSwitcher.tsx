'use client';

import { useLocale } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';

const LABELS: Record<string, string> = { pt: 'PT', en: 'EN', es: 'ES' };

// Always-visible language switcher (header). Swapping locale keeps the current
// path; next-intl persists the choice in a cookie so it sticks on return.
export function LangSwitcher({ label }: { label: string }) {
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();

  return (
    <div className="langtoggle" role="group" aria-label={label}>
      {routing.locales.map((l) => (
        <button
          key={l}
          type="button"
          className="langbtn"
          aria-pressed={l === locale}
          onClick={() => router.replace(pathname, { locale: l })}
        >
          {LABELS[l] ?? l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
