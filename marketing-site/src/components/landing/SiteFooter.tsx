import { getTranslations } from 'next-intl/server';
import { LandingMark } from './icons';
import { NavLink, type NavTarget } from './NavLink';

// Footer — four columns: brand / PRODUCT / FOR / COMPANY.
//
// The language control moved to the header (spec §2), so it is deliberately
// absent here. Column links that have no destination yet point at the section
// that covers them rather than at `#`, so nothing in the footer is a dead link.

const COLUMNS = [
  {
    key: 'product',
    items: [
      { key: 'record', href: '#the-record' },
      { key: 'plan', href: '#getting-the-plan-in' },
      { key: 'money', href: '#materials-and-money' },
      { key: 'materials', href: '#materials-and-money' },
      { key: 'history', href: '#the-record' },
      { key: 'pricing', href: '#pricing' }
    ]
  },
  {
    key: 'for',
    items: [
      { key: 'owners', href: '#who-it-is-for' },
      { key: 'builders', href: '#who-it-is-for' },
      { key: 'partners', href: '#getting-the-plan-in' },
      { key: 'architects', href: '#who-it-is-for' }
    ]
  },
  {
    key: 'company',
    items: [
      { key: 'about', href: '#top' },
      { key: 'research', href: '#who-it-is-for' },
      { key: 'privacy', href: '#top' },
      { key: 'contact', href: '#request-access' }
    ]
  }
] as const;

export async function SiteFooter() {
  const t = await getTranslations('lp.footer');
  const year = 2026;

  return (
    <footer className="lp-footer">
      <div className="lp-wrap">
        <div className="lp-footer__cols">
          <div>
            <span className="lp-footer__lockup">
              <LandingMark size={26} />
              <span>linknms</span>
            </span>
            <p className="lp-footer__tagline">{t('tagline')}</p>
          </div>

          {COLUMNS.map((col) => (
            <nav key={col.key} aria-labelledby={`footer-${col.key}`}>
              <h2 className="lp-micro" id={`footer-${col.key}`}>
                {t(`${col.key}.head`)}
              </h2>
              <ul>
                {col.items.map((item) => (
                  <li key={item.key}>
                    <NavLink href={item.href} target={`footer_${col.key}` as NavTarget}>
                      {t(`${col.key}.${item.key}`)}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="lp-footer__bottom lp-micro">
          <span>{t('copyright', { year })}</span>
          <span className="legal">
            <a href="#top">{t('privacy')}</a>
            <a href="#top">{t('terms')}</a>
          </span>
        </div>
      </div>
    </footer>
  );
}
