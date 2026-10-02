'use client';

// Shared plan FIELD controls (LINA-404) — ONE Jira-style dropdown behind every
// settable cell on the plan surface: Status, Owner and Specialty, in the grid
// rows AND in the detail drawer. The founder's ask: "open a specific dropdown
// component like jira for both specialties, status, owner" and "the sidebar open
// task dropdown is too wide now… should reuse the new required component".
//
// Before this, each cell was a bare native `<select>` (one per column, a second
// full-width copy in the drawer) — the drawer's owner/specialty selects stretched
// the whole panel, and the look drifted control to control. `FieldMenu` is the
// single floating popover (a trigger that shows the current value + a menu of
// options, click-away + Escape to close) the three field components render over,
// so they read as one system and size to their content, never the panel.
//
// None of these own plan state: each is a thin control over a value the editor's
// pure ops hold (status is an append-only progress report, owner/specialty are
// authored fields). They call back; nothing writes here.
import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';

import { PartyAvatar, UnassignedAvatar } from '@/components/PartyAvatar';
import { partyOf, roleWord, type PartyRef } from '@/lib/party-display';
import type { StageStatus } from '@/lib/plan-authoring';

/** The member index the grid/editor already build with `partyIndex`. */
type PartyIndex = Map<string, PartyRef>;

/**
 * The status palette (moved here from PlanGrid so the pill colour has ONE home
 * the grid, the drawer and the menu all read). Each StageStatus → its swatch
 * class and word. The classes resolve to tokens in plan-build.css.
 */
export const STATUS_META: Record<StageStatus, { cls: string; label: string }> = {
  done: { cls: 'is-done', label: 'Done' },
  in_progress: { cls: 'is-doing', label: 'In progress' },
  blocked: { cls: 'is-blocked', label: 'Blocked' },
  not_started: { cls: 'is-todo', label: 'Not started' },
};
/** Menu / legend order: not begun → active → stuck → closed. */
export const STATUS_ORDER: StageStatus[] = ['not_started', 'in_progress', 'blocked', 'done'];

// ── FieldMenu ─────────────────────────────────────────────────────────────────
// The one floating dropdown. A trigger button shows the current selection; click
// it (or Enter/Space/↓) to open the popover of options below it, pick one with a
// click or the arrow keys, Escape or a click-away to dismiss. Positioned absolute
// within a relative wrapper (same approach as the scheduling-links popover), with
// a fixed click-away scrim so it can never leak past unmount.
export type FieldOption = {
  value: string;
  label: string;
  /** A status swatch class (is-done …) rendered as a leading colour dot. */
  swatchClass?: string;
  /** Custom leading content (e.g. an owner avatar) — wins over `swatchClass`. */
  lead?: React.ReactNode;
  /** Muted trailing note (e.g. a party role). */
  note?: string;
  /** A footer action (＋ Add new…) — divided from the options, not a value pick. */
  isAction?: boolean;
};

export function FieldMenu({
  value, options, onSelect, trigger, triggerClassName, triggerTitle, ariaLabel,
  disabled = false, busy = false, error, align = 'left', menuClassName,
}: {
  value: string;
  options: FieldOption[];
  onSelect: (value: string) => void;
  /** The content inside the trigger button — a pill, an avatar, a label. */
  trigger: React.ReactNode;
  triggerClassName?: string;
  triggerTitle?: string;
  ariaLabel: string;
  disabled?: boolean;
  busy?: boolean;
  error?: string | null;
  align?: 'left' | 'right';
  menuClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // The trigger's viewport rect, tracked while open so the portalled popover sits
  // right under it (and follows a scroll/resize). A portal + fixed positioning is
  // what keeps the menu from being clipped by the grid's `overflow: hidden`
  // ancestor — the one thing a plain absolute popover could not escape, and why the
  // old controls had to be native <select>s.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; bottom: number } | null>(null);
  const listId = useId();

  // Index of the currently-selected option, so opening lands the highlight on it.
  const selectedIdx = useMemo(
    () => options.findIndex((o) => !o.isAction && o.value === value),
    [options, value],
  );

  const measure = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setRect({ top: r.top, left: r.left, width: r.width, bottom: r.bottom });
  }, []);

  const openMenu = useCallback(() => {
    if (disabled || busy) return;
    setActive(selectedIdx >= 0 ? selectedIdx : 0);
    measure();
    setOpen(true);
  }, [disabled, busy, selectedIdx, measure]);

  // Keep the popover glued to the trigger through any scroll or resize while open;
  // move focus into it so the arrow keys drive it immediately. Capture-phase scroll
  // so it tracks whichever container actually scrolled (the grid pans a lot).
  useLayoutEffect(() => {
    if (!open) return undefined;
    measure();
    popRef.current?.focus();
    const onScroll = () => measure();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, measure]);

  const pick = useCallback((opt: FieldOption) => {
    setOpen(false);
    onSelect(opt.value);
  }, [onSelect]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      // Wrap through every row (actions included — they are pickable too).
      setActive((i) => (i + step + options.length) % options.length);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const opt = options[active];
      if (opt) pick(opt);
    }
  }, [options, active, pick]);

  return (
    <span className="fm" onClick={(e) => e.stopPropagation()}>
      <button
        ref={triggerRef}
        type="button"
        className={`fm-trigger${triggerClassName ? ` ${triggerClassName}` : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-busy={busy}
        title={triggerTitle}
        disabled={disabled || busy}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            openMenu();
          }
        }}
      >
        {trigger}
        <svg className="fm-caret" viewBox="0 0 24 24" width="12" height="12" fill="none"
          stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"
          aria-hidden focusable="false">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && rect && typeof document !== 'undefined' ? createPortal(
        <>
          <div className="fm-away" role="presentation" onClick={() => setOpen(false)} />
          <div
            ref={popRef}
            className={`fm-pop${menuClassName ? ` ${menuClassName}` : ''}`}
            role="listbox"
            id={listId}
            aria-label={ariaLabel}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            style={{
              position: 'fixed',
              top: rect.bottom + 4,
              // Right-align to the trigger's right edge, else left-align; clamp into
              // the viewport so a near-edge cell never pushes the menu off-screen.
              ...(align === 'right'
                ? { right: Math.max(8, window.innerWidth - rect.left - rect.width) }
                : { left: Math.min(Math.max(8, rect.left), window.innerWidth - 232) }),
              minWidth: Math.max(rect.width, 200),
            }}
          >
            {options.map((o, i) => (
              <button
                key={`${o.value}:${i}`}
                type="button"
                role={o.isAction ? undefined : 'option'}
                aria-selected={o.isAction ? undefined : o.value === value}
                className={[
                  o.isAction ? 'fm-action' : 'fm-opt',
                  i === active ? 'is-active' : '',
                  !o.isAction && o.value === value ? 'is-selected' : '',
                ].filter(Boolean).join(' ')}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o)}
              >
                {o.lead
                  ? <span className="fm-lead">{o.lead}</span>
                  : o.swatchClass
                    ? <span className={`fm-dot ${o.swatchClass}`} aria-hidden />
                    : null}
                <span className="fm-opt-label">{o.label}</span>
                {o.note ? <span className="fm-opt-note">{o.note}</span> : null}
                {!o.isAction && o.value === value ? (
                  <svg className="fm-check" viewBox="0 0 24 24" width="13" height="13" fill="none"
                    stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round"
                    aria-hidden focusable="false">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                ) : null}
              </button>
            ))}
          </div>
        </>,
        document.body,
      ) : null}
      {error ? <span className="fm-err" role="alert">{error}</span> : null}
    </span>
  );
}

// ── StatusPicker ────────────────────────────────────────────────────────────
// The settable leaf-status control (LINA-307; now the shared menu, LINA-404).
// Same signature the grid and drawer already call, so both call sites are
// untouched: an optimistic pick that rolls back and shows the reason inline on a
// typed refusal (e.g. the GC-only 403). The caller no longer refreshes the page
// (LINA-404) — it patches the draft in place — so this picker's own `val` is the
// source of truth between renders; the parent keys it on the server value, so a
// reload still re-seats it on the record.
export function StatusPicker({
  nodeKey, value, over, what, onSet,
}: {
  nodeKey: string;
  value: StageStatus;
  over: boolean;
  what: string;
  onSet: (nodeKey: string, status: StageStatus) => Promise<void> | void;
}) {
  const [val, setVal] = useState<StageStatus>(value);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const meta = STATUS_META[val];
  const word = over ? `${meta.label} · overdue` : meta.label;

  const choose = useCallback(async (next: StageStatus) => {
    if (next === val) return;
    const prev = val;
    setVal(next);
    setBusy(true);
    setErr(null);
    try {
      await onSet(nodeKey, next);
    } catch (e) {
      // Roll back to the last recorded value and surface why — the record is
      // unchanged, so the control must not claim otherwise.
      setVal(prev);
      setErr(e instanceof Error ? e.message : 'Could not update the status.');
    } finally {
      setBusy(false);
    }
  }, [val, onSet, nodeKey]);

  return (
    <span className={`pgd-statusedit${over ? ' is-overdue' : ''}`}>
      <FieldMenu
        ariaLabel={`${what} status`}
        triggerTitle={`${what}: ${word}`}
        triggerClassName={`fm-status ${meta.cls}`}
        busy={busy}
        error={err}
        value={val}
        trigger={<span className="fm-status-word">{word}</span>}
        options={STATUS_ORDER.map((s) => ({
          value: s, label: STATUS_META[s].label, swatchClass: STATUS_META[s].cls,
        }))}
        onSelect={(v) => { void choose(v as StageStatus); }}
      />
    </span>
  );
}

// ── OwnerField ────────────────────────────────────────────────────────────────
// The row/drawer owner control: the avatar states WHO, the menu changes it. Two
// shapes behind one component (the founder's "reuse" ask): `avatar` is the grid
// cell (just the circle; the name lives in the menu), `full` is the drawer
// (avatar + name beside it, so the panel reads at a glance). Options are the
// project's parties plus Unassigned; an owner no longer in the directory keeps a
// synthetic option so the row never blanks.
export function OwnerField({
  value, parties, dir, disabled, ariaLabel, onAssign, variant = 'avatar',
}: {
  value: string | null;
  parties: PartyRef[];
  dir: PartyIndex;
  disabled: boolean;
  ariaLabel: string;
  onAssign: (partyId: string | null) => void;
  variant?: 'avatar' | 'full';
}) {
  const p = partyOf(dir, value);
  const avatar = (size: 'sm' | 'md') => (p ? <PartyAvatar party={p} size={size} /> : <UnassignedAvatar size={size} />);

  const options: FieldOption[] = useMemo(() => {
    const out: FieldOption[] = [{
      value: '', label: 'Unassigned', lead: <UnassignedAvatar size="sm" />,
    }];
    for (const m of parties) {
      out.push({
        value: m.partyId, label: m.name, note: roleWord(m.role),
        lead: <PartyAvatar party={m} size="sm" />,
      });
    }
    // An assigned party the directory no longer lists (e.g. removed from the
    // build): keep it selectable so the current owner still shows as chosen.
    if (value && !dir.has(value)) {
      out.push({ value, label: p?.name ?? 'Former member', lead: avatar('sm') });
    }
    return out;
  }, [parties, value, dir, p]);

  return (
    <span className={`fm-owner is-${variant}`}>
      <FieldMenu
        ariaLabel={ariaLabel}
        triggerTitle={p ? `${p.name} · ${roleWord(p.role)}` : 'Unassigned — click to assign'}
        triggerClassName="fm-ownertrigger"
        disabled={disabled}
        value={value ?? ''}
        trigger={(
          <>
            {avatar(variant === 'full' ? 'md' : 'sm')}
            {variant === 'full'
              ? <span className="fm-ownername">{p ? p.name : 'Unassigned'}</span>
              : null}
          </>
        )}
        options={options}
        onSelect={(v) => onAssign(v || null)}
      />
    </span>
  );
}

// ── Specialty catalog (lifted from PlanGrid so the drawer shares it) ──────────
// The caller's known trades: the seeded system set ∪ anything they have typed,
// across every project (GET /api/v2/specialties). Committing a brand-new label
// remembers it (POST, idempotent) so it is offered next time. Enhancement-only —
// a failure never loses the typed label (the stage already holds it); the picker
// just does not learn it.
export function useSpecialtyCatalog(): { specialties: string[]; remember: (label: string) => void } {
  const [specialties, setSpecialties] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    fetch('/api/v2/specialties', { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { specialties?: Array<{ label: string }> } | null) => {
        if (live && d?.specialties) setSpecialties(d.specialties.map((s) => s.label));
      })
      .catch(() => { /* picker is enhancement-only; the free-form input stands */ });
    return () => { live = false; };
  }, []);

  const remember = useCallback((raw: string) => {
    const label = raw.trim();
    if (!label) return;
    setSpecialties((prev) => {
      if (prev.some((s) => s.toLowerCase() === label.toLowerCase())) return prev;
      return [...prev, label].sort((a, b) => a.localeCompare(b));
    });
    fetch('/api/v2/specialties', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label }),
    }).catch(() => { /* enhancement-only */ });
  }, []);

  return { specialties, remember };
}

// ── SpecialtyField ────────────────────────────────────────────────────────────
// The row/drawer specialty control (LINA-306's picker, now the shared menu). The
// catalog ∪ the stage's own value is the option list; a "＋ Add new…" footer
// action reveals a free-text input for a label the catalog does not yet know —
// the deliberate escape hatch from LINA-306, kept alive. Selection is
// presentational over the draft; nothing writes until the editor's autosave lands.
const ADD_SPECIALTY = '__add_specialty__';
export function SpecialtyField({
  value, options, disabled, ariaLabel, onSet, onRemember,
}: {
  value: string;
  options: string[];
  disabled: boolean;
  ariaLabel: string;
  onSet: (label: string) => void;
  onRemember: (label: string) => void;
}) {
  const [adding, setAdding] = useState(false);

  const opts = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const label of [...options, value]) {
      const l = label.trim();
      if (!l) continue;
      const k = l.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(l);
    }
    return out.sort((a, b) => a.localeCompare(b));
  }, [options, value]);

  if (adding) {
    return (
      <span className="pgd-trade" onClick={(e) => e.stopPropagation()}>
        <input
          className="pgd-tradeinput" autoFocus placeholder="New specialty" defaultValue=""
          maxLength={120} aria-label={ariaLabel} disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') setAdding(false);
          }}
          onBlur={(e) => {
            const label = e.target.value.trim();
            if (label) { onSet(label); onRemember(label); }
            setAdding(false);
          }}
        />
      </span>
    );
  }

  return (
    <span className="pgd-trade">
      <FieldMenu
        ariaLabel={ariaLabel}
        triggerTitle={value || 'Choose a specialty'}
        triggerClassName="fm-specialty"
        disabled={disabled}
        value={value}
        trigger={<span className={`fm-specialty-word${value ? '' : ' is-empty'}`}>{value || 'Specialty…'}</span>}
        options={[
          ...opts.map((s) => ({ value: s, label: s })),
          { value: ADD_SPECIALTY, label: '＋ Add new…', isAction: true },
        ]}
        onSelect={(v) => {
          if (v === ADD_SPECIALTY) { setAdding(true); return; }
          onSet(v);
        }}
      />
    </span>
  );
}
