-- 0055 业务订单明细行结算归档
-- 财务在“订单成本”页对已全部发货且已收齐尾款的产品行结算，选择归属年月后
-- 该行离开成本页、进入“已结算订单”。结算按明细行粒度，同一订单可部分结算。
-- 结算时归档单位成本与已发货数量，避免后续产品库/成本覆盖改动影响历史结算。

begin;

create table if not exists public.finance_business_order_item_settlements (
  business_order_item_id uuid primary key references public.business_order_items(id) on delete cascade,
  period date not null,
  unit_cost numeric(18, 4),
  quantity numeric(18, 4) not null,
  settled_by uuid references public.profiles(id) on delete set null,
  settled_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_business_order_item_settlement_period_month
    check (period = date_trunc('month', period)::date),
  constraint finance_business_order_item_settlement_quantity_nonneg
    check (quantity >= 0),
  constraint finance_business_order_item_settlement_unit_cost_nonneg
    check (unit_cost is null or unit_cost >= 0)
);

comment on table public.finance_business_order_item_settlements is
  'Per-business-order-item settlement archive. period is the settlement month (first day); unit_cost/quantity are snapshotted at settlement time.';

create index if not exists idx_finance_business_order_item_settlements_period
  on public.finance_business_order_item_settlements (period);
create index if not exists idx_finance_business_order_item_settlements_settled_by
  on public.finance_business_order_item_settlements (settled_by);

drop trigger if exists trg_finance_business_order_item_settlements_touch
  on public.finance_business_order_item_settlements;
create trigger trg_finance_business_order_item_settlements_touch
  before update on public.finance_business_order_item_settlements
  for each row execute function public.touch_updated_at();

alter table public.finance_business_order_item_settlements enable row level security;

revoke all on table public.finance_business_order_item_settlements
  from public, anon, authenticated, service_role;
grant select, insert, update, delete
  on table public.finance_business_order_item_settlements to authenticated, service_role;

drop policy if exists "business_order_item_settlements_select"
  on public.finance_business_order_item_settlements;
create policy "business_order_item_settlements_select"
  on public.finance_business_order_item_settlements
  for select to authenticated
  using (true);

drop policy if exists "business_order_item_settlements_insert"
  on public.finance_business_order_item_settlements;
create policy "business_order_item_settlements_insert"
  on public.finance_business_order_item_settlements
  for insert to authenticated
  with check (
    public.is_finance_or_admin()
    and settled_by = (select auth.uid())
    and exists (
      select 1
      from public.business_order_items as items
      join public.business_orders as orders on orders.id = items.order_id
      where items.id = business_order_item_id
        and orders.voided_at is null
        and orders.status in ('approved', 'completed')
    )
  );

drop policy if exists "business_order_item_settlements_update"
  on public.finance_business_order_item_settlements;
create policy "business_order_item_settlements_update"
  on public.finance_business_order_item_settlements
  for update to authenticated
  using (public.is_finance_or_admin())
  with check (
    public.is_finance_or_admin()
    and settled_by = (select auth.uid())
    and exists (
      select 1
      from public.business_order_items as items
      join public.business_orders as orders on orders.id = items.order_id
      where items.id = business_order_item_id
        and orders.voided_at is null
        and orders.status in ('approved', 'completed')
    )
  );

drop policy if exists "business_order_item_settlements_delete"
  on public.finance_business_order_item_settlements;
create policy "business_order_item_settlements_delete"
  on public.finance_business_order_item_settlements
  for delete to authenticated
  using (public.is_finance_or_admin());

commit;
