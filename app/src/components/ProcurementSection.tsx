'use client';

// The procurement section — the RFP that goes out, and the proposals that come
// back (LINA-283). It renders INSIDE the Procurement accordion section of
// `/projects/:id/plan` (ADR-0023 §4/§6; the accordion shell itself is LINA-281),
// which is why this file owns no heading chrome, no route and no page shell: it
// is a section body, mounted by the shell.
//
// Brand-book: brand-book/src/components/Procurement.stories.js — the composer,
// the recipient row, the proposal card and the four badges have one home there,
// as every plan primitive does.
//
// ── WHAT THIS SURFACE PROMISES ───────────────────────────────────────────────
// 1. THE SEND IS A DOOR, AND IT IS DRAWN AS ONE. Sending mints a live token per
//    recipient and emails strangers on the owner's behalf; it cannot be undone
//    from here. So it confirms first, and it says how many people it is about to
//    write to — a one-click "Send" on an irreversible broadcast is a trap.
// 2. A DRAFT IS PRIVATE UNTIL IT IS SENT. The composer says so in as many words,
//    the same promise the plan draft makes (ADR-0011/LINA-230). Nothing about a
//    draft RFP is visible to a recipient, because no token exists yet.
// 3. NOTHING IS THROWN AWAY. Every proposal stays in the inbox after a
//    constructor is chosen — the losing bids are the evidence behind the choice,
//    and "who else did you ask, and what did they quote?" is precisely the
//    lookup this product exists for.
// 4. THE NUMBERS ARE QUOTED, NEVER COMPUTED. A bid's range and timeline are
//    printed as submitted. No total, no average, no "best value" ranking — the
//    owner ranks bids, we do not.
// 5. DISABLED CONTROLS SAY WHY. Send, Select and Skip each carry their own
//    reason when they are off, rather than sitting greyed out with no account of
//    themselves.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  addRecipients, budgetRange, canSkipToExecution, fetchProcurement, inboxRows,
  parseRecipients, ProcurementError, recipientBadge, removeRecipient, saveRfpDraft,
  selectProposal, sendBlockedReason, sendRfp, skipProcurement, timelineWords,
  uploadRfpAttachment,
  type FileRef, type ProcurementView,
} from '@/lib/procurement';
import './procurement.css';

export function ProcurementSection({
  projectId, initialView = null, onPhaseChanged,
}: {
  projectId: string;
  /**
   * The server's read, when the page already had one. The section still fetches
   * on mount when this is null — the accordion may render a collapsed section
   * whose body is only needed once opened.
   */
  initialView?: ProcurementView | null;
  /**
   * Called after a transition that ends procurement (a constructor selected, or
   * Persona B skipping). The shell owns the accordion's expanded section and the
   * Execution body, so it is told rather than reaching in here for it.
   */
  onPhaseChanged?: (view: ProcurementView) => void;
}) {
  const [view, setView] = useState<ProcurementView | null>(initialView);
  const [loading, setLoading] = useState(initialView === null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'save' | 'upload' | 'recipients' | 'send' | 'select' | 'skip'>(null);

  useEffect(() => {
    if (initialView !== null) return;
    let live = true;
    setLoading(true);
    fetchProcurement(projectId)
      .then((v) => { if (live) setView(v); })
      .catch((e) => {
        if (!live) return;
        setError(e instanceof ProcurementError ? e.message : 'Could not load procurement.');
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [projectId, initialView]);

  // One place where a call's refusal becomes a sentence, so every action in this
  // section fails the same way instead of each inventing its own wording.
  const run = useCallback(async <T,>(
    kind: NonNullable<typeof busy>, fallback: string, call: () => Promise<T>,
  ): Promise<T | null> => {
    setBusy(kind);
    setError(null);
    try {
      return await call();
    } catch (e) {
      setError(e instanceof ProcurementError ? e.message : fallback);
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  if (loading) return <p className="prc-quiet" role="status">Loading procurement…</p>;

  if (!view) {
    return (
      <p role="alert" className="prc-error">
        {error ?? 'Could not load procurement.'}
      </p>
    );
  }

  const sent = view.rfp !== null && view.rfp.status !== 'draft';

  return (
    <div className="prc">
      {error ? <p role="alert" className="prc-error">{error}</p> : null}

      {/* Persona B's door, and the legacy-project fallback (ADR-0023 §3 Option
          B). It sits at the top because it is the "this section is not for me"
          answer — the owner who already has a contractor should not have to read
          the RFP composer to find out they can leave. */}
      {canSkipToExecution(view) ? (
        <SkipToExecution
          busy={busy === 'skip'}
          hasDraft={view.rfp !== null}
          onSkip={async () => {
            const next = await run('skip', 'Could not start execution. Try again.',
              () => skipProcurement(projectId));
            if (next) { setView(next); onPhaseChanged?.(next); }
          }}
        />
      ) : null}

      <RfpComposer
        view={view}
        busy={busy}
        locked={sent}
        onSaveDraft={async (draft) => {
          const rfp = await run('save', 'That did not save. Try again.',
            () => saveRfpDraft(projectId, draft));
          if (rfp) setView((prev) => (prev ? { ...prev, rfp } : prev));
        }}
        onUpload={async (file) => {
          const attachment = await run('upload', 'That file did not upload. Try again.',
            () => uploadRfpAttachment(projectId, file));
          if (attachment) {
            setView((prev) => (prev && prev.rfp
              ? { ...prev, rfp: { ...prev.rfp, attachments: [...prev.rfp.attachments, attachment] } }
              : prev));
          }
        }}
        onAddRecipients={async (emails) => {
          const recipients = await run('recipients', 'Those addresses did not save. Try again.',
            () => addRecipients(projectId, emails));
          // The server's rows, never our echo: the id and the status are ITS
          // answer, and a locally-invented recipient could not be removed again.
          if (recipients) setView((prev) => (prev ? { ...prev, recipients } : prev));
        }}
        onRemoveRecipient={async (recipientId) => {
          const ok = await run('recipients', 'That did not come off the list. Try again.',
            async () => { await removeRecipient(projectId, recipientId); return true; });
          if (ok) {
            setView((prev) => (prev
              ? { ...prev, recipients: prev.recipients.filter((r) => r.id !== recipientId) }
              : prev));
          }
        }}
        onSend={async () => {
          const next = await run('send', 'The RFP did not go out. Try again.',
            () => sendRfp(projectId));
          if (next) setView(next);
        }}
      />

      {sent ? (
        <ProposalsInbox
          view={view}
          busy={busy === 'select'}
          onSelect={async (proposalId) => {
            const next = await run('select', 'That selection did not go through. Try again.',
              () => selectProposal(projectId, proposalId));
            if (next) { setView(next); onPhaseChanged?.(next); }
          }}
        />
      ) : null}
    </div>
  );
}

// ── Skip to execution ────────────────────────────────────────────────────────

function SkipToExecution({
  busy, hasDraft, onSkip,
}: {
  busy: boolean;
  hasDraft: boolean;
  onSkip: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="prc-skip" aria-label="Skip procurement">
      <div className="prc-skip-copy">
        <p className="prc-skip-t">Already have a contractor?</p>
        <p className="prc-quiet">
          Skip the tender and go straight to the build plan. Procurement closes and this section
          stays here, read-only, as part of the record.
          {hasDraft ? ' Your draft RFP is kept — it is simply never sent.' : ''}
        </p>
      </div>
      {confirming ? (
        <div className="prc-confirm" role="group" aria-label="Confirm skipping procurement">
          <button type="button" className="btn" onClick={() => setConfirming(false)}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={onSkip}>
            {busy ? 'Starting…' : 'Yes, start execution'}
          </button>
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => setConfirming(true)}>
          Skip to execution
        </button>
      )}
    </section>
  );
}

// ── The composer ─────────────────────────────────────────────────────────────

function RfpComposer({
  view, busy, locked, onSaveDraft, onUpload, onAddRecipients, onRemoveRecipient, onSend,
}: {
  view: ProcurementView;
  busy: string | null;
  locked: boolean;
  onSaveDraft: (draft: { description: string; specialties: string[] }) => void;
  onUpload: (file: File) => void;
  onAddRecipients: (emails: string[]) => void;
  onRemoveRecipient: (recipientId: string) => void;
  onSend: () => void;
}) {
  const { rfp, recipients } = view;
  const [started, setStarted] = useState(rfp !== null);
  const [description, setDescription] = useState(rfp?.description ?? '');
  const [specialties, setSpecialties] = useState<string[]>(rfp?.specialties ?? []);
  const [tagDraft, setTagDraft] = useState('');
  const [emailDraft, setEmailDraft] = useState('');
  const [rejected, setRejected] = useState<{ invalid: string[]; duplicates: string[] } | null>(null);
  const [confirmingSend, setConfirmingSend] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // The server's copy wins whenever it lands (a save returns the stored row), so
  // a normalised description or a de-duplicated tag list shows up here rather
  // than leaving the box holding something the record does not.
  useEffect(() => {
    if (!rfp) return;
    setDescription(rfp.description);
    setSpecialties(rfp.specialties);
    setStarted(true);
  }, [rfp]);

  const blocked = sendBlockedReason(
    rfp ? { description, status: rfp.status } : null, recipients,
  );

  const emails = useMemo(() => recipients.map((r) => r.email), [recipients]);

  const addEmails = () => {
    const parsed = parseRecipients(emailDraft, emails);
    setRejected(
      parsed.invalid.length || parsed.duplicates.length
        ? { invalid: parsed.invalid, duplicates: parsed.duplicates }
        : null,
    );
    if (parsed.valid.length === 0) return;
    onAddRecipients(parsed.valid);
    // Only what was accepted leaves the box: a typo stays visible to be fixed
    // rather than being swallowed by a successful-looking clear.
    setEmailDraft(parsed.invalid.join(', '));
  };

  const addTag = () => {
    const tag = tagDraft.trim().toLowerCase();
    if (!tag || specialties.includes(tag)) { setTagDraft(''); return; }
    setSpecialties([...specialties, tag]);
    setTagDraft('');
  };

  // ── Nothing started yet (pen: "[+ Create RFP]") ────────────────────────────
  if (!started && !rfp) {
    return (
      <section className="prc-start" aria-label="Request for proposals">
        <h3 className="prc-h">Ask contractors to bid</h3>
        <p className="prc-quiet">
          Describe the work, attach the drawings, and send it to as many contractors as you like.
          They reply with a price, a timeline and their portfolio — from a link, with no account to
          create. Nothing is sent until you say so.
        </p>
        <button type="button" className="btn primary" onClick={() => setStarted(true)}>
          Create RFP
        </button>
      </section>
    );
  }

  return (
    <section className="prc-composer" aria-label="Request for proposals">
      <div className="prc-composer-hd">
        <h3 className="prc-h">Request for proposals</h3>
        {locked ? (
          <span className="prc-badge good">Sent</span>
        ) : (
          <span className="prc-badge quiet">Draft — not sent</span>
        )}
      </div>

      {locked ? (
        <p className="prc-quiet">
          This RFP is out with {recipients.length} {recipients.length === 1 ? 'contractor' : 'contractors'}.
          The brief is frozen now: everyone must be bidding on the same words.
        </p>
      ) : (
        <p className="prc-quiet">
          Private until you send it. No contractor can see this — the invitation links do not exist
          yet.
        </p>
      )}

      {/* ── The brief ───────────────────────────────────────────────────── */}
      <div className="prc-field">
        <label className="prc-label" htmlFor="prc-description">The work</label>
        <textarea
          id="prc-description"
          className="prc-input"
          value={description}
          maxLength={8000}
          readOnly={locked}
          aria-readonly={locked}
          placeholder="What is being built, the site, the scope you want priced, and anything a contractor must know to quote honestly."
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      {/* ── Specialties ─────────────────────────────────────────────────── */}
      <div className="prc-field">
        <span className="prc-label" id="prc-spec-label">Trades wanted</span>
        <ul className="prc-tags" aria-labelledby="prc-spec-label">
          {specialties.length === 0 ? (
            <li className="prc-quiet">No trades tagged yet — the brief alone will have to say it.</li>
          ) : specialties.map((tag) => (
            <li key={tag} className="prc-tag">
              {tag}
              {locked ? null : (
                <button
                  type="button"
                  className="prc-tag-x"
                  aria-label={`Remove ${tag}`}
                  onClick={() => setSpecialties(specialties.filter((t) => t !== tag))}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
        {locked ? null : (
          <div className="prc-row">
            <input
              className="prc-line"
              value={tagDraft}
              placeholder="groundworks, roofing, electrical…"
              aria-label="Add a trade"
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
            />
            <button type="button" className="btn" onClick={addTag} disabled={!tagDraft.trim()}>
              Add trade
            </button>
          </div>
        )}
      </div>

      {/* ── Attachments ─────────────────────────────────────────────────── */}
      <div className="prc-field">
        <div className="prc-field-hd">
          <span className="prc-label">Drawings &amp; documents</span>
          {locked ? null : (
            <button
              type="button"
              className="btn"
              disabled={busy === 'upload' || !rfp}
              onClick={() => fileInput.current?.click()}
            >
              {busy === 'upload' ? 'Uploading…' : 'Attach a file'}
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            className="prc-fileinput"
            aria-label="Attach a file to this RFP"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onUpload(file);
              e.target.value = ''; // the same file twice must still fire
            }}
          />
        </div>
        {!rfp ? (
          <p className="prc-quiet">Save the draft first — a file needs an RFP to hang on.</p>
        ) : rfp.attachments.length === 0 ? (
          <p className="prc-quiet">
            No files yet. Plans, surveys and photos up to 10 MB — whatever a contractor needs to
            price the job.
          </p>
        ) : (
          <ul className="prc-files">
            {rfp.attachments.map((f) => <FileRow key={f.key} file={f} />)}
          </ul>
        )}
      </div>

      {/* ── Recipients ──────────────────────────────────────────────────── */}
      <div className="prc-field">
        <span className="prc-label" id="prc-rcp-label">
          Send to {recipients.length > 0 ? `(${recipients.length})` : ''}
        </span>

        {recipients.length === 0 ? (
          <p className="prc-quiet">
            Nobody yet. Paste a whole column of addresses or add them one at a time.
          </p>
        ) : (
          <ul className="prc-recipients" aria-labelledby="prc-rcp-label">
            {recipients.map((r) => {
              const badge = recipientBadge(r.status);
              return (
                <li key={r.id} className="prc-recipient">
                  <span className="prc-email">{r.email}</span>
                  <span className={`prc-badge ${badge.tone}`}>{badge.label}</span>
                  {/* Removable only while it is a draft: once a token is minted
                      the invitation exists in someone's inbox, and quietly
                      dropping the row here would not un-send it. */}
                  {locked ? null : (
                    <button
                      type="button"
                      className="prc-remove"
                      aria-label={`Remove ${r.email}`}
                      disabled={busy === 'recipients'}
                      onClick={() => onRemoveRecipient(r.id)}
                    >
                      Remove
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {locked ? null : (
          <>
            <textarea
              className="prc-input prc-emails"
              value={emailDraft}
              aria-label="Contractor email addresses"
              placeholder="ana@obra.pt, joao@construcoes.pt — or paste a column from a spreadsheet"
              disabled={!rfp || busy === 'recipients'}
              onChange={(e) => setEmailDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); addEmails(); }
              }}
            />
            <div className="prc-row">
              <button
                type="button"
                className="btn"
                disabled={!rfp || busy === 'recipients' || emailDraft.trim().length === 0}
                onClick={addEmails}
              >
                Add to list
              </button>
              {!rfp ? <span className="prc-quiet">Save the draft first.</span> : null}
            </div>
            {rejected ? (
              <p className="prc-reject" role="status">
                {rejected.invalid.length > 0
                  ? `Not an email address: ${rejected.invalid.join(', ')}. `
                  : ''}
                {rejected.duplicates.length > 0
                  ? `Already on the list: ${rejected.duplicates.join(', ')}.`
                  : ''}
              </p>
            ) : null}
          </>
        )}
      </div>

      {/* ── The two buttons ─────────────────────────────────────────────── */}
      {locked ? null : (
        <div className="prc-actions">
          <button
            type="button"
            className="btn"
            disabled={busy === 'save'}
            onClick={() => onSaveDraft({ description, specialties })}
          >
            {busy === 'save' ? 'Saving…' : 'Save draft'}
          </button>

          {confirmingSend ? (
            <div className="prc-confirm" role="group" aria-label="Confirm sending the RFP">
              <p className="prc-quiet">
                This emails {recipients.length}{' '}
                {recipients.length === 1 ? 'contractor' : 'contractors'} a link to bid. The brief is
                frozen once it goes, and the links stay live until you choose a constructor.
              </p>
              <button type="button" className="btn" onClick={() => setConfirmingSend(false)}>
                Not yet
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy === 'send'}
                onClick={onSend}
              >
                {busy === 'send' ? 'Sending…' : 'Send it'}
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="btn primary"
                disabled={blocked !== null}
                onClick={() => setConfirmingSend(true)}
              >
                Send to contractors
              </button>
              {/* A disabled button that will not say why is a dead end. */}
              {blocked ? <span className="prc-quiet">{blocked}</span> : null}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function FileRow({ file }: { file: FileRef }) {
  return (
    <li className="prc-file">
      <a className="prc-filename" href={file.url} target="_blank" rel="noreferrer">
        {file.filename}
      </a>
      <span className="prc-filemeta">{formatBytes(file.size)}</span>
    </li>
  );
}

/** "8 KB", "1.4 MB" — orientation beside a file name, not an accounting figure. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit += 1; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

// ── The inbox ────────────────────────────────────────────────────────────────

function ProposalsInbox({
  view, busy, onSelect,
}: {
  view: ProcurementView;
  busy: boolean;
  onSelect: (proposalId: string) => void;
}) {
  const rows = inboxRows(view);
  const decided = view.selectedProposalId !== null;
  const waiting = view.recipients.filter((r) => r.status === 'invited' || r.status === 'viewed');

  return (
    <section className="prc-inbox" aria-label="Proposals">
      <div className="prc-composer-hd">
        <h3 className="prc-h">Proposals</h3>
        <span className="prc-count">
          {rows.length} of {view.recipients.length} invited
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="prc-quiet">
          Nothing back yet. You will see each proposal here as it arrives — the list above shows who
          has opened the invitation.
        </p>
      ) : (
        <ul className="prc-proposals">
          {rows.map(({ proposal, email, selected }) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              email={email}
              selected={selected}
              /* Every bid stays selectable-looking only while nothing is chosen:
                 the choice is one-way (it activates execution and kills every
                 outstanding token), so a second Select would be a lie. */
              canSelect={!decided}
              busy={busy}
              onSelect={() => onSelect(proposal.id)}
            />
          ))}
        </ul>
      )}

      {waiting.length > 0 && !decided ? (
        <p className="prc-quiet">
          Still waiting on {waiting.length}{' '}
          {waiting.length === 1 ? 'contractor' : 'contractors'}. Choosing now closes the tender and
          their links stop working.
        </p>
      ) : null}

      {decided ? (
        <p className="prc-quiet">
          A constructor is selected and the build has moved to execution. Every proposal stays
          here — including the ones not chosen — as the record of what was asked and what came back.
        </p>
      ) : null}
    </section>
  );
}

function ProposalCard({
  proposal, email, selected, canSelect, busy, onSelect,
}: {
  proposal: ProcurementView['proposals'][number];
  email: string | null;
  selected: boolean;
  canSelect: boolean;
  busy: boolean;
  onSelect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  return (
    <li className={`prc-proposal${selected ? ' is-selected' : ''}`}>
      <div className="prc-proposal-hd">
        <button
          type="button"
          className="prc-disclose"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className="prc-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="prc-company">{proposal.companyName}</span>
        </button>
        <span className="prc-figure">{budgetRange(proposal.budgetMinCents, proposal.budgetMaxCents)}</span>
        <span className="prc-figure quiet">{timelineWords(proposal.timelineDays)}</span>
        {selected ? <span className="prc-badge good">Selected</span> : null}
      </div>

      {open ? (
        <div className="prc-proposal-body">
          {email ? <p className="prc-quiet">Submitted by {email}</p> : null}
          <p className="prc-quiet">
            Received{' '}
            <time dateTime={proposal.submittedAt} title={proposal.submittedAt}>
              {new Date(proposal.submittedAt).toLocaleDateString('en-GB', {
                day: 'numeric', month: 'short', year: 'numeric',
              })}
            </time>
          </p>

          {proposal.websiteUrl ? (
            <p className="prc-web">
              <a href={proposal.websiteUrl} target="_blank" rel="noreferrer noopener">
                {proposal.websiteUrl}
              </a>
            </p>
          ) : null}

          {proposal.comment ? <p className="prc-comment">{proposal.comment}</p> : null}

          {proposal.portfolioImages.length > 0 ? (
            <ul className="prc-portfolio">
              {proposal.portfolioImages.map((img) => (
                <li key={img.key}>
                  {/* Plain <img>: these are R2 URLs from an unauthenticated
                      submission, not project assets, so they are not run through
                      the image optimiser's allow-list. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.url} alt={`${proposal.companyName} — ${img.filename}`} loading="lazy" />
                </li>
              ))}
            </ul>
          ) : null}

          {canSelect ? (
            confirming ? (
              <div className="prc-confirm" role="group" aria-label="Confirm selecting this constructor">
                <p className="prc-quiet">
                  Choosing {proposal.companyName} closes the tender: execution starts, and every
                  other invitation link stops working. It is recorded on the shared record.
                </p>
                <button type="button" className="btn" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
                <button type="button" className="btn primary" disabled={busy} onClick={onSelect}>
                  {busy ? 'Selecting…' : `Select ${proposal.companyName}`}
                </button>
              </div>
            ) : (
              <button type="button" className="btn primary" onClick={() => setConfirming(true)}>
                Select this constructor
              </button>
            )
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
