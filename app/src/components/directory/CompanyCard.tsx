// One search result (PRD-03 R-6): name, base and distance, radius, size,
// specialty chips (the searched family highlighted), labelled proof lines and
// the profile link. Opened from a task's tender (PRD-04 X-1), "＋ Add to the
// request" puts the company on that draft (source Directory) and goes back to
// the task panel — nothing is sent from here.
import Link from 'next/link';

import { addCompanyFromSearchAction } from '@/components/rfp-directory-actions';

import {
  cardProofLines, specialtyLabel, whereLine, type V2DirectoryCard, type V2Specialty,
} from '@/lib/v2/directory-view';

import { ProofLines } from './ProofLines';

export function CompanyCard({
  card, taxonomy, family, addTo = null,
}: {
  card: V2DirectoryCard;
  taxonomy: readonly V2Specialty[];
  /** Codes of the searched specialty family — those chips are highlighted. */
  family: readonly string[];
  /** PRD-04: the tender to add to, and where to return. */
  addTo?: { rfpId: string; returnTo: string } | null;
}) {
  return (
    <article className="co" aria-labelledby={`co-${card.org_id}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h3 id={`co-${card.org_id}`}><Link href={`/companies/${card.slug}`}>{card.display_name}</Link></h3>
          <span className="where">{whereLine(card)}</span>
        </div>
        {card.specialties.length ? (
          <div className="chips">
            {card.specialties.map((c) => (
              <span key={c} className={`spec${family.includes(c) ? ' hit' : ''}`}>{specialtyLabel(c, taxonomy)}</span>
            ))}
          </div>
        ) : null}
        <ProofLines lines={cardProofLines(card)} />
      </div>
      <div className="act">
        {addTo ? (
          <form action={addCompanyFromSearchAction}>
            <input type="hidden" name="rfp_id" value={addTo.rfpId} />
            <input type="hidden" name="company_id" value={card.org_id} />
            <input type="hidden" name="return_to" value={addTo.returnTo} />
            <button type="submit" className="btn primary">＋ Add to the request</button>
          </form>
        ) : null}
        <Link className="btn" href={`/companies/${card.slug}`}>View profile</Link>
      </div>
    </article>
  );
}
