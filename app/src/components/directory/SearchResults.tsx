// The ordered result list (PRD-03 R-6, R-7 as decided by D-46). The order is
// the API's: companies with clients verified by the platform first, then the
// ones with none yet — this component only puts a heading over each group and
// says, in plain words, how the order is made.
import Link from 'next/link';

import {
  familyCodes, hrefWith, resultHeading, specialtyLabel,
  type SearchParams, type V2DirectorySearch, type V2Specialty,
} from '@/lib/v2/directory-view';

import { CompanyCard } from './CompanyCard';

export function SearchResults({
  result, params, taxonomy, base = '/companies', addTo = null,
}: {
  result: V2DirectorySearch;
  params: SearchParams;
  taxonomy: readonly V2Specialty[];
  base?: string;
  /** PRD-04 X-1: opened from a task's tender. */
  addTo?: { rfpId: string; returnTo: string } | null;
}) {
  const family = familyCodes(params.specialty, taxonomy);
  const ranked = result.items.filter((c) => c.record.ranked);
  const unranked = result.items.filter((c) => !c.record.ranked);
  const name = params.specialty ? specialtyLabel(params.specialty, taxonomy) : undefined;
  return (
    <main className="dres">
      <div className="dres-head">
        <b style={{ fontSize: 15 }}>{resultHeading(result, name)}</b>
        <span className="cap">
          Companies with clients verified on LinkNMS come first, by their record; then the rest by distance and
          specialty match. Profile completeness and paid plans never change the order.
        </span>
      </div>
      {!result.items.length ? (
        <p className="dempty">No company matches yet. Try a wider radius or the whole specialty.</p>
      ) : null}
      {ranked.length ? <h2 className="dgroup">With verified clients</h2> : null}
      {ranked.map((c) => <CompanyCard key={c.org_id} card={c} taxonomy={taxonomy} family={family} addTo={addTo} />)}
      {unranked.length ? <h2 className="dgroup">No verified clients yet</h2> : null}
      {unranked.map((c) => <CompanyCard key={c.org_id} card={c} taxonomy={taxonomy} family={family} addTo={addTo} />)}
      {result.next_cursor ? (
        <div className="dpager">
          <Link className="btn" href={hrefWith({ ...params, cursor: result.next_cursor }, base)}>More companies</Link>
        </div>
      ) : null}
    </main>
  );
}
