'use client';

// The scrubbed-scroll controller for the pinned sequence (LINA-89, restored
// for LINA-113).
//
// Division of labour with the rest of the stack:
//   - `landing-sequence.ts` is pure: `p → state`. No DOM, no gsap, no React.
//   - `ScrollSequence.tsx` (server) renders the *final* p=1 state and all four
//     captions / three HUD readings into the DOM.
//   - THIS component only orchestrates: it reads `p` off the scroll and writes
//     the state the pure module returns onto the DOM nodes the server already
//     built. It never re-authors a number or a line of copy.
//
// The reduced-motion / small-viewport / slow-connection guard runs FIRST and
// returns without touching a single animation byte on the static path — no
// top-level import of gsap / ScrollTrigger / Lenis, only a `resolveRenderPath()`
// call and an early return. Everything heavyweight is a dynamic `import()`
// behind that guard, so the static path ships zero extra JS.
//
// Exactly one timeline, one ScrollTrigger (pin, scrub, end +=300%) — the spec's
// shape — with `onUpdate` turning `self.progress` into our normalized `p`.

import { useLayoutEffect } from 'react';
import { resolveRenderPath } from '@/lib/landing-render-path';
import { track } from '@/lib/analytics-client';
import { SEQUENCE_KEYFRAMES, SEQUENCE_ROW_KEYS, type SequenceRowKey } from '@/lib/landing-numbers';
import {
  sequenceStateAt,
  laneTransform,
  type SequenceState,
  type StageNumber
} from '@/lib/landing-sequence';
import { STAGE_1_TO_2 } from '@/lib/landing-flags';

/**
 * The stage 1 → 2 handoff, isolated behind a single function on purpose.
 *
 * Only this one handoff is special. With `STAGE_1_TO_2 === 'cut'` the two
 * stills never share the screen: stage 1 holds until the commit (KF B, t = 0.5)
 * and then stage 2 takes over instantly. 2 → 3 and 3 → 4 are camera dissolves
 * and always stay blends. Stage 1 is the exception because its plate is shot
 * from a different camera than 2-4 (LINA-117 restored the golden-hour
 * wireframe render), so there is no shared framing to dissolve through — see
 * `STAGE_1_TO_2` in `landing-flags.ts`.
 */
function applyStage1To2(_p: number, state: SequenceState): SequenceState {
  if (STAGE_1_TO_2 !== 'cut') return state;
  if (state.keyframeId === 'A') {
    return { ...state, stageBlend: { 1: 1, 2: 0, 3: 0, 4: 0 } };
  }
  if (state.keyframeId === 'B') {
    return { ...state, stageBlend: { 1: 0, 2: 1, 3: 0, 4: 0 } };
  }
  return state;
}

/** Progress points at which `scroll_sequence_progress` fires, from the table. */
const PROGRESS_POINTS = SEQUENCE_KEYFRAMES.map((kf) => ({
  id: `kf_${kf.id.toLowerCase()}`,
  p: kf.p
}));

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

type RowRefs = {
  row: HTMLElement | null;
  lane: SVGGElement | null;
  planned: SVGGElement | null;
  actual: SVGGElement | null;
  check: HTMLElement | null;
};

type Refs = {
  root: HTMLElement;
  stages: Record<StageNumber, HTMLElement | null>;
  captionBlocks: HTMLElement[];
  hudSpans: HTMLElement[];
  hud: HTMLElement | null;
  bars: HTMLElement | null;
  rows: Record<SequenceRowKey, RowRefs>;
};

function buildRefs(root: HTMLElement): Refs {
  const stages = {} as Record<StageNumber, HTMLElement | null>;
  for (let s = 1 as StageNumber; s <= 4; s++) {
    stages[s] = root.querySelector(`[data-stage="${s}"]`);
  }
  const captionBlocks = Array.from(
    root.querySelectorAll<HTMLElement>('.lp-sequence__caption-block')
  );
  // Labels AND values: the pen relabels the middle cell as the build advances,
  // so both swap on the same keyframe.
  const hudSpans = Array.from(root.querySelectorAll<HTMLElement>('.lp-hud__cell [data-kf]'));
  const hud = root.querySelector<HTMLElement>('.lp-hud');
  const bars = root.querySelector<HTMLElement>('.lp-bars');
  const rows = {} as Refs['rows'];
  for (const key of SEQUENCE_ROW_KEYS) {
    const track = root.querySelector<SVGSVGElement>(`.lp-seqtrack__bars[data-row="${key}"]`);
    rows[key] = {
      row: track?.closest<HTMLElement>('.lp-bars__row') ?? null,
      lane: track?.querySelector<SVGGElement>('g[data-lane-group]') ?? null,
      planned: track?.querySelector<SVGGElement>('g[data-lane="planned"]') ?? null,
      actual: track?.querySelector<SVGGElement>('g[data-lane="actual"]') ?? null,
      check: root.querySelector<HTMLElement>(`.lp-seqtrack__check[data-check="${key}"]`)
    };
  }
  return { root, stages, captionBlocks, hudSpans, hud, bars, rows };
}

/**
 * Write one `SequenceState` onto the cached DOM nodes. Only `opacity` and
 * `transform` change per frame; the HUD tone and the caption/HUD swaps are
 * discrete state changes a browser trivially absorbs. Nothing here forces
 * layout on the scrub path — in particular the check mark's x never moves, so
 * it is opacity alone.
 */
function render(refs: Refs, state: SequenceState): void {
  for (let s = 1 as StageNumber; s <= 4; s++) {
    const el = refs.stages[s];
    if (!el) continue;
    const v = state.stageBlend[s] ?? 0;
    el.style.opacity = String(round3(v));
    el.dataset.visible = v >= 0.5 ? 'true' : 'false';
  }

  for (const key of SEQUENCE_ROW_KEYS) {
    const r = state.rows[key];
    const ref = refs.rows[key];
    if (ref.planned) {
      ref.planned.setAttribute('transform', laneTransform(r.plannedOffset, r.plannedWidth));
    }
    if (ref.actual) {
      ref.actual.setAttribute('transform', laneTransform(r.actualOffset, r.actualWidth, r.actualY));
      ref.actual.setAttribute('opacity', String(round3(r.actualOpacity)));
    }
    if (ref.lane) ref.lane.setAttribute('opacity', String(round3(r.laneOpacity)));
    if (ref.check) ref.check.style.opacity = String(round3(r.checkOpacity));
    if (ref.row) ref.row.dataset.closed = r.phase === 'closed' ? 'true' : 'false';
  }

  for (const block of refs.captionBlocks) {
    block.dataset.visible = block.dataset.caption === state.captionId ? 'true' : 'false';
  }
  for (const span of refs.hudSpans) {
    span.dataset.visible = span.dataset.kf === state.captionId ? 'true' : 'false';
  }
  if (refs.hud) refs.hud.dataset.tone = state.hudTone;

  const chrome = String(round3(state.chromeOpacity));
  if (refs.bars) refs.bars.style.opacity = chrome;
  if (refs.hud) refs.hud.style.opacity = chrome;
}

export function SequenceMotion(): null {
  useLayoutEffect(() => {
    const { renderPath } = resolveRenderPath();
    if (renderPath !== 'animated') return;
    const root = document.getElementById('the-sequence');
    if (!root) return;
    const seqRoot: HTMLElement = root;

    // Wind the server's p=1 state back to p=0 before paint so the drawing is
    // what the visitor sees first, then load the animation libraries.
    const refs = buildRefs(seqRoot);
    render(refs, sequenceStateAt(0));

    const stages = [1, 2, 3, 4] as const;
    for (const s of stages) {
      const el = refs.stages[s];
      if (el) el.style.willChange = 'opacity';
    }

    let disposed = false;
    let lenis: {
      destroy: () => void;
      on: (event: 'scroll', cb: (e: unknown) => void) => void;
    } | null = null;
    let tl: { scrollTrigger: { kill: () => void } | undefined } | null = null;
    let firstOnUpdate = true;
    let startFired = false;
    let completedFired = false;
    let everReversed = false;
    let lastP = 0;
    let startTime = 0;
    const firedProgress = new Set<string>();

    // Best-effort "ms to first stage image decoded" for the start event.
    const navStart =
      typeof performance.timeOrigin === 'number'
        ? performance.timeOrigin
        : performance.now();
    let firstImageDecodedAt: number | null = null;

    function handleProgress(p: number): void {
      const state = applyStage1To2(p, sequenceStateAt(p));
      render(refs, state);

      if (p < lastP - 0.0001) everReversed = true;
      const moving = p - lastP >= -0.0001;

      if (!startFired && p > 0) {
        startFired = true;
        const properties: Record<string, unknown> = {};
        if (firstImageDecodedAt != null) {
          properties.assets_ms = Math.round(firstImageDecodedAt - navStart);
        }
        track('scroll_sequence_start', properties);
      }

      if (moving) {
        for (const point of PROGRESS_POINTS) {
          if (!firedProgress.has(point.id) && p >= point.p) {
            firedProgress.add(point.id);
            track('scroll_sequence_progress', { keyframe: point.id, p: point.p });
          }
        }
      }

      if (!completedFired && p >= 1) {
        completedFired = true;
        track('scroll_sequence_completed', {
          duration_ms: Math.round(performance.now() - startTime),
          reversed: everReversed
        });
      }

      lastP = p;
    }

    async function init(): Promise<void> {
      if (disposed) return;
      const [{ default: gsap }, { default: ScrollTrigger }, { default: Lenis }] =
        await Promise.all([
          import('gsap'),
          import('gsap/ScrollTrigger'),
          import('lenis')
        ]);
      if (disposed) return;

      const firstImg = seqRoot.querySelector<HTMLImageElement>('.lp-sequence img');
      if (firstImg) {
        const mark = () => {
          firstImageDecodedAt = performance.now();
        };
        if (typeof firstImg.decode === 'function') {
          firstImg.decode().then(mark, () => undefined);
        } else {
          firstImg.addEventListener('load', mark, { once: true });
        }
      }

      gsap.registerPlugin(ScrollTrigger);

      const l = new Lenis({ autoRaf: true, syncTouch: false });
      l.on('scroll', () => ScrollTrigger.update());
      lenis = l;

      // One timeline + one ScrollTrigger (pin, scrub, end +=300%), the spec's
      // shape. `onUpdate` turns self.progress — 0..1 — into our `p`.
      const built = gsap.timeline({
        scrollTrigger: {
          trigger: seqRoot,
          start: 'top top',
          end: '+=300%',
          scrub: 1,
          pin: true,
          anticipatePin: 1,
          onUpdate: (self) => {
            if (firstOnUpdate) {
              firstOnUpdate = false;
              startTime = performance.now();
            }
            handleProgress(self.progress);
          }
        }
      });
      tl = built as { scrollTrigger: { kill: () => void } };
    }

    init();

    return () => {
      disposed = true;
      lenis?.destroy();
      tl?.scrollTrigger?.kill();
      for (const s of stages) {
        const el = refs.stages[s];
        if (el) el.style.willChange = '';
      }
    };
  }, []);

  return null;
}