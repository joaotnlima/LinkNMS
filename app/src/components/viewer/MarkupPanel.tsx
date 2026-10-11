'use client';

// The right panel's markup list (PRD-06 V-8): every markup of the open sheet —
// number, text, kind · author · date · state, what it became (a question to a
// party, an issue on the task) — and, for a selected saved markup, the actions:
// close / re-open, turn into a question for a named party, raise as an issue.
// Unsaved drafts can be removed before saving. The server decides who may do
// what; a refusal comes back as a sentence.
import { useState } from 'react';

import { MARKUP_KIND_LABEL, measureLabel, type MarkupView } from '@/lib/v2/viewer-view';

type Shown = MarkupView & { n: number; fromVersion: number | null };

export interface Party { orgId: string; name: string }

export function MarkupPanel({
  title, markups, mmPerUnit, selectedId, parties, orgName, issueOn, busy,
  onSelect, onRemoveDraft, onState, onAsk, onIssue,
}: {
  title: string;
  markups: Shown[];
  mmPerUnit: number | null;
  selectedId: string | null;
  parties: Party[];
  orgName: (id: string | null) => string | null;
  /** Where an issue is raised: 'the task' the viewer was opened from, or 'the build'. */
  issueOn: string;
  busy: boolean;
  onSelect: (id: string | null) => void;
  onRemoveDraft: (id: string) => void;
  onState: (m: MarkupView, action: 'close' | 'reopen') => void;
  onAsk: (m: MarkupView, addresseeOrgId: string, text: string) => void;
  onIssue: (m: MarkupView, text: string, severity: 'minor' | 'major' | 'critical') => void;
}) {
  const selected = markups.find((m) => m.id === selectedId) ?? null;
  const [to, setTo] = useState('');
  const [severity, setSeverity] = useState<'minor' | 'major' | 'critical'>('minor');
  const textOf = (m: MarkupView) => m.text ?? (m.kind === 'measure' ? `Measured ${measureLabel(m.points, mmPerUnit)}` : MARKUP_KIND_LABEL[m.kind]);

  return (
    <section className="vw-panel" aria-label="Markups">
      <div className="vw-panel-hd">
        <span className="vw-grp">{title}</span>
        <span className="vw-note">A layer on the record — the file itself is never changed.</span>
      </div>
      {markups.length === 0 ? <p className="vw-note">No markups on this sheet yet. Switch to Markup to add one.</p> : null}
      <ol className="vw-mks">
        {markups.map((m) => (
          <li key={m.id} className={`vw-mk${m.id === selectedId ? ' is-on' : ''}${m.draft ? ' is-draft' : ''}`}>
            <button type="button" className="vw-mk-btn" onClick={() => onSelect(m.id === selectedId ? null : m.id)} aria-pressed={m.id === selectedId}>
              <b className={`vw-n${m.state === 'closed' ? ' is-closed' : ''}`}>{m.state === 'closed' ? '✓' : m.n}</b>
              <span>
                <b>{textOf(m)}</b><br />
                <span className="vw-note">
                  {[MARKUP_KIND_LABEL[m.kind], m.draft ? 'you · unsaved' : orgName(m.authorOrgId),
                    m.createdAt ? shortDate(m.createdAt) : null, m.draft ? null : m.state,
                    m.fromVersion ? `drawn on v${m.fromVersion}` : null].filter(Boolean).join(' · ')}
                </span>
                {m.questionId || m.nonconformityId ? (
                  <><br /><span className="vw-note">
                    {[m.questionId ? 'question asked' : null, m.nonconformityId ? 'issue on the task' : null].filter(Boolean).join(' · ')}
                  </span></>
                ) : null}
              </span>
            </button>
            {m.draft ? <button type="button" className="vw-linkbtn" onClick={() => onRemoveDraft(m.id)}>Remove</button> : null}
          </li>
        ))}
      </ol>

      {selected && !selected.draft ? (
        <div className="vw-actions">
          <button type="button" className="btn sm" disabled={busy}
            onClick={() => onState(selected, selected.state === 'open' ? 'close' : 'reopen')}>
            {selected.state === 'open' ? 'Close markup' : 'Re-open markup'}
          </button>
          {!selected.questionId ? (
            <div className="vw-field">
              <label htmlFor="vw-ask">Turn markup {selected.n} into a question for…</label>
              <div className="vw-row">
                <select id="vw-ask" className="vw-input" value={to} onChange={(e) => setTo(e.target.value)}>
                  <option value="">Choose a party</option>
                  {parties.map((p) => <option key={p.orgId} value={p.orgId}>{p.name}</option>)}
                </select>
                <button type="button" className="btn sm" disabled={!to || busy}
                  onClick={() => onAsk(selected, to, textOf(selected))}>Ask</button>
              </div>
            </div>
          ) : null}
          {!selected.nonconformityId ? (
            <div className="vw-field">
              <label htmlFor="vw-issue">Raise markup {selected.n} as an issue on {issueOn}</label>
              <div className="vw-row">
                <select id="vw-issue" className="vw-input" value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)}>
                  <option value="minor">Minor</option><option value="major">Major</option><option value="critical">Critical</option>
                </select>
                <button type="button" className="btn sm" disabled={busy} onClick={() => onIssue(selected, textOf(selected), severity)}>Raise issue</button>
              </div>
            </div>
          ) : null}
          <p className="vw-note">An issue can point at a PDF page, a DWG layout and a model element at once.</p>
        </div>
      ) : selected?.draft ? <p className="vw-note">Save the markups first to turn this one into a question or an issue.</p> : null}
    </section>
  );
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
