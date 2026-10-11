// The company's profile editor (PRD-03 R-20): description, specialties, base
// and radius, service areas, size, availability and the STATED credentials.
// A server-rendered form posting to a server action; the API validates
// (taxonomy codes, ranges, both-or-neither) and answers 422 with field errors.
import {
  TEAM_SIZE_LABEL, specialtyGroups, type TeamSizeBand, type V2OrganizationProfile, type V2Specialty,
} from '@/lib/v2/directory-view';

const BANDS = Object.keys(TEAM_SIZE_LABEL) as TeamSizeBand[];

export function ProfileEditor({
  orgId, profile, taxonomy, defaultName, action,
}: {
  orgId: string;
  profile: V2OrganizationProfile | null;
  taxonomy: readonly V2Specialty[];
  /** The organisation's legal name — the first save's suggested display name. */
  defaultName: string;
  action: (fd: FormData) => Promise<void>;
}) {
  const p = profile;
  const chosen = new Set(p?.specialties ?? []);
  return (
    <form action={action} className="dform" aria-label="Company profile">
      <input type="hidden" name="org_id" value={orgId} />
      {p ? <input type="hidden" name="version" value={String(p.version)} /> : null}
      <label className="wide">Name shown in the directory
        <input name="display_name" required maxLength={120} defaultValue={p?.display_name ?? defaultName} />
      </label>
      <label className="wide">About the company (stated)
        <textarea name="description" rows={4} maxLength={2000} defaultValue={p?.description ?? ''} />
      </label>
      <label className="wide">Specialties — the work types you do (hold Ctrl / ⌘ to pick several)
        <select name="specialties" multiple defaultValue={[...chosen]}>
          {specialtyGroups(taxonomy).map(({ parent, children }) => (
            <optgroup key={parent.code} label={`${parent.name_en} · ${parent.name_pt}`}>
              <option value={parent.code}>{parent.name_en} — all of it</option>
              {children.map((c) => <option key={c.code} value={c.code}>{c.name_en} · {c.name_pt}</option>)}
            </optgroup>
          ))}
        </select>
      </label>
      <label>Base municipality (INE code)
        <input name="base_municipality_code" inputMode="numeric" maxLength={4} placeholder="1111" defaultValue={p?.base.municipality_code ?? ''} />
      </label>
      <label>Base latitude
        <input name="base_lat" inputMode="decimal" placeholder="38.7907" defaultValue={p?.base.lat ?? ''} />
      </label>
      <label>Base longitude
        <input name="base_lng" inputMode="decimal" placeholder="-9.3383" defaultValue={p?.base.lng ?? ''} />
      </label>
      <label>Service radius (km)
        <input name="service_radius_km" type="number" min={1} max={300} defaultValue={p?.service_radius_km ?? ''} />
      </label>
      <label className="wide">Service areas — INE district (2 digits) or municipality (4 digits) codes, comma-separated
        <input name="service_areas" defaultValue={(p?.service_areas ?? []).join(', ')} placeholder="11, 1503" />
      </label>
      <label>Company size
        <select name="team_size_band" defaultValue={p?.team_size_band ?? ''}>
          <option value="">Not stated</option>
          {BANDS.map((b) => <option key={b} value={b}>{TEAM_SIZE_LABEL[b]}</option>)}
        </select>
      </label>
      <label>Founded (year)
        <input name="founded_year" type="number" min={1800} max={2100} defaultValue={p?.founded_year ?? ''} />
      </label>
      <label>Can start new work from
        <input name="available_from" type="date" defaultValue={p?.available_from ?? ''} />
      </label>
      <label>Tags (comma-separated)
        <input name="tags" defaultValue={(p?.tags ?? []).join(', ')} />
      </label>
      <label>NIF (stated)
        <input name="declared_nif" maxLength={20} defaultValue={p?.declared.nif ?? ''} />
      </label>
      <label>Alvará IMPIC number (stated)
        <input name="declared_impic_number" maxLength={40} defaultValue={p?.declared.impic_number ?? ''} />
      </label>
      <label>Alvará class (stated)
        <input name="declared_impic_class" maxLength={20} defaultValue={p?.declared.impic_class ?? ''} />
      </label>
      <label>Insurance (stated)
        <input name="declared_insurance" maxLength={200} defaultValue={p?.declared.insurance ?? ''} />
      </label>
      <label className="check wide">
        <input type="checkbox" name="listed" defaultChecked={p ? p.listed : true} />
        Show my company in the directory
      </label>
      <p className="cap wide">
        Licences and insurance are shown as the company states them — LinkNMS does not check them. Nothing you fill
        in here changes your position in search results: that comes only from clients who signed a contract with you
        on LinkNMS.
      </p>
      <div className="wide"><button type="submit" className="btn primary">{p ? 'Save profile' : 'Create profile'}</button></div>
    </form>
  );
}
