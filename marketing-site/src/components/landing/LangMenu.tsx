'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { track } from '@/lib/analytics-client';
import { usePathname, useRouter } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { CheckIcon, ChevronDownIcon, GlobeIcon } from './icons';

// The design specifies a menu rather than a toggle because it lists nine
// locales (spec §2). The control is built as a menu, but its rows come from
// `routing.locales` — the three we actually translate today. That is the spec's
// own recommendation (§6 Q1) and means adding a locale is a routing change,
// not a component change. Each locale keeps a real URL (/pt/, /en/) via
// next-intl's router, so the switch stays visible to search.

const NATIVE_NAMES: Record<string, string> = {
  pt: 'Português',
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  pl: 'Polski',
  uk: 'Українська',
  ro: 'Română'
};

export function LangMenu() {
  const t = useTranslations('lp.header');
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="lp-lang" ref={wrapRef}>
      <button
        type="button"
        className="lp-lang__trigger lp-micro"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t('langLabel')}
        onClick={() => setOpen((v) => !v)}
      >
        <GlobeIcon />
        <span>{locale.toUpperCase()}</span>
        <ChevronDownIcon />
      </button>

      {open && (
        <ul className="lp-lang__panel" id={panelId}>
          {routing.locales.map((l) => (
            <li key={l}>
              <button
                type="button"
                className="lp-lang__item"
                aria-current={l === locale}
                onClick={() => {
                  setOpen(false);
                  if (l === locale) return;
                  track('language_switch', { from: locale, to: l, location: 'header_menu' });
                  router.replace(pathname, { locale: l });
                }}
              >
                <CheckIcon className="lp-lang__tick" />
                <span>{NATIVE_NAMES[l] ?? l}</span>
                <span className="code lp-micro">{l.toUpperCase()}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
