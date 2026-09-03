// Brand tokens for Clerk's prebuilt <SignUp/> and <SignIn/> cards.
//
// Extracted from sign-up/page.tsx in LINA-124 so the two doors cannot drift:
// they are the same screen to a user, and a sign-in card in stock Clerk grey
// beside a branded sign-up card reads as a phishing page, not a product.
//
// The values are the onboarding palette the design brief fixes (Owner Blue, Ink,
// Paper, Inter) — the same ones sign-up.css / onboarding-setup.css declare.
export const clerkAppearance = {
  variables: {
    colorPrimary: '#3e5c8a',
    colorText: '#16181d',
    colorTextSecondary: '#5c5f68',
    colorBackground: '#ffffff',
    colorInputText: '#16181d',
    colorInputBackground: '#fbfaf7',
    colorDanger: '#b4633b',
    fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
    borderRadius: '8px',
  },
  elements: {
    card: {
      border: '1px solid #e4e1d9',
      boxShadow: '0 1px 2px rgba(22,24,29,0.05), 0 12px 32px rgba(22,24,29,0.08)',
      borderRadius: '14px',
    },
    footerActionLink: { color: '#3e5c8a' },
  },
};
