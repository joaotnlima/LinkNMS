'use client';

// The failure surface (LINA-57).
//
// THIS SCREEN IS THE POINT OF THE WHOLE CUTOVER. Before it, a read failure fell
// back to demo fixtures and the owner saw a beautifully rendered project that
// did not exist. Now they see this. It is a worse experience and a far better
// product: on a record whose only promise is "these numbers are what was
// actually agreed", an outage must look like an outage.
//
// So: no cached last-known-good, no placeholder zeros, no empty state that could
// be mistaken for "nothing has happened yet". Say it failed, say what to do.
import { useEffect } from 'react';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // The digest is the only handle on the server-side stack; without it a
    // production report is unmatchable to a log line.
    console.error('[ui] surface failed to render', error);
  }, [error]);

  return (
    <main className="screen">
      <h1 className="scr">
        <span aria-hidden="true">⚠ </span>
        This record could not be loaded
      </h1>
      <p className="sub">
        We could not reach the shared record, so nothing is shown rather than something we cannot
        stand behind. Nothing you have recorded is lost.
      </p>
      <div className="card stack">
        <button type="button" className="btn primary" onClick={reset}>
          Try again
        </button>
        {error.digest ? <p className="cap">Reference: {error.digest}</p> : null}
      </div>
    </main>
  );
}
