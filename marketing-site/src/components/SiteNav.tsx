'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { HouseMark } from './HouseMark';
import { LangSwitcher } from './LangSwitcher';

const SECTIONS = [
  { id: 'top', key: 'intro' },
  { id: 'features', key: 'features' },
  { id: 'product', key: 'product' },
  { id: 'pricing', key: 'pricing' },
  { id: 'contact', key: 'contact' }
] as const;

// Sticky header: logo lockup · scrollspy nav · always-visible language switcher · CTA.
// Gains the float shadow once the page is scrolled, per the design.
export function SiteNav() {
  const t = useTranslations('nav');
  const [active, setActive] = useState('top');
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) setActive(e.target.id || 'top');
        });
      },
      { rootMargin: '-45% 0px -45% 0px' }
    );
    SECTIONS.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });

    return () => {
      window.removeEventListener('scroll', onScroll);
      observer.disconnect();
    };
  }, []);

  return (
    <nav className={`top${scrolled ? ' scrolled' : ''}`}>
      <a className="brand" href="#top">
        <HouseMark />
        LinkNMS
      </a>
      <ul>
        {SECTIONS.map(({ id, key }) => (
          <li key={id}>
            <a className={`item u${active === id ? ' active' : ''}`} href={`#${id === 'top' ? 'top' : id}`}>
              {t(key)}
            </a>
          </li>
        ))}
      </ul>
      <div className="nav-right">
        <LangSwitcher label={t('langLabel')} />
        <a className="nav-cta u" href="#contact">
          {t('cta')}
        </a>
      </div>
    </nav>
  );
}
