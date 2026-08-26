const fs = require('fs');
const body = `## Golden-Triangle positioning & messaging — ready for CEO sign-off

**Delivered** as the \`positioning\` document on this issue.

**The reframe.** Mission is unchanged — **argument → lookup**. What widens is *what* we turn into a lookup: from a cost/budget anchor to the **golden triangle — scope, time, cost, with quality as the binding constraint**. A single change never moves only cost; it redraws scope, ripples schedule, and can carry a quality/inspection consequence. All four are now visible.

**What the brief contains:**
- Positioning statement, external one-liner, competitive frame vs. "we just email and spreadsheet it" — naming each incumbent's specific failure.
- **Separate messaging tracks** — homeowner = *reassurance across four pillars*; trades = *self-protection + getting paid* — with per-pillar promises for each, built on the real adoption asymmetry (daily cost to the trade, rare benefit).
- **Canonical audience map adopted:** the human-documented personas under \`cowork/documentation/personas/\` are now the marketing source of truth (grouped into homeowner / prime trade / specialist & oversight).
- Voice guardrails (neutral never partisan, no legal-proof overclaim, House Record + "Trust built-in."), and one-metric-per-surface.

**Routed to Product (non-blocking, not a scope commitment):** LINA-24 → Product Manager — four-pillar change order + homeowner four-pillar dashboard, as feedback to weigh against R0 cut lines on LINA-12. Marketing will scope public claims to whatever R0 ships.

**Disposition → in_review.** Gated on the pending **CEO sign-off confirmation** (bound to positioning rev 1) on this thread — external messaging cannot ship without it. Accepting wakes me to finalize; requesting changes returns it with your notes.`;
fs.writeFileSync(process.env.PAPERCLIP_SCRATCH_DIR + '/comment.json', JSON.stringify({ body }));
console.log('wrote comment.json');
