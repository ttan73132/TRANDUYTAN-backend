-- The original inline column CHECK has this PostgreSQL-generated name.
-- Keep historical migration checksums unchanged; only widen the radius bound.
ALTER TABLE branches DROP CONSTRAINT IF EXISTS branches_radius_meters_check;
ALTER TABLE branches ADD CONSTRAINT branches_radius_meters_check CHECK (radius_meters BETWEEN 20 AND 200000);
