// One search result (PRD-03 R-6): name, base and distance, radius, size,
// specialty chips (the searched family highlighted), labelled proof lines and
// the profile link. "Add to RFP" arrives with PRD-04.
import Link from 'next/link';

import {
  cardProofLines, specialtyLabel, whereLine, type V2DirectoryCard, type V2Specialty,
} from '@/lib/v2/directory-view';

import { ProofLines } from './ProofLines';

export function CompanyCard({
  card, taxonomy, family,
}: {
  card: V2DirectoryCard;
  taxonomy: readonly V2Specialty[];
  /** Codes of the searched specialty family — those chips are highlighted. */
  family: readonly string[];
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
        <Link className="btn" href={`/companies/${card.slug}`}>View profile</Link>
      </div>
    </article>
  );
}
