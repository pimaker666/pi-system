-- 0015: Add postal code recognition support
-- 1) Add structured address fields to customers
-- 2) Create postal_codes lookup table (GeoNames data)

-- Add city, state, postal_code to customers
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS state text,
  ADD COLUMN IF NOT EXISTS postal_code text;

-- Postal codes lookup table (GeoNames format)
CREATE TABLE IF NOT EXISTS postal_codes (
  id bigserial PRIMARY KEY,
  country_code char(2) NOT NULL,        -- ISO 3166-1 alpha-2
  postal_code text NOT NULL,
  place_name text NOT NULL,              -- city/town name
  state_name text,                       -- admin division 1 (state/province)
  state_code text,                       -- admin code 1
  county_name text,                      -- admin division 2 (county/district)
  latitude numeric(9,6),
  longitude numeric(9,6)
);

-- Indexes for fast lookup
CREATE INDEX IF NOT EXISTS idx_postal_codes_country_place
  ON postal_codes (country_code, lower(place_name) text_pattern_ops);

CREATE INDEX IF NOT EXISTS idx_postal_codes_country_postal
  ON postal_codes (country_code, postal_code);

CREATE INDEX IF NOT EXISTS idx_postal_codes_postal
  ON postal_codes (postal_code);

-- RLS: postal_codes is read-only public reference data
ALTER TABLE postal_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "postal_codes_read_all" ON postal_codes
  FOR SELECT USING (true);
