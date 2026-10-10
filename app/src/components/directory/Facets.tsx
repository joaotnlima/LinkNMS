// Search facets with counts (PRD-03 R-5). Each one is a link that toggles its
// value in the query string — counts are the API's, over the result set
// before facet filters. Proof facets name only what exists: builds on the
// record, a stated licence number, portfolio entries (no "checked" level).
import Link from 'next/link';

import {
  TEAM_SIZE_LABEL, facetOn, hrefWith, specialtyLabel, toggleFacetHref,
  type SearchParams, type V2Facets, type V2Specialty,
} from '@/lib/v2/directory-view';

function Opt({ href, on, label, n }: { href: string; on: boolean; label: string; n: number }) {
  return (
    <Link href={href} aria-current={on ? 'true' : undefined} scroll={false}>
      <span className="box" aria-hidden="true">{on ? '✓' : ''}</span>
      {label}
      <span className="n">{n}</span>
    </Link>
  );
}

export function Facets({
  facets, params, taxonomy, base = '/companies',
}: {
  facets: V2Facets;
  params: SearchParams;
  taxonomy: readonly V2Specialty[];
  base?: string;
}) {
  const claimedOn = params.claimed === 'true';
  return (
    <aside className="facets" aria-label="Filters">
      {facets.work_types.length ? (
        <div>
          <h3>Work types</h3>
          {facets.work_types.map((w) => (
            <Opt key={w.code} href={toggleFacetHref(params, 'work_type', w.code, base)}
              on={facetOn(params, 'work_type', w.code)} label={specialtyLabel(w.code, taxonomy)} n={w.count} />
          ))}
        </div>
      ) : null}
      <div>
        <h3>Proof</h3>
        <Opt href={toggleFacetHref(params, 'proof', 'on_record', base)} on={facetOn(params, 'proof', 'on_record')}
          label="Builds on LinkNMS (on the record)" n={facets.proof.on_record} />
        <Opt href={toggleFacetHref(params, 'proof', 'licence', base)} on={facetOn(params, 'proof', 'licence')}
          label="Licence number stated" n={facets.proof.licence} />
        <Opt href={toggleFacetHref(params, 'proof', 'portfolio', base)} on={facetOn(params, 'proof', 'portfolio')}
          label="Portfolio entries" n={facets.proof.portfolio} />
      </div>
      {facets.size.length ? (
        <div>
          <h3>Company size</h3>
          {facets.size.map((s) => (
            <Opt key={s.band} href={toggleFacetHref(params, 'size', s.band, base)} on={facetOn(params, 'size', s.band)}
              label={TEAM_SIZE_LABEL[s.band]} n={s.count} />
          ))}
        </div>
      ) : null}
      <div>
        <h3>Profile</h3>
        <Opt href={hrefWith({ ...params, claimed: claimedOn ? undefined : 'true', cursor: undefined }, base)} on={claimedOn}
          label="Claimed by the company" n={facets.claimed} />
      </div>
    </aside>
  );
}
