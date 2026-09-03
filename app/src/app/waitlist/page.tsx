// D-4 Waitlist landing (LINA-126; Onboarding Plan v4, Phase 1 — Waitlist Capture).
//
// A PUBLIC, unauthenticated entry point: unlike the portal Home (which redirects
// a signed-out visitor to /sign-in), this page is the top of the acquisition
// funnel and must render for anyone. It captures an email into the waitlist and,
// on success, shows the D-3 "you're on the list" confirmation inline.
//
// Inter is loaded here via next/font (self-hosted, no layout shift) and handed to
// the scoped .wl stylesheet through the --wl-font CSS variable, so the new
// onboarding brand type is applied without touching the global font token.
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { WaitlistForm } from './WaitlistForm';
import './waitlist.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--wl-font',
});

export const metadata: Metadata = {
  title: 'Join the LinkNMS waitlist — early access',
  description:
    'One shared timeline for every build: the plan in blue, changes in orange, closed work in green. Reserve your early-access seat.',
};

export default function WaitlistPage() {
  return (
    <div className={`wl ${inter.variable}`}>
      <WaitlistForm />
    </div>
  );
}
