// Published query port: the specialty taxonomy, for modules that store a
// taxonomy code (planning's task.specialty_code, PRD-03 R-2). Injected at the
// composition root; callers never read directory.specialty themselves.

/** @param {{ listSpecialties: Function }} store directory store */
export function createSpecialtyPort(store) {
  return {
    /** true when `code` is a taxonomy code. */
    async exists(code) {
      if (typeof code !== 'string' || !code) return false;
      const all = await store.listSpecialties();
      return all.some((s) => s.code === code);
    },
  };
}
