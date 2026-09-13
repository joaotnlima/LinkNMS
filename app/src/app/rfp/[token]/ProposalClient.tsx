'use client';

// /rfp/[token] — the token-scoped proposal form (LINA-284, ADR-0023 §6).
//
// ── WHY THIS IS A CLIENT COMPONENT AND NOT A SERVER ONE ──────────────────────
// Every other read in this app happens in a server component. This one cannot,
// and the reason is specific rather than stylistic: per ADR-0023 §5 the
// `GET /api/rfp/token/:token` call is what MINTS the short-lived scoped cookie
// that the subsequent upload and submit are authenticated by. A `Set-Cookie` on
// a fetch made from a server component lands in the server's own response to
// itself and never reaches the visitor's browser — the page would render and
// then every write would 401. So the read is made from the browser, and the
// price is a loading state on first paint.
//
// ── THE THREE OUTCOMES OF THE READ ───────────────────────────────────────────
//   1. A live token → the specs and the form.
//   2. A dead one (unknown, or the procurement phase closed — the two are not
//      distinguishable to us by design) → a page that ends the visit.
//   3. A live token that has ALREADY been used → straight to the confirmation
//      page. Not an error: the contractor did the thing; showing them an empty
//      form they cannot submit twice would read as their work having been lost.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import {
  DEAD_TOKEN_CODES,
  EMPTY_DRAFT,
  MAX_IMAGE_BYTES,
  MAX_PORTFOLIO_IMAGES,
  RfpTokenError,
  fetchRfpByToken,
  submitProposal,
  submittedPath,
  uploadPortfolioImage,
  validateProposalDraft,
  type FileRef,
  type ProposalDraft,
  type ProposalErrors,
  type RfpTokenView,
} from '@/lib/rfp-proposal';
import { formatBytes } from '@/lib/task-workspace';

import { DeadGlyph, RfpState, RfpShell } from '../RfpShell';

/** The one sentence the dead-link page exists to say (issue LINA-284). */
const CLOSED_TITLE = 'This RFP is no longer accepting proposals.';

type Load =
  | { phase: 'loading' }
  | { phase: 'dead'; message: string }
  | { phase: 'ready'; view: RfpTokenView };

export function ProposalClient({ token }: { token: string }) {
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ phase: 'loading' });

  useEffect(() => {
    let live = true;
    fetchRfpByToken(token)
      .then((view) => {
        if (!live) return;
        // Already bid → the confirmation page holds their details. `replace`, so
        // Back does not bounce them into a form they cannot use.
        if (view.proposal) { router.replace(submittedPath(token)); return; }
        setLoad({ phase: 'ready', view });
      })
      .catch((e: unknown) => {
        if (!live) return;
        const err = e instanceof RfpTokenError ? e : null;
        if (err && err.code === 'already_submitted') {
          router.replace(submittedPath(token));
          return;
        }
        setLoad({
          phase: 'dead',
          message: err && DEAD_TOKEN_CODES.has(err.code)
            ? err.message
            // A network blip is NOT a closed RFP. Saying "no longer accepting
            // proposals" to someone whose wifi dropped would send them away from
            // a bid they could still place.
            : 'We could not load this RFP just now. Check your connection and reload the page.',
        });
      });
    return () => { live = false; };
  }, [token, router]);

  if (load.phase === 'loading') {
    return (
      <RfpShell>
        <RfpState tone="wait" glyph={null} title="Loading this request…">
          <p>One moment.</p>
        </RfpState>
      </RfpShell>
    );
  }

  if (load.phase === 'dead') {
    return (
      <RfpShell>
        <RfpState
          tone="dead"
          glyph={DeadGlyph}
          title={load.message === CLOSED_TITLE ? CLOSED_TITLE : 'This link is not open.'}
        >
          <p>{load.message}</p>
        </RfpState>
      </RfpShell>
    );
  }

  return <ProposalPage token={token} view={load.view} />;
}

function ProposalPage({ token, view }: { token: string; view: RfpTokenView }) {
  const router = useRouter();
  const [draft, setDraft] = useState<ProposalDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<ProposalErrors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState<'idle' | 'uploading' | 'submitting'>('idle');
  const bannerRef = useRef<HTMLParagraphElement | null>(null);

  const set = useCallback(<K extends keyof ProposalDraft>(key: K, value: ProposalDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    // Clearing the field's own error on edit, not on submit: leaving a red note
    // under a box the person has just corrected reads as "still wrong".
    setErrors((e) => (key in e ? { ...e, [key]: undefined } : e));
  }, []);

  const addImages = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    const room = MAX_PORTFOLIO_IMAGES - draft.portfolioImages.length;
    if (room <= 0) return;
    setBusy('uploading');
    setBanner(null);
    const added: FileRef[] = [];
    try {
      for (const file of Array.from(files).slice(0, room)) {
        // Checked here only so an obviously-too-big file fails instantly instead
        // of after a two-minute upload. The server enforces the same cap and IT
        // is the authority — this is a courtesy, like every client-side guard.
        if (file.size > MAX_IMAGE_BYTES) {
          throw new RfpTokenError(
            'attachment_too_large',
            `“${file.name}” is ${formatBytes(file.size)} — the limit is 10 MB per image.`,
            413,
          );
        }
        added.push(await uploadPortfolioImage(token, file));
      }
    } catch (e) {
      setBanner(e instanceof RfpTokenError ? e.message : 'That image did not upload. Try again.');
    } finally {
      // Whatever DID upload is kept. Dropping three good images because the
      // fourth failed is the kind of small cruelty that loses a bid.
      if (added.length) setDraft((d) => ({ ...d, portfolioImages: [...d.portfolioImages, ...added] }));
      setBusy('idle');
    }
  }, [draft.portfolioImages.length, token]);

  const removeImage = useCallback((key: string) => {
    setDraft((d) => ({ ...d, portfolioImages: d.portfolioImages.filter((i) => i.key !== key) }));
  }, []);

  const submit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy !== 'idle') return;
    const checked = validateProposalDraft(draft);
    if (!checked.ok) {
      setErrors(checked.errors);
      setBanner('Some answers need a look before this can be sent.');
      bannerRef.current?.scrollIntoView({ block: 'center' });
      return;
    }
    setErrors({});
    setBanner(null);
    setBusy('submitting');
    try {
      await submitProposal(token, checked.body);
      router.replace(submittedPath(token));
    } catch (e) {
      const err = e instanceof RfpTokenError ? e : null;
      // The window can close between loading this page and pressing Send — the
      // token's validity is derived from the phase, not from a stored expiry
      // (ADR-0023 §5). Say so plainly rather than offering a retry that cannot
      // work.
      setBanner(err?.message ?? 'That did not send. Try again.');
      setBusy('idle');
      bannerRef.current?.scrollIntoView({ block: 'center' });
    }
  }, [busy, draft, router, token]);

  const full = draft.portfolioImages.length >= MAX_PORTFOLIO_IMAGES;

  return (
    <RfpShell>
      <div className="rfp-head">
        <h1>Submit a proposal</h1>
        <p className="rfp-project">{view.project.name}</p>
        {view.project.location ? <p className="rfp-where">{view.project.location}</p> : null}
        <p className="rfp-where">Invitation sent to {view.recipientEmail}</p>
      </div>

      {/* ---- what is being asked for (read-only) ---- */}
      <section className="rfp-sec">
        <h2>Scope of works</h2>
        <div className="card">
          <div className="rfp-body">
            <p className="rfp-scope">{view.rfp.description}</p>

            {view.rfp.specialties.length > 0 ? (
              <div className="rfp-chips">
                {view.rfp.specialties.map((s) => (
                  <span className="badge neutral" key={s}>{s}</span>
                ))}
              </div>
            ) : null}

            {view.rfp.attachments.length > 0 ? (
              <div className="rfp-files">
                {view.rfp.attachments.map((file) => (
                  <a
                    className="rfp-file"
                    key={file.key}
                    href={file.url}
                    target="_blank"
                    // `noopener` because the target is an R2 URL we render but do
                    // not control the contents of.
                    rel="noopener noreferrer"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M6 3h8l4 4v14H6z" strokeLinejoin="round" />
                      <path d="M14 3v4h4" strokeLinejoin="round" />
                    </svg>
                    <span>{file.filename}</span>
                    <span className="rfp-file-size">{formatBytes(file.size)}</span>
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {/* ---- the bid ---- */}
      <section className="rfp-sec">
        <h2>Your proposal</h2>
        {/* noValidate: the browser's own bubbles would pre-empt the field notes
            below, which say the same things in this product's words. */}
        <form className="card" onSubmit={submit} noValidate>
          <div className="rfp-body">
            {banner ? (
              <p className="form-error" role="alert" ref={bannerRef}>{banner}</p>
            ) : null}

            <Field
              id="companyName" label="Company name" error={errors.companyName}
              value={draft.companyName} onChange={(v) => set('companyName', v)}
              autoComplete="organization" maxLength={200}
            />

            <Field
              id="websiteUrl" label="Website (optional)" error={errors.websiteUrl}
              value={draft.websiteUrl} onChange={(v) => set('websiteUrl', v)}
              autoComplete="url" placeholder="acme-builders.com"
              hint="Somewhere the homeowner can see your past work."
            />

            <div className="rfp-grid">
              <Field
                id="budgetMin" label="Budget — lowest" error={errors.budgetMin}
                value={draft.budgetMin} onChange={(v) => set('budgetMin', v)}
                inputMode="decimal" placeholder="$250,000"
              />
              <Field
                id="budgetMax" label="Budget — highest" error={errors.budgetMax}
                value={draft.budgetMax} onChange={(v) => set('budgetMax', v)}
                inputMode="decimal" placeholder="$310,000"
              />
            </div>

            <div className="field">
              <label htmlFor="timelineValue">Timeline estimate</label>
              <div className="rfp-timeline">
                <input
                  id="timelineValue" name="timelineValue" inputMode="numeric"
                  value={draft.timelineValue} placeholder="12"
                  aria-invalid={errors.timelineValue ? 'true' : undefined}
                  aria-describedby={errors.timelineValue ? 'timelineValue-note' : undefined}
                  onChange={(e) => set('timelineValue', e.target.value)}
                />
                <select
                  aria-label="Timeline unit"
                  value={draft.timelineUnit}
                  onChange={(e) => set('timelineUnit', e.target.value === 'days' ? 'days' : 'weeks')}
                >
                  <option value="weeks">weeks</option>
                  <option value="days">days</option>
                </select>
              </div>
              <FieldNote id="timelineValue-note" text={errors.timelineValue} />
            </div>

            {/* ---- portfolio ---- */}
            <div className="field">
              <label htmlFor="portfolio">Portfolio images (optional)</label>
              <div className="rfp-tray">
                {draft.portfolioImages.map((image) => (
                  <figure className="rfp-thumb" key={image.key}>
                    {/* Plain <img>: these are R2 URLs uploaded seconds ago by an
                        unauthenticated visitor, and routing them through the
                        Next image optimiser would make our optimiser fetch an
                        arbitrary just-supplied URL. */}
                    
                    <img src={image.url} alt={image.filename} />
                    <button
                      type="button"
                      onClick={() => removeImage(image.key)}
                      aria-label={`Remove ${image.filename}`}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                      </svg>
                    </button>
                  </figure>
                ))}

                <label
                  className="rfp-add"
                  data-busy={busy === 'uploading' ? 'true' : 'false'}
                  data-full={full ? 'true' : 'false'}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                  </svg>
                  <span>{busy === 'uploading' ? 'Uploading…' : full ? 'Limit reached' : 'Add image'}</span>
                  <input
                    id="portfolio" type="file" accept="image/*" multiple
                    disabled={busy !== 'idle' || full}
                    onChange={(e) => { void addImages(e.target.files); e.target.value = ''; }}
                  />
                </label>
              </div>
              <p className="hint">
                Up to {MAX_PORTFOLIO_IMAGES} photos, 10 MB each. They are shown to the
                homeowner with your proposal.
              </p>
            </div>

            <div className="field">
              <label htmlFor="comment">Comments or questions (optional)</label>
              <textarea
                id="comment" name="comment" rows={5} maxLength={4000}
                value={draft.comment}
                placeholder="Anything the homeowner should know, or anything you need clarified before starting."
                onChange={(e) => set('comment', e.target.value)}
              />
            </div>
          </div>

          <div className="rfp-submit">
            <span className="rfp-submit-note">
              You can send one proposal for this request.
            </span>
            <button className="btn primary" type="submit" disabled={busy !== 'idle'}>
              {busy === 'submitting' ? 'Sending…' : 'Send proposal'}
            </button>
          </div>
        </form>
      </section>
    </RfpShell>
  );
}

/** A red note under a box. Renders nothing when there is nothing wrong. */
function FieldNote({ id, text }: { id: string; text?: string }) {
  if (!text) return null;
  return (
    <p className="rfp-fieldnote" id={id}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5v5.5M12 16.2v.6" strokeLinecap="round" />
      </svg>
      <span>{text}</span>
    </p>
  );
}

/**
 * One labelled text box, its hint and its error.
 *
 * Extracted only because five of them differ in nothing but their strings, and
 * the `aria-invalid` / `aria-describedby` wiring is the part that quietly rots
 * when it is copy-pasted five times.
 */
function Field({
  id, label, value, onChange, error, hint, ...input
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'id' | 'value' | 'onChange'>) {
  const noteId = `${id}-note`;
  const hintId = `${id}-hint`;
  const described = [error ? noteId : null, hint ? hintId : null].filter(Boolean).join(' ');
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id} name={id} value={value}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={described || undefined}
        onChange={(e) => onChange(e.target.value)}
        {...input}
      />
      {hint ? <p className="hint" id={hintId}>{hint}</p> : null}
      <FieldNote id={noteId} text={error} />
    </div>
  );
}
