// Published query port: a directory company as other modules may use it
// (PRD-04). Tendering adds a company to an RFP, shows the proof lines of the
// companies asking to bid and matches open requests to a company — without
// reading directory.* itself. Injected at the composition root.
//
//   contactOf(companyId)  — who to invite for a LISTED profile: a claimed
//                           profile is its organisation; an unclaimed one is
//                           invited at its e-mail (the only place that address
//                           leaves the directory, and only to tendering).
//   proofsOf(orgIds, {near}) — CompanyProof: name, slug, claim state and the
//                           "On the record" counts (D-46); distance from
//                           `near` when both points are known.
//   biddingProfileOf(orgId) — what open requests are matched on: the specialty
//                           family (each code, its parent and its children),
//                           base point, service radius and areas.
import { onRecord } from '../domain/ranking.mjs';

/** @param {{ getProfileByOrg: Function, profilesByOrgIds: Function, listSpecialties: Function }} store */
export function createCompanyPort(store) {
  return {
    async contactOf(companyId) {
      const p = await store.getProfileByOrg(companyId);
      if (!p || !p.listed) return null;
      return {
        org_id: p.org_id,
        claimed: Boolean(p.claimed),
        display_name: p.display_name,
        ...(p.claimed ? {} : { email: p.contact_email }),
      };
    },

    async proofsOf(orgIds, { near = null } = {}) {
      const rows = await store.profilesByOrgIds([...new Set(orgIds)], near);
      return rows.map((r) => {
        const rec = onRecord(r);
        return {
          org_id: r.org_id,
          display_name: r.display_name,
          slug: r.slug,
          claimed: Boolean(r.claimed),
          verified_clients: rec.verified_clients,
          builds: rec.builds,
          tasks_finished: rec.tasks_finished,
          tasks_on_time: rec.tasks_on_time,
          ...(r.distance_km != null ? { distance_km: Math.round(Number(r.distance_km) * 10) / 10 } : {}),
        };
      });
    },

    async biddingProfileOf(orgId) {
      const p = await store.getProfileByOrg(orgId);
      if (!p) return null;
      const taxonomy = await store.listSpecialties();
      const family = new Set();
      for (const code of p.specialties ?? []) {
        const node = taxonomy.find((s) => s.code === code);
        if (!node) continue;
        family.add(code);
        if (node.parent_code) family.add(node.parent_code);
        for (const s of taxonomy) if (s.parent_code === code) family.add(s.code);
      }
      return {
        listed: Boolean(p.listed),
        specialty_family: [...family].sort(),
        base: p.base_lat != null ? { lat: Number(p.base_lat), lng: Number(p.base_lng) } : null,
        radius_km: p.service_radius_km == null ? null : Number(p.service_radius_km),
        service_areas: p.service_areas ?? [],
      };
    },
  };
}
