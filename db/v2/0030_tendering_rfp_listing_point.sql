-- 0030 — Open requests near you, matched in SQL (PRD-04 X-10, D-47; audit S1).
--
-- Ownership: Tendering. "Open requests near you" used to take the first 500
-- listed RFPs and filter specialty + distance in memory, dropping matches past
-- the cut and offering no cursor. The match now runs in one statement over
-- data tendering owns:
--
--   rfp.specialty_codes          — already here (0023).
--   rfp.listing_lat / _lng /     — the build's point and municipality as the
--   rfp.listing_municipality_code  project's build port answered them when the
--                                  RFP was PUBLISHED (the moment it is listed;
--                                  a published RFP is never edited, only
--                                  amended). Denormalised so tendering never
--                                  reads project.* at query time.
--   tendering.distance_km()      — haversine, the same formula as
--                                  directory.distance_km (each schema owns its
--                                  copy; no cross-schema function call).
--
-- Back-fill: the published RFPs get their build's point from project.project
-- (read once, at migration time, as 0023 read planning.task).
--
-- No GRANTs (single application pool, see 0008_project_phases_signoff.sql).

ALTER TABLE tendering.rfp
  ADD COLUMN listing_lat               numeric(8,5),
  ADD COLUMN listing_lng               numeric(8,5),
  ADD COLUMN listing_municipality_code text,
  ADD CONSTRAINT rfp_listing_point_pair CHECK ((listing_lat IS NULL) = (listing_lng IS NULL));

CREATE FUNCTION tendering.distance_km(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
RETURNS double precision LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT 2 * 6371.0 * asin(least(1.0, sqrt(
           power(sin(radians((lat2 - lat1)::double precision) / 2), 2)
         + cos(radians(lat1::double precision)) * cos(radians(lat2::double precision))
           * power(sin(radians((lng2 - lng1)::double precision) / 2), 2))))
$$;

UPDATE tendering.rfp r
   SET listing_lat = p.location_lat, listing_lng = p.location_lng,
       listing_municipality_code = p.municipality_code
  FROM project.project p
 WHERE p.id = r.project_id AND r.status <> 'draft';

CREATE INDEX rfp_open_listing ON tendering.rfp (submission_deadline, id) WHERE listed AND status = 'published';
CREATE INDEX rfp_specialty_codes ON tendering.rfp USING gin (specialty_codes);
