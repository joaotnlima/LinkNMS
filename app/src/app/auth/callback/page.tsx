// GET /auth/callback?token=…&next=… — the page the magic link lands on
// (LINA-76, ADR-0007). It POSTs the token to /api/v1/sessions/consume (a route,
// because only a route/action may set the session cookie) and, on success,
// redirects to `next`.
//
// The token travels in a query param on a page WE control, so this page must send
// `Referrer-Policy: no-referrer` — set as a real HTTP header in next.config.mjs
// AND as a <meta> here (defence in depth) — so the token cannot leak in a Referer
// header to any third party the page might touch (ADR-0007 §2).
//
// A same-origin relative `next` only — an absolute or protocol-relative value is
// ignored — so a crafted link cannot use the callback as an open redirect.
'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}

function Callback() {
  const params = useSearchParams();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const token = params.get('token');
    const next = safeNext(params.get('next'));
    if (!token) {
      setFailed(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/v1/sessions/consume', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (cancelled) return;
        if (res.ok) {
          // Replace, not push: the consumed token must not sit in history where a
          // back-button re-fires a now-dead link.
          window.location.replace(next);
        } else {
          setFailed(true);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params]);

  return (
    <>
      {/* Defence in depth alongside the next.config Referrer-Policy header. */}
      <meta name="referrer" content="no-referrer" />
      <main className="screen">
        {failed ? (
          <>
            <div>
              <div className="crumbs">LinkNMS</div>
              <h1 className="scr">This link is no longer valid</h1>
              <p className="sub">
                Sign-in links work once and expire after 15 minutes.
              </p>
            </div>
            <section className="card">
              <p className="cap">
                <a href="/sign-in">Request a new sign-in link</a>.
              </p>
            </section>
          </>
        ) : (
          <div>
            <div className="crumbs">LinkNMS</div>
            <h1 className="scr">Signing you in…</h1>
            <p className="sub">One moment.</p>
          </div>
        )}
      </main>
    </>
  );
}

export default function CallbackPage() {
  return (
    <Suspense fallback={null}>
      <Callback />
    </Suspense>
  );
}
