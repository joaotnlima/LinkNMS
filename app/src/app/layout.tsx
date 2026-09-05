import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Providers } from '@/components/providers';
import './globals.css';

// Inter is the brand text face (tokens.json --sans). Loaded once here, at the
// root, and exposed as --font-inter so globals.css can lead the --font stack
// with the self-hosted face. Before LINA-156 the portal never loaded Inter and
// silently fell back to system-ui; the onboarding surfaces scoped their own
// next/font copy, which this replaces.
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: 'LinkNMS — shared construction record',
  description: 'One shared record of what was agreed, what changed, and what it cost.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <Providers>
          <div className="shell">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
