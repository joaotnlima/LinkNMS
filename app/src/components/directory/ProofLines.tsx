// Labelled proof lines (PRD-03 §4.4 as decided by D-46): each claim carries
// exactly one label — "On the record" (from LinkNMS builds) or "Stated" (the
// company's own words). There is no "Checked" level.
import type { ProofLine } from '@/lib/v2/directory-view';

export function ProofLines({ lines }: { lines: ProofLine[] }) {
  return (
    <div className="proof">
      {lines.map((l, i) => (
        <span key={i} className="pv">
          <i className={l.level === 'on_record' ? 'rec' : 'sta'}>{l.label}</i>
          {l.text}
        </span>
      ))}
    </div>
  );
}
