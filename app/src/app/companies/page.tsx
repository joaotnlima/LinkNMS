// /companies — find who does the work, near this build (PRD-03 D1, R-4..R-9).
//
// Public and indexable: anonymous visitors search by specialty and
// municipality; a signed-in party opening it from a build gets
// `?near_project=` — distances from the build's point, through the project's
// own access rule (a build you are not on answers 404 and the search says so).
// The order, the facet counts and every "on the record" number are the API's
// (D-46); this page lays them out.
import type { Metadata } from 'next';

import { DirectoryFrame } from '@/components/directory/DirectoryFrame';
import { SearchForm } from '@/components/directory/SearchForm';
import { Facets } from '@/components/directory/Facets';
import { SearchResults } from '@/components/directory/SearchResults';
import { V2Error } from '@/lib/v2/client';
import { listSpecialties, searchCompanies } from '@/lib/v2/directory';
import { cleanParams, type V2DirectorySearch } from '@/lib/v2/directory-view';
import { sessionState } from '@/server/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Find construction companies · LinkNMS',
  description: 'Companies by specialty and place, with facts from the shared record of their builds — not reviews.',
};

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = cleanParams(await searchParams);
  const [state, taxonomy] = await Promise.all([sessionState(), listSpecialties()]);

  let result: V2DirectorySearch | null = null;
  let problem: string | null = null;
  try {
    result = await searchCompanies(params);
  } catch (err) {
    if (!(err instanceof V2Error)) throw err;
    problem = err.code === 'not_found'
      ? 'That build is not one you take part in — search by municipality instead.'
      : err.code === 'unauthenticated'
        ? 'Sign in to search near one of your builds.'
        : err.errors ? `Check the search: ${Object.entries(err.errors).map(([k, v]) => `${k} — ${v}`).join('; ')}` : err.message;
  }
  const nearLabel = result?.near?.source === 'project' ? result.near.label : undefined;

  return (
    <DirectoryFrame
      on="search"
      signedIn={state.kind !== 'anonymous'}
      context={nearLabel ? <span>Finding companies near <b>{nearLabel}</b></span> : undefined}
    >
      <section className="dhero">
        <h1>Who should do this work?</h1>
        <SearchForm params={params} taxonomy={taxonomy} nearLabel={nearLabel} />
      </section>
      <div className="dwrap">
        {result ? <Facets facets={result.facets} params={params} taxonomy={taxonomy} /> : <div />}
        {problem ? <p className="derr" role="alert">{problem}</p> : null}
        {result ? <SearchResults result={result} params={params} taxonomy={taxonomy} /> : null}
      </div>
    </DirectoryFrame>
  );
}
