'use client';

// The workspace's extra sections (PRD-02, D-42 — the modal is the full tender
// workspace): every file of the tender in one place, the emailed bids still to
// record, and the clarifications (PRD-08).

import { useEffect, useMemo, useState } from 'react';

import { loadCompareAction } from '../procurement-actions';
import type { CompareEntry } from '@/lib/v2/tendering';
import {
  proposalDocumentDownloadPath, proposalStatusBadge, type V2ProposalLane, type V2Rfp,
} from '@/lib/v2/tendering-view';
import { isLanded } from '@/lib/v2/tender-flow-view';
import OwnerModelViewer from '../ifc/OwnerModelViewer';
import RfpModelComposer from '../ifc/RfpModelComposer';
import { IssuerClarifications } from './IssuerClarifications';
import { RecordOfflineForm } from './RecordOfflineForm';

/** The RFP's model and every landed bid's documents. */
export function FilesSection({ rfp, lanes }: { rfp: V2Rfp; lanes: V2ProposalLane[] }) {
  const landed = useMemo(() => lanes.filter((l) => isLanded(l) && l.document_count > 0), [lanes]);
  const ids = useMemo(() => landed.map((l) => l.proposal_id), [landed]);
  const [entries, setEntries] = useState<CompareEntry[] | null>(null);
  useEffect(() => {
    let live = true;
    if (ids.length === 0) { setEntries([]); return undefined; }
    void loadCompareAction(ids).then((list) => { if (live) setEntries(list); });
    return () => { live = false; };
  }, [ids]);
  const model = rfp.package?.models?.[0] ?? null;

  return (
    <div className="tnd">
      <section className="tnd" style={{ gap: 8 }} aria-label="The package">
        <b className="tnd-h">The package</b>
        {rfp.status === 'draft' ? (
          <RfpModelComposer rfpId={rfp.id} projectId={rfp.project_id} model={model} />
        ) : model ? (
          <OwnerModelViewer rfpId={rfp.id} documentId={model.document_id} fileName={model.file_name} sizeBytes={model.size_bytes} />
        ) : (
          <p className="tnd-note">No 3D model was attached to this tender.</p>
        )}
      </section>
      <section className="tnd" style={{ gap: 8 }} aria-label="Files from bidders">
        <b className="tnd-h">From the bidders</b>
        {landed.length === 0 ? <p className="tnd-note">No bid has files yet.</p> : landed.map((l) => {
          const docs = entries?.find((e) => e.detail.proposal_id === l.proposal_id)?.documents ?? [];
          return (
            <div key={l.proposal_id} className="tnd-card">
              <div className="tnd-inv"><b className="e">{l.bidder.name ?? l.bidder.email}</b><span className="tnd-note">{l.document_count} files</span></div>
              {entries === null ? <div className="tnd-inv"><span className="tnd-note">Loading…</span></div> : docs.map((d) => (
                <div key={d.id} className="tnd-inv">
                  <a className="e" href={proposalDocumentDownloadPath(l.proposal_id, d.id)} target="_blank" rel="noreferrer">{d.title}</a>
                </div>
              ))}
            </div>
          );
        })}
      </section>
    </div>
  );
}

/** Invited lanes with no bid yet: record an answer that came by email (attachment required). */
export function EmailedBidsSection({ rfp, lanes, onRecorded }: {
  rfp: V2Rfp; lanes: V2ProposalLane[]; onRecorded: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const awaiting = lanes.filter((l) => l.status === 'invited' || l.status === 'draft');
  const receiving = rfp.status === 'published' || rfp.status === 'closed';
  if (!receiving) return <p className="tnd-note">Emailed bids are recorded while the tender is out or being compared.</p>;
  return (
    <div className="tnd">
      <p className="tnd-note is-strong">Got a bid by email or over the phone? Record it so it sits in the comparison beside the online ones. The bid documents are required.</p>
      {error ? <p className="tnd-err" role="alert">{error}</p> : null}
      {awaiting.length === 0 ? <p className="tnd-note">Every invited bidder has answered.</p> : awaiting.map((l) => {
        const badge = proposalStatusBadge(l.status);
        return (
          <div key={l.proposal_id} className="tnd-card">
            <div className="tnd-inv">
              <span className="e">{l.bidder.name ?? l.bidder.email}</span>
              <span className="tnd-badge">{badge.label}</span>
              <button type="button" className="btn sm" onClick={() => setOpen(open === l.proposal_id ? null : l.proposal_id)}>
                {open === l.proposal_id ? 'Close' : 'Record an emailed bid'}
              </button>
            </div>
            {open === l.proposal_id ? (
              <div style={{ padding: '8px 0' }}>
                <RecordOfflineForm proposalId={l.proposal_id} onError={setError}
                  onCancel={() => setOpen(null)} onRecorded={() => { setOpen(null); onRecorded(); }} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Clarifications (PRD-08 H-7): the issuer reads every question and answers for all bidders. */
export function ClarificationsSection({ rfp, onOpenCount }: { rfp: V2Rfp; onOpenCount?: (n: number) => void }) {
  return <IssuerClarifications rfpId={rfp.id} canAnswer onOpenCount={onOpenCount} />;
}
