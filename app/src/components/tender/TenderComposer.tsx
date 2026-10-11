'use client';

// The three-step composer (PRD-02 T-2..T-9): 1 · Scope, 2 · Bidders,
// 3 · Review & send. ONE implementation, mounted by both containers — the
// docked task panel (`variant="panel"`) and the full tender workspace
// (`variant="workspace"`, which adds the title and brief).
//
// Each step saves through the existing tendering endpoints as it completes:
// Scope creates the draft (createRfp) or patches it (updateRfp, If-Match on
// the version); Bidders queues each address (addRecipients — nothing is sent
// on a draft) and removes one (removeRecipient); Review sends (publishRfp,
// which mints the personal links). "Discard draft" cancels the draft.
// PRD-04: step 2 also suggests directory companies for the task (added with
// source "Directory") and holds "Also list it as an open request" (rfp.listed,
// saved on the draft at once).

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  addRecipientsAction, cancelRfpAction, createRfpAction, loadComposerAction, publishRfpAction,
  removeRecipientAction, updateRfpAction,
} from '../procurement-actions';
import {
  biddersCaption, composeSteps, continueBlocked, deadlineFromInputs, inputsFromDeadline,
  scopeSummary, type ComposeStep,
} from '@/lib/v2/tender-flow-view';
import { createBlockedReason, type RfpMode, type V2Recipient, type V2Rfp } from '@/lib/v2/tendering-view';
import { biddersSummary } from '@/lib/v2/rfp-directory-view';
import { setListedAction } from '../rfp-directory-actions';
import { BiddersStep } from './BiddersStep';
import { ListedToggle } from './DirectoryBits';
import { SuggestedCompanies } from './SuggestedCompanies';
import { ReviewStep } from './ReviewStep';
import { ScopeStep, type ScopeValue } from './ScopeStep';
import { StepCard } from './TenderBits';
import { useTenderWindow } from './hooks';
import type { TaskOption } from './types';

export function TenderComposer({
  projectId, taskId, taskName, tasks, rfp, initialMode = 'detailed', variant,
  specialtyCode = null, specialtyName = null, onChanged, onSent, onDiscarded,
}: {
  projectId: string;
  /** The task the tender starts from (the first root). */
  taskId: string;
  taskName: string;
  tasks: TaskOption[];
  /** The existing draft, or null for a fresh composer. */
  rfp: V2Rfp | null;
  initialMode?: RfpMode;
  variant: 'panel' | 'workspace';
  /** PRD-04 X-1: the task's directory specialty (suggestions, the open-request toggle's words). */
  specialtyCode?: string | null;
  specialtyName?: string | null;
  onChanged: (rfp: V2Rfp, counts: { invited: number }) => void;
  onSent: (rfp: V2Rfp, counts: { invited: number }) => void;
  /** Called after the draft is cancelled (or with null when nothing was saved yet). */
  onDiscarded: (rfp: V2Rfp | null) => void;
}) {
  const [draft, setDraft] = useState<V2Rfp | null>(rfp);
  const [recipients, setRecipients] = useState<V2Recipient[]>([]);
  const [step, setStep] = useState<ComposeStep>(rfp ? 2 : 1);
  const [busy, setBusy] = useState<null | 'scope' | 'bidders' | 'send' | 'discard' | 'listing'>(null);
  const [listed, setListed] = useState<boolean>(rfp?.listed ?? rfp?.visibility === 'open');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const due = inputsFromDeadline(rfp?.submission_deadline);
  const [scope, setScope] = useState<ScopeValue>({
    mode: rfp?.mode ?? initialMode,
    title: rfp?.title ?? '',
    scopeText: rfp?.scope_text ?? '',
    rootTaskIds: rfp?.root_task_ids.length ? [...rfp.root_task_ids] : [taskId],
    includeIds: [],
    deadlineDay: due.day,
    deadlineTime: due.time,
    questionsDay: inputsFromDeadline(rfp?.questions_deadline).day,
  });
  const questions = scope.questionsDay ? deadlineFromInputs(scope.questionsDay, scope.deadlineTime) : '';
  const deadline = deadlineFromInputs(scope.deadlineDay, scope.deadlineTime);
  const { window, loading: windowLoading } = useTenderWindow(
    projectId, scope.rootTaskIds, scope.includeIds, deadline ? deadline.slice(0, 10) : null,
  );

  // An existing draft: its bidders, and which assigned rows it chose to include
  // (planning lists every assigned row; the draft's exclusions are the rest).
  useEffect(() => {
    if (!rfp) return;
    void loadComposerAction(rfp.id).then((d) => { if (d) setRecipients(d.recipients); });
  }, [rfp]);
  const [seededIncludes, setSeededIncludes] = useState(!rfp);
  useEffect(() => {
    if (seededIncludes || !window || !rfp) return;
    const excluded = new Set(rfp.excluded_task_ids ?? []);
    setScope((s) => ({ ...s, includeIds: window.left_out.map((r) => r.task_id).filter((id) => !excluded.has(id)) }));
    setSeededIncludes(true);
  }, [seededIncludes, window, rfp]);

  const facts = { hasDraft: draft !== null, bidders: recipients.length, listed };
  const states = composeSteps(step, facts);
  const name = scope.title.trim() || taskName;
  const scopeBlocked = createBlockedReason({ title: name, rootTaskIds: scope.rootTaskIds, submissionDeadline: deadline })
    ?? (windowLoading ? 'Reading the plan…' : null);
  const summary = useMemo(() => scopeSummary({
    mode: scope.mode, taskName: name, deadline,
  }), [scope.mode, name, deadline]);

  const report = useCallback((next: V2Rfp, invited = recipients.length) => {
    setDraft(next);
    onChanged(next, { invited });
  }, [onChanged, recipients.length]);

  const saveScope = async () => {
    setBusy('scope'); setError(null); setFieldErrors({});
    const excluded = (window?.left_out ?? []).map((r) => r.task_id);
    const res = draft
      ? await updateRfpAction(draft.id, {
        title: name, scopeText: scope.scopeText, submissionDeadline: deadline,
        questionsDeadline: questions || null,
        rootTaskIds: scope.rootTaskIds, excludedTaskIds: excluded,
      }, draft.version)
      : await createRfpAction(projectId, {
        title: name, scopeText: scope.scopeText, rootTaskIds: scope.rootTaskIds,
        submissionDeadline: deadline, listed, excludedTaskIds: excluded,
        ...(questions ? { questionsDeadline: questions } : {}),
        ...(scope.mode === 'light' ? { purpose: 'design' as const, mode: 'light' as const } : {}),
      });
    setBusy(null);
    if (!res.ok) { setError(res.message); setFieldErrors(res.fieldErrors ?? {}); return; }
    report(res.data);
    setStep(2);
  };

  const addBidders = async (emails: string[]) => {
    if (!draft) return false;
    setBusy('bidders'); setError(null);
    const res = await addRecipientsAction(draft.id, emails);
    setBusy(null);
    if (!res.ok) { setError(res.message); return false; }
    const next = [...recipients, ...res.data];
    setRecipients(next);
    onChanged(draft, { invited: next.length });
    return true;
  };

  const addedFromDirectory = (added: V2Recipient[]) => {
    if (!draft) return;
    const known = new Set(recipients.map((r) => r.id));
    const next = [...recipients, ...added.filter((r) => !known.has(r.id))];
    setRecipients(next);
    onChanged(draft, { invited: next.length });
  };

  const toggleListed = async (next: boolean) => {
    if (!draft) return;
    setBusy('listing'); setError(null);
    const res = await setListedAction(draft.id, next, draft.version);
    setBusy(null);
    if (!res.ok) { setError(res.message); return; }
    setListed(Boolean(res.data.listed));
    report(res.data);
  };

  const removeBidder = async (recipientId: string) => {
    if (!draft) return;
    setBusy('bidders'); setError(null);
    const res = await removeRecipientAction(draft.id, recipientId);
    setBusy(null);
    if (!res.ok) { setError(res.message); return; }
    const next = recipients.filter((r) => r.id !== recipientId);
    setRecipients(next);
    onChanged(draft, { invited: next.length });
  };

  const send = async () => {
    if (!draft) return;
    setBusy('send'); setError(null);
    const res = await publishRfpAction(draft.id);
    setBusy(null);
    if (!res.ok) { setError(res.message); return; }
    onSent(res.data, { invited: recipients.length });
  };

  const discard = async () => {
    if (!draft) { onDiscarded(null); return; }
    setBusy('discard'); setError(null);
    const res = await cancelRfpAction(draft.id, 'Draft discarded before it was sent');
    setBusy(null);
    if (!res.ok) { setError(res.message); return; }
    onDiscarded(res.data);
  };

  return (
    <div className="tnd" aria-label="Request proposals">
      <p className="tnd-private">Private until you send it. No contractor can see this — the personal links do not exist yet.</p>
      {error ? <p className="tnd-err" role="alert">{error}</p> : null}

      <StepCard n={1} title="Scope" state={states[1]} summary={summary} onEdit={() => setStep(1)}>
        <ScopeStep
          value={scope} onChange={(next) => setScope((s) => ({ ...s, ...next }))}
          taskName={name} window={window} windowLoading={windowLoading} tasks={tasks}
          modeLocked={draft !== null} variant={variant} busy={busy === 'scope'}
          blocked={scopeBlocked} fieldErrors={fieldErrors} onSave={() => void saveScope()}
          saveLabel={draft ? 'Save scope' : 'Save and add bidders'}
        />
      </StepCard>

      <StepCard n={2} title="Bidders" state={states[2]} caption={biddersCaption(recipients)}
        summary={recipients.length
          ? `${biddersSummary(recipients)}${listed ? ' · also an open request' : ''}`
          : 'Listed as an open request — no one invited yet.'}
        lockedHint="Save the scope first." onEdit={() => setStep(2)}>
        <BiddersStep
          recipients={recipients} busy={busy === 'bidders'}
          onAdd={addBidders} onRemove={(id) => void removeBidder(id)}
          onContinue={() => setStep(3)} continueBlocked={continueBlocked(2, facts)}
          suggestions={draft ? (
            <SuggestedCompanies
              projectId={projectId} taskId={taskId} rfpId={draft.id}
              specialtyCode={specialtyCode} specialtyName={specialtyName}
              recipients={recipients} onAdded={addedFromDirectory}
            />
          ) : null}
          listing={draft ? (
            <ListedToggle listed={listed} busy={busy === 'listing'} specialtyName={specialtyName}
              onChange={(next) => void toggleListed(next)} />
          ) : null}
        />
      </StepCard>

      <StepCard n={3} title="Review & send" state={states[3]}
        lockedHint="Sending mints a personal link for each contractor and opens bidding.">
        <ReviewStep
          scopeLine={summary} recipients={recipients} listed={listed} taskName={name}
          window={window} sending={busy === 'send'} blocked={continueBlocked(2, facts)}
          onSend={() => void send()} onBack={() => setStep(2)}
        />
      </StepCard>

      <div className="tnd-row">
        <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void discard()}>
          {busy === 'discard' ? 'Discarding…' : 'Discard draft'}
        </button>
      </div>
    </div>
  );
}
