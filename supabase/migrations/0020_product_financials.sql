-- Store finance-only product fields separately so sales users cannot read them
-- through the broadly readable public.products table.

create table if not exists public.product_financials (
  product_id       uuid primary key references public.products(id) on delete cascade,
  financial_number text,
  product_name      text,
  cost              numeric(18, 4),
  updated_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint product_financials_number_valid check (
    financial_number is null
    or (
      financial_number = btrim(financial_number)
      and char_length(financial_number) between 1 and 100
    )
  ),
  constraint product_financials_name_valid check (
    product_name is null
    or (
      product_name = btrim(product_name)
      and char_length(product_name) between 1 and 200
    )
  ),
  constraint product_financials_cost_valid check (cost is null or cost >= 0)
);

comment on table public.product_financials is
  'Finance-only product number, product name and cost; hidden from sales users by RLS.';

create unique index if not exists idx_product_financials_number_unique
  on public.product_financials (financial_number)
  where financial_number is not null;

create index if not exists idx_product_financials_updated_by
  on public.product_financials (updated_by);

drop trigger if exists trg_product_financials_touch on public.product_financials;
create trigger trg_product_financials_touch
  before update on public.product_financials
  for each row execute function public.touch_updated_at();

alter table public.product_financials enable row level security;

revoke all on table public.product_financials from public, anon, authenticated;
grant select, insert, update on table public.product_financials to authenticated;

drop policy if exists "product_financials_select" on public.product_financials;
create policy "product_financials_select" on public.product_financials
  for select to authenticated
  using (public.is_finance_or_admin());

drop policy if exists "product_financials_insert" on public.product_financials;
create policy "product_financials_insert" on public.product_financials
  for insert to authenticated
  with check (public.is_finance_or_admin());

drop policy if exists "product_financials_update" on public.product_financials;
create policy "product_financials_update" on public.product_financials
  for update to authenticated
  using (public.is_finance_or_admin())
  with check (public.is_finance_or_admin());
