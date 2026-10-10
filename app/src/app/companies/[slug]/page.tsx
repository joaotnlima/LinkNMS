// /companies/{slug} — a company's public profile (PRD-03 D2, R-10..R-14, R-16).
//
// Header (claimed or not, base, radius, size, on LinkNMS since), the "On the
// record" block from the directory read model, then what the company STATES —
// labelled as such, and absent on an unclaimed profile, which offers the claim
// path instead. Public and indexable; unlisted profiles are a 404.
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { DirectoryFrame } from '@/components/directory/DirectoryFrame';
import { OnRecord } from '@/components/directory/OnRecord';
import { getCompanyBySlug, listSpecialties } from '@/lib/v2/directory';
import { TEAM_SIZE_LABEL, formatDay, specialtyLabel } from '@/lib/v2/directory-view';
import { sessionState } from '@/server/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const p = await getCompanyBySlug(slug);
  return p
    ? { title: `${p.display_name} · LinkNMS`, description: `${p.display_name} — builds on LinkNMS and facts from the shared record.` }
    : { title: 'Company · LinkNMS' };
}

export default async function CompanyProfilePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [profile, taxonomy, state] = await Promise.all([getCompanyBySlug(slug), listSpecialties(), sessionState()]);
  if (!profile) notFound();
  const where = [
    profile.base_municipality_code ? `Municipality ${profile.base_municipality_code}` : null,
    profile.service_radius_km != null ? `serves up to ${profile.service_radius_km} km` : null,
    profile.team_size_band ? TEAM_SIZE_LABEL[profile.team_size_band] : null,
    `on LinkNMS since ${formatDay(profile.on_linknms_since)}`,
  ].filter(Boolean).join(' · ');

  return (
    <DirectoryFrame on="search" signedIn={state.kind !== 'anonymous'}>
      <div className="dprof">
        <Link href="/companies" style={{ fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>← Find companies</Link>
        <div className="dprof-grid">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="row" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <h1>{profile.display_name}</h1>
                {profile.claimed
                  ? <span className="badge ok">Profile claimed</span>
                  : <span className="badge neutral">Unclaimed profile</span>}
              </div>
              <p className="where" style={{ fontSize: 14 }}>{where}</p>
              {profile.specialties.length ? (
                <div className="chips">
                  {profile.specialties.map((c) => (
                    <Link key={c} className="spec" href={`/specialties/${c}`}>{specialtyLabel(c, taxonomy)}</Link>
                  ))}
                </div>
              ) : null}
            </div>

            <OnRecord record={profile.record} builds={profile.builds} />

            {profile.claimed ? (
              <>
                {profile.description ? (
                  <section className="sec2" aria-labelledby="about">
                    <h2 id="about">About</h2>
                    <p style={{ maxWidth: '70ch', whiteSpace: 'pre-line' }}>{profile.description}</p>
                    <span className="pv"><i className="sta">Stated</i><span className="cap">Written by the company</span></span>
                  </section>
                ) : null}
                <section className="sec2" aria-labelledby="licences">
                  <h2 id="licences">Licences &amp; insurance</h2>
                  <div className="proof" style={{ fontSize: 13.5 }}>
                    <span className="pv"><i className="sta">Stated</i>
                      {profile.stated?.licence_number_given
                        ? `Alvará IMPIC number given${profile.stated.impic_class ? `, class ${profile.stated.impic_class}` : ''} · not checked by LinkNMS`
                        : 'No alvará number given'}
                    </span>
                    <span className="pv"><i className="sta">Stated</i>
                      {profile.stated?.insurance_given ? 'Insurance stated by the company · not checked by LinkNMS' : 'No insurance stated'}
                    </span>
                  </div>
                </section>
                {profile.portfolio.length ? (
                  <section className="sec2" aria-labelledby="portfolio">
                    <h2 id="portfolio">Portfolio</h2>
                    <div className="card">
                      {profile.portfolio.map((e) => (
                        <div key={e.id} className="lrow">
                          <div className="l1"><span>{e.title}</span>
                            <span className="pv"><i className={e.source === 'platform' ? 'rec' : 'sta'}>{e.source === 'platform' ? 'On the record' : 'Stated'}</i></span>
                          </div>
                          <div className="l2">
                            {[e.typology, e.municipality_code ? `municipality ${e.municipality_code}` : null,
                              e.end_date ? `finished ${formatDay(e.end_date)}` : null].filter(Boolean).join(' · ')}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                ) : null}
              </>
            ) : (
              <section className="sec2" aria-labelledby="claim">
                <h2 id="claim">Is this your company?</h2>
                <p className="cap" style={{ fontSize: 13 }}>
                  This profile shows only what the shared record knows. Claim it to add your specialties, service area,
                  availability and the rest — we send a link to the e-mail the profile was created from.
                </p>
                <p><Link className="btn primary" href={`/companies/${profile.slug}/claim`}>Claim this profile</Link></p>
              </section>
            )}
          </div>

          <aside className="card dside" aria-label="At a glance">
            <b style={{ fontSize: 15 }}>At a glance</b>
            {profile.stated?.available_from ? (
              <span className="kv"><span className="cap">Can start from</span><b>{formatDay(profile.stated.available_from)}</b></span>
            ) : null}
            {profile.service_areas?.length ? (
              <span className="kv"><span className="cap">Service areas (INE)</span><b>{profile.service_areas.join(', ')}</b></span>
            ) : null}
            {profile.founded_year ? <span className="kv"><span className="cap">Founded</span><b>{profile.founded_year}</b></span> : null}
            <span className="kv"><span className="cap">Builds on LinkNMS</span><b>{profile.record.builds}</b></span>
            <span className="pv"><i className="sta">Stated</i><span className="cap">Everything here but the builds is the company&rsquo;s own</span></span>
          </aside>
        </div>
      </div>
    </DirectoryFrame>
  );
}
