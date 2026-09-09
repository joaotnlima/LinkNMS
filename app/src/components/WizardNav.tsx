// Band B wizard footer nav (LINA-219). The pen puts the step's controls BELOW
// the card, not inside it: a secondary "← Back" on the left (steps 2 and 3) and
// the primary "Continue →" / "Send invite →" on the right. This renders that row;
// the button is passed in by the step so it stays the form's real submit (its
// pending state comes from ActionForm's `footer` slot).
import Link from 'next/link';

export function ArrowRight({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden="true" width="16" height="16">
      <path d="M4 10h11M11 5l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ArrowLeft({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden="true" width="16" height="16">
      <path d="M16 10H5M9 5l-5 5 5 5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * @param back  href/label for the secondary back control, omitted on step 1.
 * @param children  the primary submit button (rendered by the step so it stays
 *                  the form's submit and carries ActionForm's pending state).
 */
export function WizardNav({
  back,
  children,
}: {
  back?: { href: string; label?: string };
  children: React.ReactNode;
}) {
  return (
    <nav className="bwx-nav" aria-label="Wizard navigation">
      {back ? (
        <Link className="btn bwx-back" href={back.href}>
          <ArrowLeft />
          {back.label ?? 'Back'}
        </Link>
      ) : (
        <span />
      )}
      {children}
    </nav>
  );
}
