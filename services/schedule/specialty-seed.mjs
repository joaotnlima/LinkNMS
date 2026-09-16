// The canonical system specialty set (LINA-306 item 6).
//
// ONE source of truth for the seeded, everyone-sees-them trade labels. The SQL
// migration (0014_specialty_catalog.sql) seeds these same strings into
// schedule.specialty as `system` rows; the in-memory store seeds from this array
// directly; and specialty-seed.test.mjs guards that the migration file lists
// exactly these labels, so the two can never drift.
//
// Order here is presentation-agnostic — the service sorts by label on read — but
// it is kept roughly build-sequence so the migration reads sensibly.
export const SYSTEM_SPECIALTIES = [
  'General Contractor',
  'Site Preparation & Excavation',
  'Concrete & Foundations',
  'Framing & Carpentry',
  'Masonry',
  'Roofing',
  'Waterproofing & Insulation',
  'Windows & Doors',
  'Plumbing',
  'Electrical',
  'HVAC',
  'Drywall & Plastering',
  'Painting',
  'Flooring & Tiling',
  'Cabinetry & Millwork',
  'Landscaping',
  'Structural Engineering',
  'Architecture',
  'Surveying',
  'Inspection',
];
