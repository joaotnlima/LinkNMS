'use client';

import { useTranslations } from 'next-intl';
import { track } from '@/lib/analytics-client';

type Card = { t: string; b: string };

// Card order is fixed across all locales (homeowner, contractor, sub, architect);
// map the index to the stable persona slug the LINA-33 spec expects.
const PERSONAS = ['homeowner', 'gc', 'sub', 'architect'] as const;

// Audience selector: 4 cards. Selecting one locks the rotating hero on the
// matching persona headline via the `lock-hero` event.
export function Audience() {
  const t = useTranslations('audience');
  const cards = t.raw('cards') as Card[];

  const lock = (i: number) => {
    track('audience_card_click', { persona: PERSONAS[i] ?? String(i) });
    window.dispatchEvent(new CustomEvent<number>('lock-hero', { detail: i }));
    document.getElementById('top')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <section className="audience wrap">
      <span className="eyebrow">
        <span className="pip" aria-hidden="true" />
        <span>{t('eyebrow')}</span>
      </span>
      <h2 className="heading head" style={{ marginTop: 16 }}>
        {t('h2')}
      </h2>
      <div className="cards">
        {cards.map((c, i) => (
          <button key={i} type="button" className="card" onClick={() => lock(i)}>
            <span className="t">
              <span className="m" aria-hidden="true" />
              {c.t}
            </span>
            <span className="b">{c.b}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
