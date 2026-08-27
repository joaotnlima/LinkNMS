import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'LinkNMS',
  description: 'Shared construction record — R0',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
