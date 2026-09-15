-- 0046 业务订单明细行成本覆盖
-- 订单成本页从旧 finance_daily_orders 迁移到 business_orders 台账结构后，
-- 按业务订单产品明细行覆盖产品库成本。

begin;

-- -----------------------------------------------------------------------------
-- 1. 业务订单明细行成本覆盖表
-- -----------------------------------------------------------------------------
create table if not exists public.finance_business_order_item_cost_overrides (
  business_order_item_id uuid primary key references public.business_order_items(id) on delete cascade,
  cost numeric(18, 4) not null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_business_order_item_cost_override_valid check (cost >= 0)
);

comment on table public.finance_business_order_item_cost_overrides is
  'Per-business-order-item product cost override. Absence means use the current product_financials cost.';

create index if not exists idx_finance_business_order_item_cost_overrides_updated_by
  on public.finance_business_order_item_cost_overrides (updated_by);

drop trigger if exists trg_finance_business_order_item_cost_overrides_touch
  on public.finance_business_order_item_cost_overrides;
create trigger trg_finance_business_order_item_cost_overrides_touch
  before update on public.finance_business_order_item_cost_overrides
  for each row execute function public.touch_updated_at();

alter table public.finance_business_order_item_cost_overrides enable row level security;

revoke all on table public.finance_business_order_item_cost_overrides
  from public, anon, authenticated, service_role;
grant select, insert, update, delete
  on table public.finance_business_order_item_cost_overrides to authenticated, service_role;

drop policy if exists "business_order_item_cost_overrides_select"
  on public.finance_business_order_item_cost_overrides;
create policy "business_order_item_cost_overrides_select"
  on public.finance_business_order_item_cost_overrides
  for select to authenticated
  using (public.is_finance_or_admin());

drop policy if exists "business_order_item_cost_overrides_insert"
  on public.finance_business_order_item_cost_overrides;
create policy "business_order_item_cost_overrides_insert"
  on public.finance_business_order_item_cost_overrides
  for insert to authenticated
  with check (
    public.is_finance_or_admin()
    and updated_by = (select auth.uid())
    and exists (
      select 1
      from public.business_order_items as items
      join public.business_orders as orders on orders.id = items.order_id
      where items.id = business_order_item_id
        and orders.fulfillment_status = 'fully_shipped'
        and orders.status in ('approved', 'completed')
    )
  );

drop policy if exists "business_order_item_cost_overrides_update"
  on public.finance_business_order_item_cost_overrides;
create policy "business_order_item_cost_overrides_update"
  on public.finance_business_order_item_cost_overrides
  for update to authenticated
  using (public.is_finance_or_admin())
  with check (
    public.is_finance_or_admin()
    and updated_by = (select auth.uid())
    and exists (
      select 1
      from public.business_order_items as items
      join public.business_orders as orders on orders.id = items.order_id
      where items.id = business_order_item_id
        and orders.fulfillment_status = 'fully_shipped'
        and orders.status in ('approved', 'completed')
    )
  );

drop policy if exists "business_order_item_cost_overrides_delete"
  on public.finance_business_order_item_cost_overrides;
create policy "business_order_item_cost_overrides_delete"
  on public.finance_business_order_item_cost_overrides
  for delete to authenticated
  using (public.is_finance_or_admin());

commit;
