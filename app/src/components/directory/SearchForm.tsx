// The directory search bar (PRD-03 R-4): specialty, where, radius, can start
// by. A plain GET form — the query string is view state (to-be/20 rule 6) and
// the page re-renders on the server. Opened from a build, `near_project` rides
// along as a hidden field and replaces the municipality box.
import { RADII, specialtyGroups, type SearchParams, type V2Specialty } from '@/lib/v2/directory-view';

export function SearchForm({
  params, taxonomy, action = '/companies', nearLabel,
}: {
  params: SearchParams;
  taxonomy: readonly V2Specialty[];
  action?: string;
  /** Set when the search is anchored on a build the viewer takes part in. */
  nearLabel?: string;
}) {
  return (
    <form className="sbar2" role="search" method="get" action={action}>
      <label htmlFor="d-spec">
        <span>Specialty</span>
        <select id="d-spec" name="specialty" defaultValue={params.specialty ?? ''}>
          <option value="">Any specialty</option>
          {specialtyGroups(taxonomy).map(({ parent, children }) => (
            <optgroup key={parent.code} label={parent.name_en}>
              <option value={parent.code}>{parent.name_en} — all ({parent.name_pt.toLowerCase()})</option>
              {children.map((c) => <option key={c.code} value={c.code}>{c.name_en} ({c.name_pt.toLowerCase()})</option>)}
            </optgroup>
          ))}
        </select>
      </label>
      {params.near_project ? (
        <label>
          <span>Where</span>
          <input type="hidden" name="near_project" value={params.near_project} />
          <input value={nearLabel ?? 'Your build'} readOnly aria-readonly="true" />
        </label>
      ) : (
        <label htmlFor="d-where">
          <span>Municipality (INE code)</span>
          <input id="d-where" name="municipality" inputMode="numeric" maxLength={4} placeholder="1111" defaultValue={params.municipality ?? ''} />
        </label>
      )}
      <label htmlFor="d-rad" style={{ flex: '0 0 130px' }}>
        <span>Within</span>
        <select id="d-rad" name="radius_km" defaultValue={params.radius_km ?? '50'}>
          {RADII.map((r) => <option key={r} value={String(r)}>{r} km</option>)}
        </select>
      </label>
      <label htmlFor="d-start" style={{ flex: '0 0 170px' }}>
        <span>Can start by</span>
        <input id="d-start" name="can_start_by" type="date" defaultValue={params.can_start_by ?? ''} />
      </label>
      {/* PRD-04 X-1: opened from a task's tender — keep adding to it, and the way back. */}
      {params.for_rfp ? <input type="hidden" name="for_rfp" value={params.for_rfp} /> : null}
      {params.return_to ? <input type="hidden" name="return_to" value={params.return_to} /> : null}
      <button type="submit">Search</button>
    </form>
  );
}
