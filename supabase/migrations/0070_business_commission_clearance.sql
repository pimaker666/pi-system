-- 0070 业务提成结清
-- 财务在“业务提成”页选择产品行，指定结清年月后提交；提交后对应业务员可在后台确认或驳回。
-- 驳回后财务可重新提交。结清按明细行粒度，同一订单可部分结清。

begin;

do $$ begin
  create type public.commission_clearance_status as enum ('pending', 'confirmed', 'rejected');
exception when duplicate_object then null; end $$;

create table if not exists public.finance_business_order_item_commission_clearances (
  business_order_item_id uuid primary key references public.business_order_items(id) on delete cascade,
  period date not null,
  status public.commission_clearance_status not null default 'pending',
  submitted_by uuid references public.profiles(id) on delete set null,
  submitted_at timestamptz not null default now(),
  confirmed_by uuid references public.profiles(id) on delete set null,
  confirmed_at timestamptz null,
  rejected_reason text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_business_order_item_commission_clearance_period_month
    check (period = date_trunc('month', period)::date)
);

comment on table public.finance_business_order_item_commission_clearances is
  'Per-business-order-item commission clearance. period is the clearance month (first day); status tracks pending/confirmed/rejected.';
comment on column public.finance_business_order_item_commission_clearances.status is
  'pending=财务提交待业务员确认；confirmed=业务员已确认结清；rejected=业务员驳回，财务可重新提交';

create index if not exists idx_finance_business_order_item_commission_clearances_period
  on public.finance_business_order_item_commission_clearances (period);
create index if not exists idx_finance_business_order_item_commission_clearances_status
  on public.finance_business_order_item_commission_clearances (status);
create index if not exists idx_finance_business_order_item_commission_clearances_submitted_by
  on public.finance_business_order_item_commission_clearances (submitted_by);

drop trigger if exists trg_finance_business_order_item_commission_clearances_touch
  on public.finance_business_order_item_commission_clearances;
create trigger trg_finance_business_order_item_commission_clearances_touch
  before update on public.finance_business_order_item_commission_clearances
  for each row execute function public.touch_updated_at();

alter table public.finance_business_order_item_commission_clearances enable row level security;

revoke all on table public.finance_business_order_item_commission_clearances
  from public, anon, authenticated, service_role;
grant select, insert, update, delete
  on table public.finance_business_order_item_commission_clearances to authenticated, service_role;

-- 所有人（在订单可见范围内）可读，供每日订单“提成”列与业务提成页展示状态。
drop policy if exists "business_order_item_commission_clearances_select"
  on public.finance_business_order_item_commission_clearances;
create policy "business_order_item_commission_clearances_select"
  on public.finance_business_order_item_commission_clearances
  for select to authenticated
  using (
    exists (
      select 1
      from public.business_order_items as items
      where items.id = business_order_item_id
        and public.can_view_business_order(items.order_id)
    )
  );

-- 仅财务/管理员可提交结清（insert）。
drop policy if exists "business_order_item_commission_clearances_insert"
  on public.finance_business_order_item_commission_clearances;
create policy "business_order_item_commission_clearances_insert"
  on public.finance_business_order_item_commission_clearances
  for insert to authenticated
  with check (
    public.is_finance_or_admin()
    and status = 'pending'
    and submitted_by = (select auth.uid())
    and exists (
      select 1
      from public.business_order_items as items
      join public.business_orders as orders on orders.id = items.order_id
      where items.id = business_order_item_id
        and orders.voided_at is null
        and orders.status in ('approved', 'completed')
    )
  );

-- 财务/管理员可任意修改；业务员仅能将本人订单的 pending 改为 confirmed/rejected。
drop policy if exists "business_order_item_commission_clearances_update"
  on public.finance_business_order_item_commission_clearances;
create policy "business_order_item_commission_clearances_update"
  on public.finance_business_order_item_commission_clearances
  for update to authenticated
  using (
    public.is_finance_or_admin()
    or (
      status = 'pending'
      and exists (
        select 1
        from public.business_order_items as items
        join public.business_orders as orders on orders.id = items.order_id
        where items.id = business_order_item_id
          and orders.salesperson_id = (select auth.uid())
      )
    )
  )
  with check (
    public.is_finance_or_admin()
    or (
      status in ('confirmed', 'rejected')
      and exists (
        select 1
        from public.business_order_items as items
        join public.business_orders as orders on orders.id = items.order_id
        where items.id = business_order_item_id
          and orders.salesperson_id = (select auth.uid())
      )
    )
  );

-- 仅财务/管理员可删除（重新提交前清理旧记录）。
drop policy if exists "business_order_item_commission_clearances_delete"
  on public.finance_business_order_item_commission_clearances;
create policy "business_order_item_commission_clearances_delete"
  on public.finance_business_order_item_commission_clearances
  for delete to authenticated
  using (public.is_finance_or_admin());

commit;
