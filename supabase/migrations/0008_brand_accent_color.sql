-- 0008_brand_accent_color.sql
-- Adds a per-company brand accent color so the generated PI (PDF / preview /
-- Excel) can build its whole palette around the company's logo color.
-- The value is a #RRGGBB hex string; NULL falls back to the app default.

alter table public.company_settings
  add column if not exists accent_color text;

alter table public.company_profiles
  add column if not exists accent_color text;

-- Existing PIs keep their captured company_snapshot (jsonb); new PIs will
-- include accent_color automatically via the snapshot written on creation.
