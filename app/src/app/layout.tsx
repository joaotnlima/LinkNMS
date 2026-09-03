import type { Metadata } from 'next';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'LinkNMS — shared construction record',
  description: 'One shared record of what was agreed, what changed, and what it cost.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="shell">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
