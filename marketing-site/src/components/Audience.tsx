'use client';

import { useTranslations } from 'next-intl';

type Card = { t: string; b: string };

// Audience selector: 4 cards. Selecting one locks the rotating hero on the
// matching persona headline via the `lock-hero` event.
export function Audience() {
  const t = useTranslations('audience');
  const cards = t.raw('cards') as Card[];

  const lock = (i: number) => {
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
