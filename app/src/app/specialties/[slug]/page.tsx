// /specialties/{slug} — a specialty landing (PRD-03 R-9, to-be/20 §3): the
// taxonomy entry (PT/EN), its work types, and the directory search already set
// to it. The slug is the taxonomy code. Public and indexable.
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { DirectoryFrame } from '@/components/directory/DirectoryFrame';
import { SearchForm } from '@/components/directory/SearchForm';
import { Facets } from '@/components/directory/Facets';
import { SearchResults } from '@/components/directory/SearchResults';
import { V2Error } from '@/lib/v2/client';
import { listSpecialties, searchCompanies } from '@/lib/v2/directory';
import { cleanParams, type V2DirectorySearch } from '@/lib/v2/directory-view';
import { sessionState } from '@/server/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const s = (await listSpecialties()).find((x) => x.code === slug);
  return s
    ? { title: `${s.name_en} — ${s.name_pt} · LinkNMS`, description: `Companies for ${s.name_en.toLowerCase()} (${s.name_pt.toLowerCase()}), with facts from the shared record of their builds.` }
    : { title: 'Specialty · LinkNMS' };
}

export default async function SpecialtyPage({
  params, searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ slug }, raw, state, taxonomy] = await Promise.all([params, searchParams, sessionState(), listSpecialties()]);
  const specialty = taxonomy.find((s) => s.code === slug);
  if (!specialty) notFound();
  const query = { ...cleanParams(raw), specialty: slug };
  const base = `/specialties/${slug}`;
  const parent = specialty.parent_code ? taxonomy.find((s) => s.code === specialty.parent_code) : null;
  const children = taxonomy.filter((s) => s.parent_code === slug);

  let result: V2DirectorySearch | null = null;
  try {
    result = await searchCompanies(query);
  } catch (err) {
    if (!(err instanceof V2Error)) throw err;
  }

  return (
    <DirectoryFrame on="search" signedIn={state.kind !== 'anonymous'}>
      <section className="dhero">
        {parent ? <Link href={`/specialties/${parent.code}`} className="cap">← {parent.name_en}</Link> : null}
        <h1>{specialty.name_en} <span className="cap" style={{ fontSize: 16 }}>· {specialty.name_pt}</span></h1>
        {children.length ? (
          <div className="chips">
            {children.map((c) => <Link key={c.code} className="spec" href={`/specialties/${c.code}`}>{c.name_en}</Link>)}
          </div>
        ) : null}
        <SearchForm params={query} taxonomy={taxonomy} action="/companies" />
      </section>
      <div className="dwrap">
        {result ? <Facets facets={result.facets} params={query} taxonomy={taxonomy} base={base} /> : <div />}
        {result ? <SearchResults result={result} params={query} taxonomy={taxonomy} base={base} /> : null}
      </div>
    </DirectoryFrame>
  );
}
