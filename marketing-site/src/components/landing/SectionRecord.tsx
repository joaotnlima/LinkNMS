import { getTranslations } from 'next-intl/server';

// 02 · The Record — blue agreed / orange changed / green closed.
//
// This section is the pen's `new-key-frames > Intro` frame and nothing else:
// label bar (02 · THE RECORD · THREE COLOURS, ONE TRUTH), the three-colour
// encoding, the explainer body and the note.
//
// The four-card scroll reel and the static gantt table that used to sit here
// were BOTH removed for LINA-117 — the founder's note: "this section needs to
// be removed, it's already on the animation above". Everything they showed is
// the pinned <ScrollSequence /> that immediately follows, scrubbed rather than
// laid out flat. A second non-scrubbed copy below the pinned one read as a
// slideshow, which is exactly what the pinned sequence exists to avoid.
// The reel header was also the only source of the stray
// "03 · Scroll build · Image + gantt" label, which the pen does not have.

export async function SectionRecord() {
  const t = await getTranslations('lp.record');

  return (
    <section className="lp-section lp-section--dark lp-record" id="the-record">
      <div className="lp-wrap">
        <div className="lp-labelbar lp-micro">
          <span>02</span>
          <span>{t('label')}</span>
          <span className="rule" aria-hidden="true" />
          <span className="right">{t('labelRight')}</span>
        </div>

        <div className="lp-record__row">
          <h2 className="lp-display lp-record__encoding">
            <span className="baseline">{t('agreed')}</span>
            <span className="actual">{t('changed')}</span>
            <span className="closed">{t('closed')}</span>
          </h2>
          <div className="lp-record__explainer">
            <p className="copy">{t('explainer')}</p>
            <p className="note lp-micro">{t('note')}</p>
            <p className="body body--mobile">{t('explainerMobile')}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
