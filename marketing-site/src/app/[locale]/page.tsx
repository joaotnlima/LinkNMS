import { getTranslations, setRequestLocale } from 'next-intl/server';
import { SiteNav } from '@/components/SiteNav';
import { Hero } from '@/components/Hero';
import { Audience } from '@/components/Audience';
import { WaitlistForm } from '@/components/WaitlistForm';
import { HouseMark } from '@/components/HouseMark';

type Item = { b: string; s: string };
type Step = { n: string; t: string; b: string };
type Faq = { q: string; a: string };
type PriceCol = { t: string; b: string };

export default async function Home({
  params,
  searchParams
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ confirmed?: string; confirm?: string; source?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  const source = typeof sp.source === 'string' ? sp.source : 'organic';

  const t = await getTranslations();
  const steps = t.raw('how.steps') as Step[];
  const isItems = t.raw('edge.is.items') as Item[];
  const isntItems = t.raw('edge.isnt.items') as Item[];
  const faqs = t.raw('faq.items') as Faq[];
  const priceCols = t.raw('pricing.columns') as PriceCol[];

  const confirmBanner =
    sp.confirmed === '1'
      ? { title: t('waitlist.confirmedTitle'), body: t('waitlist.confirmedBody'), error: false }
      : sp.confirm === 'invalid'
        ? { title: t('waitlist.confirmInvalidTitle'), body: t('waitlist.confirmInvalidBody'), error: true }
        : null;

  return (
    <>
      <SiteNav />
      <div className="serial" aria-hidden="true">
        {t('serial')}
      </div>

      <main>
        <Hero />

        <hr className="divider" />

        <Audience />

        <hr className="divider" />

        {/* How it works — 3 steps */}
        <section className="how wrap">
          <span className="eyebrow">
            <span className="pip" aria-hidden="true" />
            <span>{t('how.eyebrow')}</span>
          </span>
          <h2 className="heading head" style={{ marginTop: 16 }}>
            {t('how.h2')}
          </h2>
          <div className="steps">
            {steps.map((s) => (
              <div className="step" key={s.n}>
                <div className="n">{s.n}</div>
                <div className="t">{s.t}</div>
                <div className="b">{s.b}</div>
              </div>
            ))}
          </div>
        </section>

        <hr className="divider" />

        {/* Reveal 1 — shared record */}
        <section className="reveal wrap" id="features">
          <div className="grid">
            <div>
              <span className="idx">{t('feat.1.idx')}</span>
              <h2 className="heading">{t('feat.1.t')}</h2>
            </div>
            <div className="stage">
              <span className="idx label">Model</span>
              <HouseMark />
            </div>
            <p className="body">{t('feat.1.b')}</p>
          </div>
        </section>

        <hr className="divider" />

        {/* Reveal 2 — history */}
        <section className="reveal wrap">
          <div className="grid">
            <div>
              <span className="idx">{t('feat.2.idx')}</span>
              <h2 className="heading">{t('feat.2.t')}</h2>
            </div>
            <div className="stage">
              <span className="idx label">Model</span>
              <HouseMark flip />
            </div>
            <p className="body">{t('feat.2.b')}</p>
          </div>
        </section>

        <hr className="divider" />

        {/* Reveal 3 — planned vs actual */}
        <section className="reveal wrap" id="product">
          <div className="grid">
            <div>
              <span className="idx">{t('pva.idx')}</span>
              <h2 className="heading">{t('pva.h')}</h2>
            </div>
            <div className="stage">
              <div className="bars" role="img" aria-label={t('pva.aria')}>
                <div className="r">
                  <div className="lab">
                    <span>{t('pva.planned')}</span>
                    <span className="val">{t('pva.plannedVal')}</span>
                  </div>
                  <div className="track">
                    <div className="fill p" style={{ width: '74%' }} />
                  </div>
                </div>
                <div className="r">
                  <div className="lab">
                    <span>{t('pva.actual')}</span>
                    <span className="val">{t('pva.actualVal')}</span>
                  </div>
                  <div className="track">
                    <div className="fill a" style={{ width: '84%' }} />
                  </div>
                </div>
              </div>
            </div>
            <p className="body">{t('pva.b')}</p>
          </div>
        </section>

        <hr className="divider" />

        {/* Is / Isn't */}
        <section className="isnt wrap">
          <span className="eyebrow">
            <span className="pip" aria-hidden="true" />
            <span>{t('edge.eyebrow')}</span>
          </span>
          <h2 className="heading head" style={{ marginTop: 16 }}>
            {t('edge.h2')}
          </h2>
          <div className="split">
            <div className="col is">
              <h3>
                <span className="m" aria-hidden="true" />
                <span>{t('edge.is.t')}</span>
              </h3>
              <ul>
                {isItems.map((it, i) => (
                  <li key={i}>
                    <b>{it.b}</b> <span>{it.s}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="col isnt-c">
              <h3>
                <span className="m" aria-hidden="true" />
                <span>{t('edge.isnt.t')}</span>
              </h3>
              <ul>
                {isntItems.map((it, i) => (
                  <li key={i}>
                    <b>{it.b}</b> <span>{it.s}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <hr className="divider" />

        {/* Pricing direction */}
        <section className="pricing wrap" id="pricing">
          <span className="eyebrow">
            <span className="pip" aria-hidden="true" />
            <span>{t('pricing.eyebrow')}</span>
          </span>
          <h2 className="heading head" style={{ marginTop: 16 }}>
            {t('pricing.h2')}
          </h2>
          <p className="note">{t('pricing.note')}</p>
          <div className="price-cols">
            {priceCols.map((c, i) => (
              <div className="price-col" key={i}>
                <div className="t">{c.t}</div>
                <div className="b">{c.b}</div>
              </div>
            ))}
          </div>
        </section>

        <hr className="divider" />

        {/* FAQ */}
        <section className="faq wrap">
          <span className="eyebrow">
            <span className="pip" aria-hidden="true" />
            <span>{t('faq.eyebrow')}</span>
          </span>
          <h2 className="heading head" style={{ marginTop: 16 }}>
            {t('faq.h2')}
          </h2>
          <div style={{ marginTop: 8 }}>
            {faqs.map((f, i) => (
              <details key={i} open={i === 0}>
                <summary>{f.q}</summary>
                <p className="a" dangerouslySetInnerHTML={{ __html: f.a }} />
              </details>
            ))}
          </div>
        </section>

        <hr className="divider" />

        {/* Waitlist */}
        <section className="contact wrap" id="contact">
          <span className="idx" style={{ display: 'block', marginBottom: 16 }}>
            {t('waitlist.idx')}
          </span>
          <h2 className="heading">{t('waitlist.h2')}</h2>
          <p className="lead body">{t('waitlist.lede')}</p>
          {confirmBanner && (
            <div className={`form-msg${confirmBanner.error ? ' error' : ''}`} role="status" style={{ marginBottom: 32 }}>
              <p className="mt">{confirmBanner.title}</p>
              <p className="mb">{confirmBanner.body}</p>
            </div>
          )}
          <WaitlistForm source={source} />
        </section>
      </main>

      <footer>
        <span className="lock">
          <HouseMark />
          <span>
            <span className="nm">LinkNMS</span>
            <br />
            <span className="sl">
              <b>Trust</b> built-in.
            </span>
          </span>
        </span>
        <nav aria-label="Footer">
          <a href="#features">{t('footer.how')}</a>
          <a href="#contact">{t('footer.wl')}</a>
          <a href="#">{t('footer.privacy')}</a>
          <a href="#">{t('footer.contact')}</a>
        </nav>
        <p className="fine">{t('footer.fine')}</p>
      </footer>
    </>
  );
}
