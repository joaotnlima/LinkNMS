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

/**
 * The same brand, dressed for the LINA-191 split-screen door (`AuthShell`).
 *
 * Two differences from the standalone appearance above, and only two:
 *
 *  1. NO CARD CHROME. Inside the auth column the Clerk card *is* the column —
 *     the artboard draws no second border there. The invite-accept screen still
 *     uses `clerkAppearance`, where the card floats on its own and needs it.
 *  2. NO CLERK HEADER. The artboard puts the title and the one-line welcome
 *     above the card, in our type, and Clerk's defaults say something else
 *     ("Welcome back! Please sign in to continue"). Rendering the header
 *     ourselves also means the keyless preview state is titled identically
 *     instead of being an untitled notice.
 *
 * Everything else is handed to CSS via the class-name form of `elements`, so
 * the control spec lives in auth-shell.css next to the layout it belongs to and
 * reads the same tokens — including the dark scheme, which an inline style
 * object of frozen hexes cannot follow.
 *
 * `socialButtonsPlacement: 'top'` matches the artboard: SSO first, "or", then
 * email and password. That order is the design's claim about which door most
 * people use, not a Clerk default worth inheriting silently.
 */
export const authShellAppearance = {
  ...clerkAppearance,
  layout: {
    socialButtonsPlacement: 'top' as const,
    socialButtonsVariant: 'blockButton' as const,
  },
  elements: {
    ...clerkAppearance.elements,
    card: { border: 0, boxShadow: 'none', borderRadius: 0 },
    cardBox: { border: 0, boxShadow: 'none', borderRadius: 0 },
    header: { display: 'none' },
  },
};
