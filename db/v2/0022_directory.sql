-- 0022 — Company directory (PRD-03 R-1..R-20, D-46).
--
-- Ownership: Directory. Nothing here references another schema: the
-- directory learns about contracts, tasks, change orders and proposals ONLY
-- through domain events (to-be/10 §Directory read model) and keeps them in its
-- own record_* tables; the build's point comes from the project module's
-- build port. Amounts are never stored here.
--
--   specialty            — two-level PT/EN taxonomy; code = public slug.
--                          impic_ref is reference metadata, UNVERIFIED.
--   organization_profile — gains slug, claim state, base point + radius,
--                          availability, kind, version (If-Match).
--   profile_claim        — single-use claim links mailed to an unclaimed
--                          profile's e-mail (stored hashed).
--   portfolio_consent    — the owner's consent to show a build's name on its
--                          companies' profiles (R-12).
--   record_contract / record_task / record_change_order / record_proposal
--                        — the "On the record" read model (R-11, D-46).
--   consumed_event       — consumer dedupe on event_id (at-least-once outbox).
--   listing_stat         — daily search impressions and profile views (R-17).
--   distance_km()        — haversine in SQL; no earthdistance/PostGIS needed.
--
-- No GRANTs (single application pool, see 0008_project_phases_signoff.sql).

-- 1. Taxonomy ───────────────────────────────────────────────────────────────
ALTER TABLE directory.specialty
  ADD COLUMN position   smallint NOT NULL DEFAULT 0,
  ADD COLUMN impic_ref  text,
  ADD CONSTRAINT specialty_code_shape CHECK (code ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(code) <= 60);

-- impic_ref: the IMPIC alvará category / sub-category (Portaria 19/2004) the
-- specialty lines up with, written from memory of that classification and NOT
-- checked against the current official list (PRD-03 §7 item 3). Reference
-- only — never proof, never shown as "Checked" (D-46).
INSERT INTO directory.specialty (code, name_pt, name_en, parent_code, position, impic_ref) VALUES
  ('structure',              'Estrutura',                                   'Structure',                     NULL,           100, '1.ª cat.'),
  ('structure-concrete',     'Estruturas de betão',                         'Concrete structures',           'structure',    101, '1.ª cat. / 1.ª subcat.'),
  ('structure-steel',        'Estruturas metálicas',                        'Steel structures',              'structure',    102, '1.ª cat. / 2.ª subcat.'),
  ('structure-timber',       'Estruturas de madeira',                       'Timber structures',             'structure',    103, '1.ª cat. / 3.ª subcat.'),
  ('structure-foundations',  'Fundações',                                   'Foundations',                   'structure',    104, '5.ª cat. / 4.ª subcat.'),
  ('groundworks',            'Demolições e movimentação de terras',         'Demolition & groundworks',      NULL,           200, '5.ª cat.'),
  ('groundworks-demolition', 'Demolições',                                  'Demolition',                    'groundworks',  201, '5.ª cat. / 1.ª subcat.'),
  ('groundworks-earthworks', 'Movimentação de terras',                      'Earthworks & excavation',       'groundworks',  202, '5.ª cat. / 2.ª subcat.'),
  ('masonry',                'Alvenarias e rebocos',                        'Masonry & render',              NULL,           300, '1.ª cat. / 4.ª subcat.'),
  ('masonry-walls',          'Alvenarias',                                  'Masonry walls',                 'masonry',      301, '1.ª cat. / 4.ª subcat.'),
  ('masonry-render',         'Rebocos',                                     'Render & plaster',              'masonry',      302, '1.ª cat. / 4.ª subcat.'),
  ('masonry-stone',          'Cantarias e pedra',                           'Stonework',                     'masonry',      303, '1.ª cat. / 4.ª subcat.'),
  ('roofing',                'Coberturas',                                  'Roofing',                       NULL,           400, '1.ª cat.'),
  ('roofing-tiled',          'Coberturas em telha',                         'Tiled roofs',                   'roofing',      401, NULL),
  ('roofing-flat',           'Coberturas planas e impermeabilização',       'Flat roofs & waterproofing',    'roofing',      402, NULL),
  ('roofing-skylights',      'Claraboias',                                  'Skylights',                     'roofing',      403, NULL),
  ('roofing-gutters',        'Caleiras e algerozes',                        'Gutters',                       'roofing',      404, NULL),
  ('insulation',             'Impermeabilização e isolamento',              'Waterproofing & insulation',    NULL,           500, '5.ª cat.'),
  ('insulation-waterproofing','Impermeabilizações',                         'Waterproofing',                 'insulation',   501, NULL),
  ('insulation-etics',       'Isolamento térmico (ETICS / capoto)',         'Thermal insulation (ETICS)',    'insulation',   502, NULL),
  ('insulation-acoustic',    'Isolamento acústico',                         'Acoustic insulation',           'insulation',   503, NULL),
  ('plumbing',               'Canalização e drenagem',                      'Plumbing & drainage',           NULL,           600, '1.ª cat. / 8.ª subcat.'),
  ('plumbing-water',         'Redes de águas',                              'Water supply',                  'plumbing',     601, '1.ª cat. / 8.ª subcat.'),
  ('plumbing-drainage',      'Redes de esgotos e pluviais',                 'Drainage',                      'plumbing',     602, '1.ª cat. / 8.ª subcat.'),
  ('plumbing-gas',           'Redes de gás',                                'Gas installations',             'plumbing',     603, '4.ª cat.'),
  ('electrical',             'Instalações elétricas',                       'Electrical',                    NULL,           700, '4.ª cat.'),
  ('electrical-low-voltage', 'Instalações elétricas de baixa tensão',       'Low-voltage wiring',            'electrical',   701, '4.ª cat. / 1.ª subcat.'),
  ('electrical-telecom',     'Telecomunicações (ITED)',                     'Telecoms (ITED)',               'electrical',   702, '4.ª cat.'),
  ('electrical-solar',       'Fotovoltaico',                                'Solar PV',                      'electrical',   703, '4.ª cat.'),
  ('hvac',                   'AVAC',                                        'HVAC',                          NULL,           800, '4.ª cat.'),
  ('hvac-heating',           'Aquecimento',                                 'Heating',                       'hvac',         801, NULL),
  ('hvac-cooling',           'Ar condicionado',                             'Air conditioning',              'hvac',         802, NULL),
  ('hvac-ventilation',       'Ventilação',                                  'Ventilation',                   'hvac',         803, NULL),
  ('hvac-heat-pumps',        'Bombas de calor e águas quentes',             'Heat pumps & hot water',        'hvac',         804, NULL),
  ('carpentry',              'Carpintarias',                                'Carpentry & joinery',           NULL,           900, '1.ª cat. / 6.ª subcat.'),
  ('carpentry-doors',        'Portas',                                      'Doors',                         'carpentry',    901, '1.ª cat. / 6.ª subcat.'),
  ('carpentry-built-in',     'Roupeiros e mobiliário fixo',                 'Built-in joinery',              'carpentry',    902, '1.ª cat. / 6.ª subcat.'),
  ('carpentry-floors',       'Pavimentos de madeira',                       'Wood floors',                   'carpentry',    903, '1.ª cat. / 6.ª subcat.'),
  ('carpentry-kitchens',     'Cozinhas',                                    'Kitchens',                      'carpentry',    904, NULL),
  ('windows',                'Caixilharia',                                 'Windows & glazing',             NULL,          1000, '1.ª cat. / 7.ª subcat.'),
  ('windows-aluminium',      'Caixilharia de alumínio',                     'Aluminium windows',             'windows',     1001, '1.ª cat. / 7.ª subcat.'),
  ('windows-pvc',            'Caixilharia em PVC',                          'PVC windows',                   'windows',     1002, '1.ª cat. / 7.ª subcat.'),
  ('windows-glazing',        'Vidros',                                      'Glazing',                       'windows',     1003, NULL),
  ('windows-shutters',       'Estores e portadas',                          'Shutters & blinds',             'windows',     1004, NULL),
  ('finishes',               'Revestimentos e acabamentos',                 'Finishes',                      NULL,          1100, '1.ª cat. / 5.ª subcat.'),
  ('finishes-tiling',        'Cerâmicos e azulejos',                        'Tiling',                        'finishes',    1101, '1.ª cat. / 5.ª subcat.'),
  ('finishes-painting',      'Pinturas',                                    'Painting',                      'finishes',    1102, '1.ª cat. / 5.ª subcat.'),
  ('finishes-drywall',       'Gesso cartonado e tetos falsos',              'Drywall & ceilings',            'finishes',    1103, '1.ª cat. / 5.ª subcat.'),
  ('finishes-flooring',      'Pavimentos',                                  'Flooring',                      'finishes',    1104, '1.ª cat. / 5.ª subcat.'),
  ('metalwork',              'Serralharia',                                 'Metalwork',                     NULL,          1200, '1.ª cat. / 7.ª subcat.'),
  ('metalwork-railings',     'Guardas e corrimãos',                         'Railings',                      'metalwork',   1201, NULL),
  ('metalwork-gates',        'Portões e gradeamentos',                      'Gates & grilles',               'metalwork',   1202, NULL),
  ('exterior',               'Arranjos exteriores',                         'Outdoor works',                 NULL,          1300, '5.ª cat.'),
  ('exterior-landscaping',   'Jardins',                                     'Landscaping',                   'exterior',    1301, NULL),
  ('exterior-paving',        'Pavimentos exteriores',                       'Paving',                        'exterior',    1302, NULL),
  ('exterior-pools',         'Piscinas',                                    'Pools',                         'exterior',    1303, NULL),
  ('restoration',            'Reabilitação e restauro',                     'Renovation & restoration',      NULL,          1400, '1.ª cat. / 10.ª subcat.'),
  ('restoration-heritage',   'Restauro de património',                      'Heritage restoration',          'restoration', 1401, '1.ª cat. / 10.ª subcat.'),
  ('restoration-facades',    'Reabilitação de fachadas',                    'Façade renovation',             'restoration', 1402, NULL),
  ('design',                 'Projeto e fiscalização',                      'Design & supervision',          NULL,          1500, NULL),
  ('design-architecture',    'Arquitetura',                                 'Architecture',                  'design',      1501, NULL),
  ('design-structural',      'Engenharia de estruturas',                    'Structural engineering',        'design',      1502, NULL),
  ('design-mep',             'Projetos de especialidades',                  'MEP engineering',               'design',      1503, NULL),
  ('design-supervision',     'Fiscalização e coordenação de segurança',     'Site supervision & safety',     'design',      1504, NULL);

-- 2. Profiles ───────────────────────────────────────────────────────────────
-- The table had no write path before PRD-03, so any row is a hand-made one:
-- give it a slug from its id before the column becomes NOT NULL.
ALTER TABLE directory.organization_profile
  ADD COLUMN slug              text,
  ADD COLUMN kind              text CHECK (kind IN ('contractor', 'consultant', 'supplier')),
  ADD COLUMN claimed           boolean NOT NULL DEFAULT true,
  ADD COLUMN contact_email     text CHECK (contact_email = lower(contact_email)),
  ADD COLUMN base_municipality_code text CHECK (base_municipality_code ~ '^\d{4}$'),
  ADD COLUMN base_lat          numeric(8,5),
  ADD COLUMN base_lng          numeric(8,5),
  ADD COLUMN service_radius_km smallint CHECK (service_radius_km BETWEEN 1 AND 300),
  ADD COLUMN available_from    date,
  ADD COLUMN created_at        timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN version           int NOT NULL DEFAULT 1;

UPDATE directory.organization_profile SET slug = 'company-' || left(replace(org_id::text, '-', ''), 12) WHERE slug IS NULL;

ALTER TABLE directory.organization_profile
  ALTER COLUMN slug SET NOT NULL,
  ADD CONSTRAINT organization_profile_slug_shape CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 64),
  ADD CONSTRAINT organization_profile_slug_unique UNIQUE (slug),
  -- an unclaimed profile is only claimable through its e-mail (R-16)
  ADD CONSTRAINT organization_profile_claim_channel CHECK (claimed OR contact_email IS NOT NULL),
  ADD CONSTRAINT organization_profile_base_pair CHECK ((base_lat IS NULL) = (base_lng IS NULL)),
  ADD CONSTRAINT organization_profile_base_range
    CHECK (base_lat IS NULL OR (base_lat BETWEEN -90 AND 90 AND base_lng BETWEEN -180 AND 180));

CREATE INDEX organization_profile_specialties ON directory.organization_profile USING gin (specialties) WHERE listed;
CREATE INDEX organization_profile_contact_email ON directory.organization_profile (contact_email) WHERE NOT claimed;

ALTER TABLE directory.portfolio_entry
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT portfolio_entry_title_len CHECK (char_length(title) BETWEEN 1 AND 160);
CREATE INDEX portfolio_entry_org ON directory.portfolio_entry (org_id);

-- 3. Claim links ────────────────────────────────────────────────────────────
CREATE TABLE directory.profile_claim (
  id                  uuid PRIMARY KEY,
  profile_org_id      uuid NOT NULL REFERENCES directory.organization_profile(org_id) ON UPDATE CASCADE,
  claimant_org_id     uuid NOT NULL,
  claimant_person_id  uuid NOT NULL,
  token_hash          text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  sent_to             text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  accepted_at         timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX profile_claim_profile ON directory.profile_claim (profile_org_id);

-- 4. Owner consent to show a build's name (R-12) ───────────────────────────
CREATE TABLE directory.portfolio_consent (
  project_id           uuid PRIMARY KEY,
  owner_org_id         uuid NOT NULL,
  show_on_profiles     boolean NOT NULL,
  build_name           text CHECK (char_length(build_name) <= 200),
  note                 text CHECK (char_length(note) <= 500),
  decided_by_person_id uuid NOT NULL,
  decided_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT show_on_profiles OR build_name IS NOT NULL)
);

-- 5. "On the record" read model (R-11, D-46) — event-fed, never joined to
--    another module's tables. No amounts.
CREATE TABLE directory.record_contract (
  contract_id     uuid PRIMARY KEY,
  project_id      uuid NOT NULL,
  kind            text NOT NULL,
  client_org_id   uuid NOT NULL,
  supplier_org_id uuid NOT NULL,
  status          text NOT NULL CHECK (status IN ('signed', 'active', 'provisionally_received', 'closed', 'terminated')),
  signed_at       timestamptz NOT NULL,
  finished_at     timestamptz
);
CREATE INDEX record_contract_supplier ON directory.record_contract (supplier_org_id);

CREATE TABLE directory.record_task (
  task_id         uuid PRIMARY KEY,
  project_id      uuid NOT NULL,
  contract_id     uuid,
  assignee_org_id uuid NOT NULL,
  baseline_finish date,
  actual_finish   date,
  reported_at     timestamptz NOT NULL
);
CREATE INDEX record_task_assignee ON directory.record_task (assignee_org_id);

CREATE TABLE directory.record_change_order (
  change_order_id uuid PRIMARY KEY,
  contract_id     uuid NOT NULL,
  status          text NOT NULL CHECK (status IN ('submitted', 'approved', 'rejected', 'withdrawn')),
  updated_at      timestamptz NOT NULL
);
CREATE INDEX record_change_order_contract ON directory.record_change_order (contract_id);

CREATE TABLE directory.record_proposal (
  proposal_id   uuid PRIMARY KEY,
  rfp_id        uuid NOT NULL,
  bidder_org_id uuid,
  submitted_at  timestamptz,
  awarded_at    timestamptz
);
CREATE INDEX record_proposal_bidder ON directory.record_proposal (bidder_org_id);

CREATE TABLE directory.consumed_event (
  event_id    uuid PRIMARY KEY,
  type        text NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now()
);

-- 6. Listing stats (R-17) ─────────────────────────────────────────────────
CREATE TABLE directory.listing_stat (
  org_id uuid NOT NULL,
  day    date NOT NULL,
  kind   text NOT NULL CHECK (kind IN ('search_impression', 'profile_view')),
  count  int  NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (org_id, day, kind)
);

-- 7. Great-circle distance in km (haversine, mean Earth radius 6371 km).
--    Good to well under 1 % at PT distances; no extension needed.
CREATE FUNCTION directory.distance_km(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
RETURNS double precision LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT 2 * 6371.0 * asin(least(1.0, sqrt(
           power(sin(radians((lat2 - lat1)::double precision) / 2), 2)
         + cos(radians(lat1::double precision)) * cos(radians(lat2::double precision))
           * power(sin(radians((lng2 - lng1)::double precision) / 2), 2))))
$$;
