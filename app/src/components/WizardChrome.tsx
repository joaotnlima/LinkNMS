// Band B — the "New build" wizard chrome (LINA-219, pen-rebuilt).
//
// The new pen (`cowork/pen/linkNMS.pen`, republished c6276a3) draws the create
// flow as a FULL-SCREEN TAKEOVER, not a page inside the portal shell: its own top
// bar (house-mark + "New build" on the left, "Cancel" on the right) over a warm
// beige page, with a centred white card. That is a different frame from the
// authenticated portal (which carries the Home/integrity bar and the bottom
// nav), so this renders neither — starting a build is a modal task with one way
// out (Cancel → the portal home), and the surrounding app chrome would only
// invite the owner to wander off a flow they meant to finish.
//
// Breaking out of the 780px `.shell` reading column uses the same `:has()` escape
// AuthShell (LINA-191) established, so there is exactly one pattern for a
// full-bleed surface in this app, not two.
import Link from 'next/link';
import { Mark } from '@/components/icons';

/**
 * The wizard's outermost element. `.bwx` is what the shell's `:has()` rule keys
 * off to drop its max-width and shadow (see build-wizard.css), so every wizard
 * page renders this as the shell's direct child.
 */
export function WizardChrome({ children }: { children: React.ReactNode }) {
  return (
    <div className="bwx">
      <header className="bwx-bar">
        <span className="bwx-brand">
          <Mark className="bwx-mark" />
          New build
        </span>
        {/* Cancel, not "Home": on this surface the exit is abandoning a task, and
            naming it Cancel is what tells the owner leaving here is safe (the
            draft is already saved server-side from step 1). */}
        <Link className="bwx-cancel" href="/">
          Cancel
        </Link>
      </header>
      <main className="bwx-main">{children}</main>
    </div>
  );
}
