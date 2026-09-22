-- 0065 业务提成
-- 业务提成页在业务业绩旁展示"已关联客户"的业务订单，按产品行计算产品提成、
-- 按订单计算运费利润与运费提成。数据分三层：
--   1) 发货分类默认产品提点（全局，财务/管理员维护，供"按发货分类设置提点"按钮使用）；
--   2) 产品明细行的产品提点覆盖（默认取该行发货分类的默认值，可手动改）；
--   3) 订单级运费成本与运费提点（业务提成页手动填）。
-- 提点均以百分数存储（例如 5 表示 5%）。计算口径：
--   产品提成 = 产品实收金额 × 产品提点% ÷ 100
--   运费利润 = 运费实收 − 运费成本
--   运费提成 = 运费利润 × 运费提点% ÷ 100
-- 可见/可写：业务员读写自己名下订单的提成数据，财务/管理员全权；分类默认费率仅财务/管理员可写、所有已审批用户可读。

begin;

-- -----------------------------------------------------------------------------
-- 1. 发货分类默认产品提点（全局单套）
-- -----------------------------------------------------------------------------
create table if not exists public.finance_commission_category_rates (
  category public.daily_order_shipping_category primary key,
  product_commission_rate numeric(7, 4) not null default 0,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_commission_category_rate_valid check (product_commission_rate >= 0)
);

comment on table public.finance_commission_category_rates is
  '发货分类默认产品提点（百分数）。产品明细行未单独设置提点时按此默认值。';

drop trigger if exists trg_finance_commission_category_rates_touch
  on public.finance_commission_category_rates;
create trigger trg_finance_commission_category_rates_touch
  before update on public.finance_commission_category_rates
  for each row execute function public.touch_updated_at();

alter table public.finance_commission_category_rates enable row level security;

revoke all on table public.finance_commission_category_rates
  from public, anon, authenticated, service_role;
grant select, insert, update, delete
  on table public.finance_commission_category_rates to authenticated, service_role;

drop policy if exists "commission_category_rates_select"
  on public.finance_commission_category_rates;
create policy "commission_category_rates_select"
  on public.finance_commission_category_rates
  for select to authenticated
  using (public.is_approved_user());

drop policy if exists "commission_category_rates_insert"
  on public.finance_commission_category_rates;
create policy "commission_category_rates_insert"
  on public.finance_commission_category_rates
  for insert to authenticated
  with check (public.is_finance_or_admin() and updated_by = (select auth.uid()));

drop policy if exists "commission_category_rates_update"
  on public.finance_commission_category_rates;
create policy "commission_category_rates_update"
  on public.finance_commission_category_rates
  for update to authenticated
  using (public.is_finance_or_admin())
  with check (public.is_finance_or_admin() and updated_by = (select auth.uid()));

drop policy if exists "commission_category_rates_delete"
  on public.finance_commission_category_rates;
create policy "commission_category_rates_delete"
  on public.finance_commission_category_rates
  for delete to authenticated
  using (public.is_finance_or_admin());

-- -----------------------------------------------------------------------------
-- 2. 产品明细行产品提点覆盖
-- -----------------------------------------------------------------------------
create table if not exists public.finance_business_order_item_commissions (
  business_order_item_id uuid primary key references public.business_order_items(id) on delete cascade,
  commission_rate numeric(7, 4) not null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_business_order_item_commission_valid check (commission_rate >= 0)
);

comment on table public.finance_business_order_item_commissions is
  '业务订单明细行的产品提点（百分数）覆盖。无记录时按该行发货分类的默认提点。';

create index if not exists idx_finance_business_order_item_commissions_updated_by
  on public.finance_business_order_item_commissions (updated_by);

drop trigger if exists trg_finance_business_order_item_commissions_touch
  on public.finance_business_order_item_commissions;
create trigger trg_finance_business_order_item_commissions_touch
  before update on public.finance_business_order_item_commissions
  for each row execute function public.touch_updated_at();

alter table public.finance_business_order_item_commissions enable row level security;

revoke all on table public.finance_business_order_item_commissions
  from public, anon, authenticated, service_role;
grant select, insert, update, delete
  on table public.finance_business_order_item_commissions to authenticated, service_role;

drop policy if exists "business_order_item_commissions_select"
  on public.finance_business_order_item_commissions;
create policy "business_order_item_commissions_select"
  on public.finance_business_order_item_commissions
  for select to authenticated
  using (
    exists (
      select 1
      from public.business_order_items as items
      where items.id = business_order_item_id
        and public.can_view_business_order(items.order_id)
    )
  );

drop policy if exists "business_order_item_commissions_insert"
  on public.finance_business_order_item_commissions;
create policy "business_order_item_commissions_insert"
  on public.finance_business_order_item_commissions
  for insert to authenticated
  with check (
    updated_by = (select auth.uid())
    and exists (
      select 1
      from public.business_order_items as items
      join public.business_orders as orders on orders.id = items.order_id
      where items.id = business_order_item_id
        and orders.customer_id is not null
        and orders.voided_at is null
        and (public.is_finance_or_admin() or orders.salesperson_id = (select auth.uid()))
    )
  );

drop policy if exists "business_order_item_commissions_update"
  on public.finance_business_order_item_commissions;
create policy "business_order_item_commissions_update"
  on public.finance_business_order_item_commissions
  for update to authenticated
  using (
    exists (
      select 1
      from public.business_order_items as items
      join public.business_orders as orders on orders.id = items.order_id
      where items.id = business_order_item_id
        and (public.is_finance_or_admin() or orders.salesperson_id = (select auth.uid()))
    )
  )
  with check (
    updated_by = (select auth.uid())
    and exists (
      select 1
      from public.business_order_items as items
      join public.business_orders as orders on orders.id = items.order_id
      where items.id = business_order_item_id
        and orders.customer_id is not null
        and orders.voided_at is null
        and (public.is_finance_or_admin() or orders.salesperson_id = (select auth.uid()))
    )
  );

drop policy if exists "business_order_item_commissions_delete"
  on public.finance_business_order_item_commissions;
create policy "business_order_item_commissions_delete"
  on public.finance_business_order_item_commissions
  for delete to authenticated
  using (
    exists (
      select 1
      from public.business_order_items as items
      join public.business_orders as orders on orders.id = items.order_id
      where items.id = business_order_item_id
        and (public.is_finance_or_admin() or orders.salesperson_id = (select auth.uid()))
    )
  );

-- -----------------------------------------------------------------------------
-- 3. 订单级运费成本与运费提点
-- -----------------------------------------------------------------------------
create table if not exists public.finance_business_order_commissions (
  business_order_id uuid primary key references public.business_orders(id) on delete cascade,
  freight_cost numeric(18, 4) not null default 0,
  freight_commission_rate numeric(7, 4) not null default 0,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_business_order_commission_valid
    check (freight_cost >= 0 and freight_commission_rate >= 0)
);

comment on table public.finance_business_order_commissions is
  '业务订单级运费成本与运费提点（百分数），供业务提成页计算运费利润与运费提成。';

create index if not exists idx_finance_business_order_commissions_updated_by
  on public.finance_business_order_commissions (updated_by);

drop trigger if exists trg_finance_business_order_commissions_touch
  on public.finance_business_order_commissions;
create trigger trg_finance_business_order_commissions_touch
  before update on public.finance_business_order_commissions
  for each row execute function public.touch_updated_at();

alter table public.finance_business_order_commissions enable row level security;

revoke all on table public.finance_business_order_commissions
  from public, anon, authenticated, service_role;
grant select, insert, update, delete
  on table public.finance_business_order_commissions to authenticated, service_role;

drop policy if exists "business_order_commissions_select"
  on public.finance_business_order_commissions;
create policy "business_order_commissions_select"
  on public.finance_business_order_commissions
  for select to authenticated
  using (public.can_view_business_order(business_order_id));

drop policy if exists "business_order_commissions_insert"
  on public.finance_business_order_commissions;
create policy "business_order_commissions_insert"
  on public.finance_business_order_commissions
  for insert to authenticated
  with check (
    updated_by = (select auth.uid())
    and exists (
      select 1
      from public.business_orders as orders
      where orders.id = business_order_id
        and orders.customer_id is not null
        and orders.voided_at is null
        and (public.is_finance_or_admin() or orders.salesperson_id = (select auth.uid()))
    )
  );

drop policy if exists "business_order_commissions_update"
  on public.finance_business_order_commissions;
create policy "business_order_commissions_update"
  on public.finance_business_order_commissions
  for update to authenticated
  using (
    exists (
      select 1
      from public.business_orders as orders
      where orders.id = business_order_id
        and (public.is_finance_or_admin() or orders.salesperson_id = (select auth.uid()))
    )
  )
  with check (
    updated_by = (select auth.uid())
    and exists (
      select 1
      from public.business_orders as orders
      where orders.id = business_order_id
        and orders.customer_id is not null
        and orders.voided_at is null
        and (public.is_finance_or_admin() or orders.salesperson_id = (select auth.uid()))
    )
  );

drop policy if exists "business_order_commissions_delete"
  on public.finance_business_order_commissions;
create policy "business_order_commissions_delete"
  on public.finance_business_order_commissions
  for delete to authenticated
  using (
    exists (
      select 1
      from public.business_orders as orders
      where orders.id = business_order_id
        and (public.is_finance_or_admin() or orders.salesperson_id = (select auth.uid()))
    )
  );

commit;
