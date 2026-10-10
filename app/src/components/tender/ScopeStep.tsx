'use client';

// Composer step 1 · Scope (PRD-02 T-2..T-5). Pure presentation over the
// composer's state: the mode (D-39), what the package covers and what it LEAVES
// OUT (with why, and "Include it"), extra rows from the plan, the bids-due date
// and time, invite only / open (D-15), the plan's work window and the
// critical-path alert. Every plan fact shown here is planning's
// (getTenderWindow) — this component never computes a date.

import { useState } from 'react';

import type { RfpMode, RfpVisibility } from '@/lib/v2/tendering-view';
import {
  coversLabel, leftOutLine, workWindowLine, type V2TenderWindow,
} from '@/lib/v2/tender-flow-view';
import { CriticalAlert } from './TenderBits';
import type { TaskOption } from './types';

export interface ScopeValue {
  mode: RfpMode;
  title: string;
  scopeText: string;
  rootTaskIds: string[];
  includeIds: string[];
  deadlineDay: string;
  deadlineTime: string;
  /** Optional: when bidders stop asking questions (workspace only). */
  questionsDay: string;
  visibility: RfpVisibility;
}

export function ScopeStep({
  value, onChange, taskName, window, windowLoading, tasks, modeLocked, variant,
  busy, blocked, fieldErrors, onSave, saveLabel,
}: {
  value: ScopeValue;
  onChange: (next: Partial<ScopeValue>) => void;
  taskName: string;
  window: V2TenderWindow | null;
  windowLoading: boolean;
  /** Rows of the plan that could be added to the package. */
  tasks: TaskOption[];
  /** The mode is fixed once the draft exists (it shapes the bid form). */
  modeLocked: boolean;
  variant: 'panel' | 'workspace';
  busy: boolean;
  blocked: string | null;
  fieldErrors: Record<string, string>;
  onSave: () => void;
  saveLabel: string;
}) {
  const [adding, setAdding] = useState(false);
  const covered = window?.covered_task_ids.length ?? value.rootTaskIds.length;
  const candidates = tasks.filter((t) => !value.rootTaskIds.includes(t.id)
    && !(window?.covered_task_ids ?? []).includes(t.id));

  return (
    <>
      <div className="tnd-field">
        <span className="tnd-label" id="tnd-mode">What are you tendering?</span>
        <div className="tnd-seg" role="radiogroup" aria-labelledby="tnd-mode">
          {(['detailed', 'light'] as RfpMode[]).map((m) => (
            <button
              key={m} type="button" role="radio" aria-checked={value.mode === m}
              disabled={modeLocked && value.mode !== m}
              onClick={() => onChange({ mode: m })}
            >
              {m === 'detailed' ? 'Detailed (build) — priced line by line' : 'Light (design) — a fee, portfolio and references'}
            </button>
          ))}
        </div>
        {modeLocked ? <span className="tnd-note">The bid form is set when the draft is saved; start a new tender to change it.</span> : null}
      </div>

      {variant === 'workspace' ? (
        <>
          <div className="tnd-field">
            <label className="tnd-label" htmlFor="tnd-title">Title</label>
            <input id="tnd-title" className="tnd-input" value={value.title} maxLength={200}
              placeholder={taskName} onChange={(e) => onChange({ title: e.target.value })} />
            {fieldErrors.title ? <span className="tnd-err">{fieldErrors.title}</span> : null}
          </div>
          <div className="tnd-field">
            <label className="tnd-label" htmlFor="tnd-brief">{value.mode === 'light' ? 'Brief & deliverables' : 'Scope'}</label>
            <textarea id="tnd-brief" className="tnd-input" value={value.scopeText} maxLength={8000}
              placeholder="What a contractor must know to price it honestly."
              onChange={(e) => onChange({ scopeText: e.target.value })} />
          </div>
        </>
      ) : null}

      {/* Covered tasks (T-2) and the rows left out, with why (T-3). */}
      <div className="tnd-field">
        <span className="tnd-label">Covers</span>
        <div className="tnd-row">
          <span className="tnd-badge live">{coversLabel(taskName, covered, value.rootTaskIds.length)}</span>
          {candidates.length > 0 ? (
            <button type="button" className="btn sm" style={{ borderStyle: 'dashed' }}
              aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
              ＋ Add tasks from the plan
            </button>
          ) : null}
        </div>
        {adding ? (
          <div className="tnd-picker" role="group" aria-label="Add tasks from the plan">
            {candidates.map((t) => (
              <label key={t.id}>
                <input type="checkbox" onChange={(e) => {
                  if (e.target.checked) onChange({ rootTaskIds: [...value.rootTaskIds, t.id] });
                }} />
                {t.name}
              </label>
            ))}
          </div>
        ) : null}
        {value.rootTaskIds.length > 1 ? (
          <span className="tnd-note">
            Also: {value.rootTaskIds.slice(1).map((id) => tasks.find((t) => t.id === id)?.name ?? 'a task').join(', ')}{' '}
            <button type="button" className="tnd-link" onClick={() => onChange({ rootTaskIds: value.rootTaskIds.slice(0, 1) })}>
              Remove the extra tasks
            </button>
          </span>
        ) : null}
        {(window?.left_out ?? []).map((row) => (
          <span key={row.task_id} className="tnd-st-sum">
            Left out: {leftOutLine(row)}{' '}
            <button type="button" className="tnd-link" onClick={() => onChange({ includeIds: [...value.includeIds, row.task_id] })}>
              Include it
            </button>
          </span>
        ))}
        {value.includeIds.length > 0 ? (
          <span className="tnd-note">
            {value.includeIds.length} {value.includeIds.length === 1 ? 'row' : 'rows'} included although already assigned.{' '}
            <button type="button" className="tnd-link" onClick={() => onChange({ includeIds: [] })}>Leave them out again</button>
          </span>
        ) : null}
        {fieldErrors.root_task_ids ? <span className="tnd-err">{fieldErrors.root_task_ids}</span> : null}
        {fieldErrors.excluded_task_ids ? <span className="tnd-err">{fieldErrors.excluded_task_ids}</span> : null}
      </div>

      <div className="tnd-row" style={{ alignItems: 'flex-end' }}>
        <div className="tnd-field">
          <label className="tnd-label" htmlFor="tnd-due-day">Bids due</label>
          <input id="tnd-due-day" className="tnd-input" type="date" value={value.deadlineDay}
            onChange={(e) => onChange({ deadlineDay: e.target.value })} />
        </div>
        <div className="tnd-field">
          <label className="tnd-label" htmlFor="tnd-due-time">at</label>
          <input id="tnd-due-time" className="tnd-input" type="time" value={value.deadlineTime}
            onChange={(e) => onChange({ deadlineTime: e.target.value })} />
        </div>
        <div className="tnd-field">
          <span className="tnd-label" id="tnd-vis">Who can bid</span>
          <div className="tnd-seg" role="radiogroup" aria-labelledby="tnd-vis">
            <button type="button" role="radio" aria-checked={value.visibility === 'invite_only'}
              onClick={() => onChange({ visibility: 'invite_only' })}>Invite only</button>
            <button type="button" role="radio" aria-checked={value.visibility === 'open'}
              onClick={() => onChange({ visibility: 'open' })}>Open</button>
          </div>
        </div>
      </div>
      {fieldErrors.submission_deadline ? <span className="tnd-err">{fieldErrors.submission_deadline}</span> : null}
      {variant === 'workspace' ? (
        <div className="tnd-field">
          <label className="tnd-label" htmlFor="tnd-q-day">Questions close (optional)</label>
          <input id="tnd-q-day" className="tnd-input" type="date" value={value.questionsDay}
            onChange={(e) => onChange({ questionsDay: e.target.value })} />
          {fieldErrors.questions_deadline ? <span className="tnd-err">{fieldErrors.questions_deadline}</span> : null}
        </div>
      ) : null}

      {/* What this does to the plan (T-4, T-5). */}
      <span className="tnd-st-sum">{windowLoading ? 'Reading the plan…' : workWindowLine(window)}</span>
      <CriticalAlert window={window} taskName={taskName} phase="compose" />

      <div className="tnd-row">
        <button type="button" className="btn primary sm" disabled={busy || blocked !== null} onClick={onSave}>
          {busy ? 'Saving…' : saveLabel}
        </button>
        {blocked ? <span className="tnd-note">{blocked}</span> : null}
      </div>
    </>
  );
}
