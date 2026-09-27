-- 0087: 客户品牌资料与 Logo 资产

begin;

alter table public.customers
  add column if not exists brand_name text,
  add column if not exists logo_url text;

alter table public.customers
  drop constraint if exists customers_brand_name_length;
alter table public.customers
  add constraint customers_brand_name_length
  check (brand_name is null or char_length(brand_name) <= 200);

alter table public.customers
  drop constraint if exists customers_logo_url_length;
alter table public.customers
  add constraint customers_logo_url_length
  check (logo_url is null or char_length(logo_url) <= 2000);

insert into storage.buckets (id, name, public)
values ('customer-assets', 'customer-assets', true)
on conflict (id) do nothing;

drop policy if exists "customer_assets_read" on storage.objects;
create policy "customer_assets_read" on storage.objects
  for select using (bucket_id = 'customer-assets');

drop policy if exists "customer_assets_write" on storage.objects;
create policy "customer_assets_write" on storage.objects
  for insert with check (bucket_id = 'customer-assets' and auth.role() = 'authenticated');

commit;
