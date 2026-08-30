import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { PostHogProvider } from '@/components/PostHogProvider';
import { Archivo, Inter } from 'next/font/google';
import '../globals.css';
import '../landing.css';

// Display face for the landing page (spec §4). Self-hosted by next/font — no
// request to fonts.googleapis.com, `font-display: swap` by default, and only
// the two weights the design actually uses. latin-ext covers pt-PT and es-ES.
const archivo = Archivo({
  subsets: ['latin', 'latin-ext'],
  weight: ['600', '800'],
  display: 'swap',
  variable: '--lp-display'
});

// Inter is the brandbook's --sans. It was previously served as `system-ui`;
// self-hosting it here makes the landing type match the frames without adding
// a network round-trip.
const inter = Inter({
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
  variable: '--lp-sans'
});

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'meta' });
  return {
    metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'),
    title: t('title'),
    description: t('description'),
    icons: {
      icon: [{ url: '/favicon.ico', sizes: 'any' }, { url: '/icon.svg', type: 'image/svg+xml' }],
      apple: '/apple-touch-icon.png'
    },
    openGraph: {
      type: 'website',
      title: t('ogTitle'),
      description: t('ogDescription'),
      images: [{ url: '/og-image.png' }]
    }
  };
}

export default async function LocaleLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  return (
    <html lang={locale} className={`${archivo.variable} ${inter.variable}`}>
      <body>
        <NextIntlClientProvider>
          <PostHogProvider>{children}</PostHogProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
