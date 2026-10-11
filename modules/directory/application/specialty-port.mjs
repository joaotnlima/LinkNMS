// Published query port: the specialty taxonomy, for modules that store a
// taxonomy code (planning's task.specialty_code, PRD-03 R-2; the project
// invitation's trade, PRD-09 O-4) or match a label to it (the Excel import's
// Trade column, PRD-09 O-11). Injected at the composition root; callers never
// read directory.specialty themselves.

/** @param {{ listSpecialties: Function }} store directory store */
export function createSpecialtyPort(store) {
  return {
    /** true when `code` is a taxonomy code. */
    async exists(code) {
      if (typeof code !== 'string' || !code) return false;
      const all = await store.listSpecialties();
      return all.some((s) => s.code === code);
    },

    /** The whole taxonomy: [{code, name_en, name_pt, parent_code}]. */
    async list() {
      const all = await store.listSpecialties();
      return all.map((s) => ({ code: s.code, name_en: s.name_en, name_pt: s.name_pt, parent_code: s.parent_code ?? null }));
    },

    /** One code's labels, or null for an unknown code. */
    async describe(code) {
      if (typeof code !== 'string' || !code) return null;
      const hit = (await store.listSpecialties()).find((s) => s.code === code);
      return hit ? { code: hit.code, name_en: hit.name_en, name_pt: hit.name_pt } : null;
    },
  };
}
