'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

// Rotating hero: cycles the 4 persona headlines (~3.5s, ~0.5s fade), homeowner
// first. Pauses on pointer/focus interaction, honours reduced-motion, and locks
// on a fixed headline when an audience card is selected (custom `lock-hero` event).
export function Hero() {
  const t = useTranslations('hero');
  const headlines = t.raw('headlines') as string[];
  const [index, setIndex] = useState(0);
  const [fading, setFading] = useState(false);
  const pausedRef = useRef(false);
  const lockedRef = useRef(false);

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || headlines.length <= 1) return;

    const tick = window.setInterval(() => {
      if (pausedRef.current || lockedRef.current) return;
      setFading(true);
      window.setTimeout(() => {
        setIndex((i) => (i + 1) % headlines.length);
        setFading(false);
      }, 500);
    }, 3500);

    const onLock = (e: Event) => {
      const detail = (e as CustomEvent<number>).detail;
      lockedRef.current = true;
      if (typeof detail === 'number') {
        setFading(true);
        window.setTimeout(() => {
          setIndex(detail % headlines.length);
          setFading(false);
        }, 200);
      }
    };
    window.addEventListener('lock-hero', onLock);

    return () => {
      window.clearInterval(tick);
      window.removeEventListener('lock-hero', onLock);
    };
  }, [headlines.length]);

  const pause = () => {
    pausedRef.current = true;
  };
  const resume = () => {
    pausedRef.current = false;
  };

  return (
    <section
      className="hero wrap"
      id="top"
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocusCapture={pause}
    >
      <span className="eyebrow">
        <span className="pip" aria-hidden="true" />
        <span>{t('eyebrow')}</span>
      </span>
      <h1 className={`display hero-headline${fading ? ' fading' : ''}`} aria-live="polite">
        {headlines[index]}
      </h1>
      <p className="lead body">{t('lede')}</p>
      <div className="actions">
        <a className="btn-pill" href="#contact">
          {t('cta')}
        </a>
        <a className="link-u" href="#features">
          {t('link')}
        </a>
      </div>
      <TamperCard />
    </section>
  );
}

function TamperCard() {
  const t = useTranslations('tamper');
  return (
    <aside className="infocard">
      <h4>{t('h')}</h4>
      <hr className="divider" />
      <p>{t('b')}</p>
      <p className="credit">
        — <b>{t('slogan.a')}</b> <span className="bi">{t('slogan.b')}</span>
      </p>
    </aside>
  );
}
