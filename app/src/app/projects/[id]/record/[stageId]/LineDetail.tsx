'use client';

// D15 — the interactive half of the line detail (LINA-218).
// Contract: docs/architecture/slice-b3-live-record-materials-contract.md §3b/§5.
//
// ── THE SWAP IS A CHOICE, NOT A FORM ─────────────────────────────────────────
// The two movement kinds are picked FIRST, as two described cards, before any
// field appears — and picking one changes which fields exist. That ordering is
// the point. A single form with a "kind" dropdown at the bottom lets someone
// type a new price, tab past the dropdown on its default, and file an index rise
// as a scope change; the database would accept it (both shapes are legal), the
// budget would move, and the argument six months later would be about who
// decided to spend more. Making the choice the first, largest, most-explained
// thing on the screen is the cheapest place to stop that.
//
// ── WHAT THE PREVIEW IS AND IS NOT ───────────────────────────────────────────
// The value delta shown before submitting is computed by `swapPreview`, which
// mirrors the server's arithmetic. It is labelled as what will be RECORDED, and
// after the write the screen re-reads from the server rather than patching a
// local copy: the figure that matters is the one on the record, and a screen
// that shows its own arithmetic after a write can drift from it.
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

import { formatDateTime, moneyPrecise, delta, parseAmountToCents } from '@/lib/format';
import {
  RecordActionError, SwapDraftError, authorMaterials, emptySwapDraft, extendedCents,
  formatQuantity, materialsTotalCents, movementsForLine, parseQuantity, priceCauseLabel,
  swapMaterial, swapPreview, toSwapInput,
  type LineMaterial, type MaterialInput, type MaterialKind, type MovementKind,
  type PriceCause, type StageMaterialsView, type SwapDraft, type SwapInput,
} from '@/lib/record';
import type { PlanVersionStatus } from '@/lib/plan-baseline';

interface PartyRef { partyId: string; name: string }

interface Props {
  projectId: string;
  stageId: string;
  lineName: string;
  trade: string | null;
  plannedCostCents: number | null;
  view: StageMaterialsView;
  mayAuthor: boolean;
  maySwap: boolean;
  versionStatus: PlanVersionStatus | null;
  parties: PartyRef[];
}

export function LineDetail({
  projectId, stageId, lineName, trade, plannedCostCents, view,
  mayAuthor, maySwap, versionStatus, parties,
}: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [swapping, setSwapping] = useState<LineMaterial | null>(null);
  const [authoring, setAuthoring] = useState(false);

  const nameOf = (partyId: string) =>
    parties.find((p) => p.partyId === partyId)?.name ?? 'Unknown party';

  const total = materialsTotalCents(view.lineMaterials);
  const frozen = versionStatus !== null && versionStatus !== 'proposed';

  return (
    <div className="rc-line-detail">
      <div className="rc-head">
        <div className="rc-head-l">
          <h1 className="rc-title">{lineName}</h1>
          <p className="rc-lede">
            {trade ? `${trade} · ` : ''}What this line is made of, and everything that has moved it.
          </p>
        </div>
        <div className="rc-head-r">
          <span className="grp">Value now</span>
          <span className="num rc-fig-n">
            {total == null ? 'Not broken down' : moneyPrecise(total)}
          </span>
          {plannedCostCents != null ? (
            <span className="cap num">planned {moneyPrecise(plannedCostCents)}</span>
          ) : null}
        </div>
      </div>

      {/* The state of the line stated in one sentence, because every affordance
          below follows from it. */}
      <p className="rc-state-note cap">
        {frozen
          ? 'This line is frozen with the baseline. Nothing on it is edited — it is moved, and every movement is recorded with who made it and what it did to the money.'
          : versionStatus === 'proposed'
            ? 'This plan version is still a proposal. Materials can be authored and re-authored until it is accepted; after that they freeze.'
            : 'This line has no plan version behind it yet.'}
      </p>

      {error ? <p className="form-error" role="alert">{error}</p> : null}

      {/* ── The materials themselves ─────────────────────────────────────────── */}
      <section className="rc-panel" aria-labelledby="rc-mat-t">
        <div className="rc-panel-hd">
          <h2 className="rc-panel-t" id="rc-mat-t">Materials and labour behind the price</h2>
          {mayAuthor && !authoring ? (
            <button type="button" className="btn" onClick={() => { setAuthoring(true); setError(null); }}>
              Add materials
            </button>
          ) : null}
        </div>

        {view.lineMaterials.length === 0 ? (
          <p className="notice">
            No breakdown on this line yet. The line still carries its planned cost — a price
            without a breakdown is a price nobody can check, which is what this screen is for.
          </p>
        ) : (
          <div className="rc-mats card">
            <div className="rc-mathdr">
              <span className="grp">Item</span>
              <span className="grp rc-cell-n">Quantity</span>
              <span className="grp rc-cell-n">Unit price</span>
              <span className="grp rc-cell-n">Extended</span>
              <span className="grp" />
            </div>
            {view.lineMaterials.map((m) => {
              const mine = movementsForLine(view.movements, m.id);
              return (
                <div key={m.id} className="rc-mat">
                  <span className="rc-mat-main">
                    <span className="rc-mat-n">{m.name}</span>
                    <span className="cap">
                      {m.kind === 'labour' ? 'Labour' : 'Material'} · per {m.unit}
                      {mine.length > 0
                        ? ` · ${mine.length} movement${mine.length === 1 ? '' : 's'} recorded`
                        : ''}
                    </span>
                  </span>
                  <span className="num rc-cell-n">{formatQuantity(m.quantity)} {m.unit}</span>
                  <span className="num rc-cell-n">{moneyPrecise(m.unitPriceCents)}</span>
                  <span className="num rc-cell-n">{moneyPrecise(extendedCents(m))}</span>
                  <span className="rc-cell-a">
                    {maySwap && frozen ? (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => { setSwapping(m); setError(null); }}
                      >
                        Swap
                      </button>
                    ) : null}
                  </span>
                </div>
              );
            })}
            {total != null ? (
              <div className="rc-mat-total">
                <span className="grp">Line total</span>
                <span className="num">{moneyPrecise(total)}</span>
              </div>
            ) : null}
          </div>
        )}

        {maySwap && frozen && view.lineMaterials.length > 0 ? (
          <p className="cap">
            There is no edit button here on purpose. A baseline material is moved, never edited —
            and a move that changes the value opens a change order the other party has to agree to.
          </p>
        ) : null}
      </section>

      {authoring && mayAuthor ? (
        <MaterialAuthor
          onCancel={() => setAuthoring(false)}
          onSubmit={async (materials) => {
            try {
              await authorMaterials(stageId, materials);
              setAuthoring(false);
              router.refresh();
            } catch (err) {
              setError(messageOf(err));
              throw err;
            }
          }}
        />
      ) : null}

      {swapping ? (
        <SwapPanel
          material={swapping}
          onCancel={() => setSwapping(null)}
          onSubmit={async (input) => {
            try {
              await swapMaterial(stageId, input);
              setSwapping(null);
              // The server is the authority on what the line now reads and on what
              // the movement was worth — re-read rather than patch.
              router.refresh();
            } catch (err) {
              setError(messageOf(err));
              throw err;
            }
          }}
        />
      ) : null}

      {/* ── What has already moved this line ────────────────────────────────── */}
      <section className="rc-panel" aria-labelledby="rc-mov-t">
        <h2 className="rc-panel-t" id="rc-mov-t">Movements against this line</h2>
        {view.movements.length === 0 ? (
          <p className="notice">Nothing has moved this line since the baseline.</p>
        ) : (
          <ul className="rc-rows card">
            {[...view.movements].reverse().map((mv) => {
              const d = delta(mv.valueDeltaCents);
              const material = view.lineMaterials.find((m) => m.id === mv.lineMaterialId);
              return (
                <li key={mv.id} className="rc-row">
                  <span className="rc-row-main">
                    <span className="rc-row-t">
                      {mv.movementKind === 'scope_change' ? 'Scope change' : 'Price movement'}
                      {material ? ` · ${material.name}` : ''}
                    </span>
                    <span className="cap">
                      {mv.movementKind === 'price_movement'
                        ? `${priceCauseLabel(mv.priceCause)}${mv.source ? ` · ${mv.source}` : ''}`
                        : mv.source ?? 'no source given'}
                    </span>
                    <span className="cap">
                      {nameOf(mv.movedByPartyId)} · {formatDateTime(mv.occurredAt)}
                    </span>
                    {mv.changeOrderId ? (
                      <Link className="rc-row-src" href={`/change-orders/${mv.changeOrderId}`}>
                        See the change order →
                      </Link>
                    ) : (
                      <span className="cap">
                        Recorded only — this did not move the contract total.
                      </span>
                    )}
                  </span>
                  <span className={`num rc-row-amt delta ${d.dir}`}>{d.text}</span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="cap">
          Every movement is one event on the hash-chained record.{' '}
          <Link href={`/projects/${projectId}/record?tab=history`}>See the history</Link>.
        </p>
      </section>
    </div>
  );
}

// ── Authoring, while the version is still a proposal (route 3) ───────────────

interface DraftMaterial { kind: MaterialKind; name: string; unit: string; quantity: string; unitPrice: string }

const BLANK: DraftMaterial = { kind: 'material', name: '', unit: '', quantity: '', unitPrice: '' };

function MaterialAuthor({
  onCancel, onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (materials: MaterialInput[]) => Promise<void>;
}) {
  const [rows, setRows] = useState<DraftMaterial[]>([{ ...BLANK }]);
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const patch = (i: number, p: Partial<DraftMaterial>) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...p } : row)));

  // The running total as it is typed. A breakdown is checked against the line's
  // planned cost by eye more often than by anything else, so it is shown while
  // there is still a keyboard under it.
  const runningTotal = useMemo(() => {
    let sum = 0;
    for (const r of rows) {
      const q = Number(r.quantity);
      const p = Number(r.unitPrice);
      if (Number.isFinite(q) && Number.isFinite(p)) sum += Math.round(q * Math.round(p * 100));
    }
    return sum;
  }, [rows]);

  async function submit() {
    setFieldError(null);
    let parsed: MaterialInput[];
    try {
      parsed = rows.map((r, i) => {
        if (!r.name.trim()) throw new Error(`Give item ${i + 1} a name.`);
        if (!r.unit.trim()) throw new Error(`Say what ${r.name.trim() || `item ${i + 1}`} is measured in — m², each, hr.`);
        return {
          kind: r.kind,
          name: r.name.trim(),
          unit: r.unit.trim(),
          // The same parser the swap uses — one refusal rule for a quantity,
          // wherever it is typed. It rejects a fourth decimal rather than
          // truncating it into a different quantity.
          quantity: parseQuantity(r.quantity),
          unitPriceCents: parseAmountToCents(r.unitPrice, { label: 'unit price' }),
          position: i,
        };
      });
    } catch (err) {
      setFieldError((err as Error).message);
      return;
    }
    setBusy(true);
    try {
      await onSubmit(parsed);
    } catch {
      /* the parent rendered it */
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rc-editor card" aria-labelledby="rc-auth-t">
      <div className="rc-editor-hd">
        <h2 className="rc-editor-t" id="rc-auth-t">What is behind this price</h2>
        <p className="cap">
          Materials and labour. These freeze when the plan is accepted — after that a number only
          changes through a recorded movement, so it is worth getting them right now.
        </p>
      </div>

      {rows.map((r, i) => (
        <div key={i} className="rc-editrow">
          <label className="rc-field rc-field-wide">
            <span className="grp">Item</span>
            <input className="rc-input" value={r.name} maxLength={200}
              placeholder="Roof membrane" onChange={(e) => patch(i, { name: e.target.value })} />
          </label>
          <label className="rc-field">
            <span className="grp">Kind</span>
            <select className="rc-input" value={r.kind}
              onChange={(e) => patch(i, { kind: e.target.value as MaterialKind })}>
              <option value="material">Material</option>
              <option value="labour">Labour</option>
            </select>
          </label>
          <label className="rc-field">
            <span className="grp">Unit</span>
            <input className="rc-input" value={r.unit} maxLength={200}
              placeholder={r.kind === 'labour' ? 'hr' : 'm2'}
              onChange={(e) => patch(i, { unit: e.target.value })} />
          </label>
          <label className="rc-field">
            <span className="grp">Quantity</span>
            <input className="rc-input num" inputMode="decimal" value={r.quantity}
              placeholder="180" onChange={(e) => patch(i, { quantity: e.target.value })} />
          </label>
          <label className="rc-field">
            <span className="grp">Unit price</span>
            <input className="rc-input num" inputMode="decimal" value={r.unitPrice}
              placeholder="18.40" onChange={(e) => patch(i, { unitPrice: e.target.value })} />
          </label>
          {rows.length > 1 ? (
            <button type="button" className="btn rc-drop"
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
              Remove
            </button>
          ) : null}
        </div>
      ))}

      <div className="rc-editor-ft">
        <button type="button" className="btn" onClick={() => setRows((r) => [...r, { ...BLANK }])}>
          Add another item
        </button>
        <span className="cap num">Breakdown so far {moneyPrecise(runningTotal)}</span>
      </div>

      {fieldError ? <p className="form-error" role="alert">{fieldError}</p> : null}

      <div className="rc-actions">
        <button type="button" className="btn primary" disabled={busy} onClick={submit}>
          {busy ? 'Saving…' : 'Save the breakdown'}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}

// ── The swap (route 4) — the choice, then the fields the choice implies ──────

const KINDS: { key: MovementKind; title: string; blurb: string; consequence: string }[] = [
  {
    key: 'scope_change',
    title: 'The scope changed',
    blurb: 'More of it, less of it, or a different specification. What is being built is not what was agreed.',
    consequence: 'Opens a change order. The budget moves only when the other party approves it.',
  },
  {
    key: 'price_movement',
    title: 'The price moved',
    blurb: 'The same thing, at a different rate — an index, a new quote, or a correction to what was recorded.',
    consequence: 'Recorded against the baseline price. It does not move the contract total.',
  },
];

const CAUSES: { key: PriceCause; label: string }[] = [
  { key: 'index', label: 'Index movement' },
  { key: 'supplier_quote', label: 'Supplier quote' },
  { key: 'correction', label: 'Correction' },
];

function SwapPanel({
  material, onCancel, onSubmit,
}: {
  material: LineMaterial;
  onCancel: () => void;
  onSubmit: (input: SwapInput) => Promise<void>;
}) {
  // No default kind. The choice is deliberately un-made until someone makes it —
  // a preselected radio is a decision the form took on the user's behalf, and
  // this is the one decision on the screen that must be theirs.
  const [kind, setKind] = useState<MovementKind | null>(null);
  const [draft, setDraft] = useState<SwapDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);

  const choose = (k: MovementKind) => {
    setKind(k);
    setDraft(emptySwapDraft(material, k));
    setFieldError(null);
  };

  // The preview recomputes as you type and simply does not exist while the draft
  // does not parse — a half-typed price is not an error yet.
  const preview = useMemo(() => {
    if (!draft) return null;
    try {
      return swapPreview(material, toSwapInput(material, draft, (raw) =>
        parseAmountToCents(raw, { label: 'unit price' })));
    } catch {
      return null;
    }
  }, [material, draft]);

  async function submit() {
    if (!draft) return;
    setFieldError(null);
    let input;
    try {
      input = toSwapInput(material, draft, (raw) => parseAmountToCents(raw, { label: 'unit price' }));
    } catch (err) {
      if (err instanceof SwapDraftError) setFieldError({ field: err.field, message: err.message });
      else setFieldError({ field: 'quantity', message: (err as Error).message });
      return;
    }
    setBusy(true);
    try {
      await onSubmit(input);
    } catch {
      /* the parent rendered it */
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rc-editor card" aria-labelledby="rc-swap-t">
      <div className="rc-editor-hd">
        <h2 className="rc-editor-t" id="rc-swap-t">Move &ldquo;{material.name}&rdquo;</h2>
        <p className="cap num">
          Now: {formatQuantity(material.quantity)} {material.unit} at{' '}
          {moneyPrecise(material.unitPriceCents)} = {moneyPrecise(extendedCents(material))}
        </p>
      </div>

      <fieldset className="rc-kinds">
        <legend className="grp">What kind of move is this?</legend>
        {KINDS.map((k) => (
          <label key={k.key} className={`rc-kind ${kind === k.key ? 'is-on' : ''}`.trim()}>
            <input type="radio" name="movement-kind" value={k.key}
              checked={kind === k.key} onChange={() => choose(k.key)} />
            <span className="rc-kind-b">
              <span className="rc-kind-t">{k.title}</span>
              <span className="cap">{k.blurb}</span>
              <span className="rc-kind-c">{k.consequence}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {kind && draft ? (
        <>
          <div className="rc-swapfields">
            {/* Which fields exist IS the distinction, made visible. A scope change
                is about how much of it; a price movement is about the rate. */}
            {kind === 'scope_change' ? (
              <>
                <label className="rc-field">
                  <span className="grp">New quantity ({material.unit})</span>
                  <input className="rc-input num" inputMode="decimal" value={draft.quantity}
                    onChange={(e) => setDraft({ ...draft, quantity: e.target.value })} />
                </label>
                <label className="rc-field">
                  <span className="grp">Unit price (optional — leave to keep it)</span>
                  <input className="rc-input num" inputMode="decimal" value={draft.unitPrice}
                    onChange={(e) => setDraft({ ...draft, unitPrice: e.target.value })} />
                </label>
                <label className="rc-field rc-field-wide">
                  <span className="grp">Change order title</span>
                  <input className="rc-input" value={draft.changeOrderTitle} maxLength={200}
                    placeholder="Extra roof membrane — revised roof pitch"
                    onChange={(e) => setDraft({ ...draft, changeOrderTitle: e.target.value })} />
                </label>
              </>
            ) : (
              <>
                <label className="rc-field">
                  <span className="grp">New unit price</span>
                  <input className="rc-input num" inputMode="decimal" value={draft.unitPrice}
                    onChange={(e) => setDraft({ ...draft, unitPrice: e.target.value })} />
                </label>
                <label className="rc-field">
                  <span className="grp">Why did it move?</span>
                  <select className="rc-input" value={draft.priceCause}
                    onChange={(e) => setDraft({ ...draft, priceCause: e.target.value as PriceCause })}>
                    {CAUSES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                </label>
              </>
            )}
            <label className="rc-field rc-field-wide">
              <span className="grp">Source {kind === 'price_movement' ? '(where this rate came from)' : '(optional)'}</span>
              <input className="rc-input" value={draft.source} maxLength={500}
                placeholder="ACME steel index 2026-09 · quote #4471"
                onChange={(e) => setDraft({ ...draft, source: e.target.value })} />
            </label>
          </div>

          {fieldError ? <p className="form-error" role="alert">{fieldError.message}</p> : null}

          {preview ? (
            <div className={`rc-preview ${kind === 'scope_change' ? 'is-scope' : 'is-price'}`}>
              <p className="grp">What will be recorded</p>
              <p className="num rc-preview-n">
                {moneyPrecise(preview.priorExtendedCents)} → {moneyPrecise(preview.newExtendedCents)}{' '}
                <span className={`delta ${delta(preview.valueDeltaCents).dir}`}>
                  ({delta(preview.valueDeltaCents).text})
                </span>
              </p>
              <p className="cap">
                {kind === 'scope_change'
                  ? 'This opens a change order for that amount. The contract total moves only when the other party approves it — not now.'
                  : 'This is recorded against the baseline unit price and attributed to you. The contract total does not move.'}
              </p>
              <p className="cap">
                The figure that lands on the record is the server&apos;s, computed again when you send this.
              </p>
            </div>
          ) : null}

          <div className="rc-actions">
            <button type="button" className="btn primary" disabled={busy} onClick={submit}>
              {busy
                ? 'Recording…'
                : kind === 'scope_change' ? 'Record it and open the change order' : 'Record the price movement'}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
          </div>
        </>
      ) : (
        <div className="rc-actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        </div>
      )}
    </section>
  );
}

function messageOf(err: unknown): string {
  return err instanceof RecordActionError || err instanceof SwapDraftError
    ? err.message
    : 'That did not go through. Try again.';
}
