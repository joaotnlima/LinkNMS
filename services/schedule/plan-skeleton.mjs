// The canonical names-only default plan skeleton (LINA-241; ADR-0018).
//
// This is the SINGLE source of truth on the BACKEND for the standard residential
// build shape. Migration 0008 seeds it into `schedule.plan_template` as the one
// `system` default, and the in-memory store (ports.mjs) seeds the identical body
// so the contract tests exercise the same resolve ladder the database serves.
//
// It is byte-identical to the FE constant `PLAN_SKELETON`
// (app/src/lib/plan-authoring.ts). The FE copy is demoted to an
// unreachable-endpoint fallback by the FE slice; an equality test there keeps the
// two from drifting until the FE constant is deleted (ADR-0018 §Consequences).
//
// Shape: `[{ name, tasks: [name, …] }]` — two levels, names only, no dates, no
// owners, no ids. A template carries NO audit weight: it is copied into a fresh
// editor draft, never linked to a project's stages (ADR-0018, ADR-0002).
export const SYSTEM_TEMPLATE_NAME = 'Standard residential build';

export const PLAN_SKELETON_BODY = Object.freeze([
  {
    name: '1 · Pre-Construction',
    tasks: [
      '1.1 Planning & Feasibility',
      '1.2 Design & Engineering',
      '1.3 Permitting & Approval',
      '1.4 Budget & Schedule',
    ],
  },
  {
    name: '2 · Construction (Execution)',
    tasks: [
      '2.1 Preliminary Works',
      '2.2 Substructure (Foundations)',
      '2.3 Superstructure (Frame)',
      '2.4 Masonry / Enclosure',
      '2.5 Roofing',
      '2.6 Plumbing',
      '2.7 Electrical',
      '2.8 Complementary Systems (HVAC)',
      '2.9 Interior Finishes',
      '2.10 Doors & Windows',
      '2.11 Painting',
      '2.12 Sanitary Ware',
    ],
  },
  {
    name: '3 · Post-Construction',
    tasks: [
      '3.1 Inspection & Handover',
      '3.2 Warranty & Maintenance',
    ],
  },
]);
