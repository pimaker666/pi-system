-- 0029_daily_order_cost_overrides.sql
-- 财务可按每日订单产品行覆盖产品库成本；未覆盖时页面实时使用产品库成本。

create table if not exists public.finance_daily_order_cost_overrides (
  daily_order_id uuid primary key references public.finance_daily_orders(id) on delete cascade,
  cost numeric(18, 4) not null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_daily_order_cost_override_valid check (cost >= 0)
);

comment on table public.finance_daily_order_cost_overrides is
  'Per-daily-order-line product cost override. Absence means use the current product_financials cost.';

create index if not exists idx_finance_daily_order_cost_overrides_updated_by
  on public.finance_daily_order_cost_overrides (updated_by);

create index if not exists idx_finance_daily_orders_shipped_costs
  on public.finance_daily_orders (status, shipping_date desc, created_at desc, id desc);

drop trigger if exists trg_finance_daily_order_cost_overrides_touch
  on public.finance_daily_order_cost_overrides;
create trigger trg_finance_daily_order_cost_overrides_touch
  before update on public.finance_daily_order_cost_overrides
  for each row execute function public.touch_updated_at();

alter table public.finance_daily_order_cost_overrides enable row level security;

revoke all on table public.finance_daily_order_cost_overrides
  from public, anon, authenticated, service_role;
grant select, insert, update, delete
  on table public.finance_daily_order_cost_overrides to authenticated, service_role;

drop policy if exists "daily_order_cost_overrides_select"
  on public.finance_daily_order_cost_overrides;
create policy "daily_order_cost_overrides_select"
  on public.finance_daily_order_cost_overrides
  for select to authenticated
  using (public.is_finance_or_admin());

drop policy if exists "daily_order_cost_overrides_insert"
  on public.finance_daily_order_cost_overrides;
create policy "daily_order_cost_overrides_insert"
  on public.finance_daily_order_cost_overrides
  for insert to authenticated
  with check (
    public.is_finance_or_admin()
    and updated_by = (select auth.uid())
    and exists (
      select 1
      from public.finance_daily_orders as orders
      where orders.id = daily_order_id
        and orders.status = 'active'
        and orders.shipping_date <= (now() at time zone 'Asia/Shanghai')::date
    )
  );

drop policy if exists "daily_order_cost_overrides_update"
  on public.finance_daily_order_cost_overrides;
create policy "daily_order_cost_overrides_update"
  on public.finance_daily_order_cost_overrides
  for update to authenticated
  using (public.is_finance_or_admin())
  with check (
    public.is_finance_or_admin()
    and updated_by = (select auth.uid())
    and exists (
      select 1
      from public.finance_daily_orders as orders
      where orders.id = daily_order_id
        and orders.status = 'active'
        and orders.shipping_date <= (now() at time zone 'Asia/Shanghai')::date
    )
  );

drop policy if exists "daily_order_cost_overrides_delete"
  on public.finance_daily_order_cost_overrides;
create policy "daily_order_cost_overrides_delete"
  on public.finance_daily_order_cost_overrides
  for delete to authenticated
  using (public.is_finance_or_admin());
