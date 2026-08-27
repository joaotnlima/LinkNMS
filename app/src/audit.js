// Audit projection (design §7 audit view, FR2/FR7 + Acceptance).
//
// The spike stores domain rows directly; the *trust anchor* is the approved
// ledger core (services/ledger/hash-chain.mjs, ADR-0002 — Slice 1). This module
// is the read-side bridge: it replays a project's domain history as an ordered
// list of ledger events, runs it through the SAME canonical-JSON hash chain the
// architect shipped, and returns the events plus a real chain-verify result.
//
// So "integrity: verified" in the UI is not a decorative badge — it is the
// output of verifyChain() recomputing every payload_hash / prev_hash /
// entry_hash from event content. When Slices 2–4 land on Postgres, the API
// contract (GET /projects/:id/audit → events[] in seq order + { verified }) is
// already the shape this returns, so the frontend does not change.
import { computeAppend, verifyChain, headHash } from '../../services/ledger/hash-chain.mjs';

// Human-readable one-liner per event type, for the audit rows. The payload
// carries the machine-truth; this is the plain-language gloss beside it.
const NARRATIVE = {
  decision_recorded: (p) => `Decision recorded: “${p.title}”`,
  decision_revised: (p) => `Decision amended to “${p.title}” (rev ${p.rev}) — prior revision preserved`,
  change_order_raised: (p) => `Change order raised: “${p.title}” (${signed(p.costDeltaCents)})`,
  change_order_approved: (p) => `Change order approved: “${p.title}” — budget now ${money(p.budgetAfter)}`,
  change_order_rejected: (p) => `Change order rejected: “${p.title}” — no budget effect`,
};

// Collect every domain mutation as a raw {type, actorPartyId, occurredAt, payload}
// event, in chronological order. This is the canonical event stream the chain is
// built over. Order is by server timestamp; ties break by a stable kind rank so
// the sequence is deterministic across requests (verify depends on a stable order).
function collectEvents(repo, projectId) {
  const raw = [];

  for (const d of repo.listDecisions(projectId)) {
    raw.push({
      type: 'decision_recorded',
      actorPartyId: d.createdBy,
      occurredAt: d.createdAt,
      payload: { decisionId: d.id, title: d.original.title, body: d.original.body || '' },
    });
    // revisions[] are the amendments (rev 2..n); rev 1 is the original above.
    for (const r of d.revisions) {
      raw.push({
        type: 'decision_revised',
        actorPartyId: r.revisedBy,
        occurredAt: r.revisedAt,
        payload: { decisionId: d.id, rev: r.rev, title: r.title, body: r.body || '' },
      });
    }
  }

  const cos = repo.listChangeOrders(projectId);
  const budgetByCo = new Map(repo.budgetEvents(projectId).map((e) => [e.change_order_id, e]));
  // Running budget so an approval event can carry budgetAfter (FR6 "how much").
  const baseline = repo.getProject(projectId).baseline_budget_cents;

  for (const c of cos) {
    raw.push({
      type: 'change_order_raised',
      actorPartyId: c.proposedBy,
      occurredAt: c.createdAt,
      payload: {
        changeOrderId: c.id,
        title: c.title,
        costDeltaCents: c.costDeltaCents,
        scopeImpactNote: c.scopeImpactNote ?? null,
        scheduleImpactDays: c.scheduleImpactDays ?? null,
        qualityFlag: !!c.qualityFlag,
      },
    });
    if (c.status === 'approved' || c.status === 'rejected') {
      raw.push({
        type: c.status === 'approved' ? 'change_order_approved' : 'change_order_rejected',
        actorPartyId: c.decidedBy,
        occurredAt: c.decidedAt,
        payload: {
          changeOrderId: c.id,
          title: c.title,
          costDeltaCents: c.costDeltaCents,
          // budgetAfter is filled in the ordering pass below (needs running total).
        },
      });
    }
  }

  const KIND_RANK = {
    decision_recorded: 0,
    change_order_raised: 1,
    decision_revised: 2,
    change_order_rejected: 3,
    change_order_approved: 4,
  };
  raw.sort((a, b) =>
    a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : KIND_RANK[a.type] - KIND_RANK[b.type],
  );

  // Second pass: stamp budgetAfter on approvals in chronological order.
  let running = baseline;
  for (const e of raw) {
    if (e.type === 'change_order_approved' && budgetByCo.has(e.payload.changeOrderId)) {
      running += budgetByCo.get(e.payload.changeOrderId).delta_cents;
      e.payload.budgetAfter = running;
    }
  }
  return raw;
}

// Build the verifiable ledger for a project.
//   demoTamper: when set to a 1-based seq, the returned event at that seq has its
//   payload altered AFTER hashing — leaving its stored payload_hash intact — so
//   verifyChain reports the break at exactly that seq. This makes tamper-evidence
//   tangible in the demo without corrupting stored data (design §9). It is a
//   read-only illusion on the response, never a write.
export function projectAudit(repo, projectId, { demoTamper = null } = {}) {
  repo.getProject(projectId); // 404s for unknown project, like the other reads.
  const rawEvents = collectEvents(repo, projectId);

  // Fold each raw event through the real chain, carrying prev → next.
  const chain = [];
  let prev = null;
  for (const raw of rawEvents) {
    const e = computeAppend(prev, raw);
    chain.push(e);
    prev = e;
  }

  // Present the events with their narrative gloss.
  const events = chain.map((e) => ({
    seq: e.seq,
    type: e.type,
    actorPartyId: e.actorPartyId,
    occurredAt: e.occurredAt,
    payload: e.payload,
    narrative: (NARRATIVE[e.type] || ((p) => e.type))(e.payload),
    payloadHash: e.payloadHash,
    prevHash: e.prevHash,
    entryHash: e.entryHash,
  }));

  const head = headHash(chain);

  if (demoTamper != null) {
    const idx = events.findIndex((e) => e.seq === demoTamper);
    if (idx !== -1) {
      // Corrupt the presented payload only; its payloadHash still reflects the
      // original content, so verify recomputes a mismatch at this seq.
      const tampered = events.map((e, i) =>
        i === idx
          ? { ...e, payload: { ...e.payload, title: '⚠ altered after the fact', _tampered: true } }
          : e,
      );
      return { events: tampered, verify: verifyChain(tampered), headHash: head, demoTampered: demoTamper };
    }
  }

  return { events, verify: verifyChain(chain), headHash: head };
}

function money(cents) {
  if (cents == null) return '—';
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}
function signed(cents) {
  return (cents >= 0 ? '+' : '−') + money(Math.abs(cents)).replace('-', '');
}
