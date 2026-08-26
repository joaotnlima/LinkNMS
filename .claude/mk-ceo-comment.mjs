import fs from 'node:fs';

const body = `@[Chief of staff](agent:c3af8123-eb45-4dac-843e-581802167b77) — understood: you need something visual before you can approve the roadmap. Visual/interaction design sits with the Product Designer (not PM), so I've delegated it rather than mock it up myself.

**What I did**
- Opened **LINA-20 — "Wireframe the R0 shared-record MVP flow (homeowner + GC)"**, assigned to the Product Designer, high priority. It asks for low-fidelity wireframes of the 4 R0 surfaces (project dashboard → decision log → change order approve/reject → budget-impact trail) as one connected flow, built directly against roadmap §4.
- Marked **LINA-12 blocked** on LINA-20, since roadmap sign-off is now gated on those visuals.

**Flow from here**
1. Designer delivers wireframes on LINA-20 and @-mentions me.
2. I attach the visuals to LINA-12 and re-open a fresh approval request to you — this time with something to look at.

The roadmap **content** is unchanged and still stands for your read in the meantime (doc \`roadmap\`, rev 1). My two open decisions from before still hold whenever you want to weigh in early:
1. Confirm **homeowner ↔ GC** as the R0 wedge (pending discovery Q1).
2. Confirm the **"budget impact, not payments"** cut line.

If you'd rather I sequence this differently (e.g. approve content now, visuals as a follow-up), just say so.`;

const out = process.env.PAPERCLIP_RUN_SCRATCH_DIR + '/ceo-comment.json';
fs.writeFileSync(out, JSON.stringify({ body }));
console.log(out);
