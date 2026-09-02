-- 0016_finance_module.sql
-- 财务模块基础数据层：独立于 PI 核心表，提供订单业绩快照、收支与成本。
-- 设计原则：多币种原值 + 当时汇率 + CNY 折算值；财务/管理员全量，业务员仅自己的业绩。

-- 1) 角色与财务枚举
alter type public.user_role add value if not exists 'finance';

do $$ begin
  create type public.finance_record_status as enum ('active', 'void');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.finance_transaction_type as enum ('income', 'expense');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.finance_cost_type as enum (
    'product', 'shipping', 'customs', 'platform_fee', 'payment_fee', 'other'
  );
exception when duplicate_object then null; end $$;

-- 2) 订单业绩快照：从 PI 登记，不修改 PI 本身
create table if not exists public.finance_orders (
  id                        uuid primary key default uuid_generate_v4(),
  pi_id                     uuid unique references public.proforma_invoices(id) on delete set null,
  pi_number_snapshot        text not null,
  customer_name_snapshot    text,
  salesperson_id            uuid references public.profiles(id) on delete set null,
  salesperson_name_snapshot text,
  order_date                date not null,
  amount_original           numeric(18,2) not null check (amount_original >= 0),
  currency                  public.currency_code not null,
  exchange_rate_to_cny      numeric(18,8) not null check (exchange_rate_to_cny > 0),
  amount_cny                numeric(18,2) generated always as (
    round(amount_original * exchange_rate_to_cny, 2)
  ) stored,
  status                    public.finance_record_status not null default 'active',
  notes                     text,
  created_by                uuid references public.profiles(id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint finance_orders_cny_rate check (currency <> 'CNY' or exchange_rate_to_cny = 1)
);

comment on table public.finance_orders is '财务订单/业务业绩快照，来源于 PI，保存登记时金额与汇率';

-- 3) 收支流水
create table if not exists public.finance_transactions (
  id                        uuid primary key default uuid_generate_v4(),
  transaction_type          public.finance_transaction_type not null,
  category                  text not null,
  transaction_date          date not null,
  amount_original           numeric(18,2) not null check (amount_original > 0),
  currency                  public.currency_code not null,
  exchange_rate_to_cny      numeric(18,8) not null check (exchange_rate_to_cny > 0),
  amount_cny                numeric(18,2) generated always as (
    round(amount_original * exchange_rate_to_cny, 2)
  ) stored,
  finance_order_id          uuid references public.finance_orders(id) on delete set null,
  salesperson_id            uuid references public.profiles(id) on delete set null,
  salesperson_name_snapshot text,
  reference_no              text,
  description               text,
  status                    public.finance_record_status not null default 'active',
  created_by                uuid references public.profiles(id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint finance_transactions_cny_rate check (currency <> 'CNY' or exchange_rate_to_cny = 1)
);

comment on table public.finance_transactions is '财务收支流水，保留原币、登记汇率与人民币折算值';

-- 4) 订单成本
create table if not exists public.finance_order_costs (
  id                        uuid primary key default uuid_generate_v4(),
  finance_order_id          uuid not null references public.finance_orders(id) on delete restrict,
  cost_type                 public.finance_cost_type not null,
  incurred_date             date not null,
  amount_original           numeric(18,2) not null check (amount_original > 0),
  currency                  public.currency_code not null,
  exchange_rate_to_cny      numeric(18,8) not null check (exchange_rate_to_cny > 0),
  amount_cny                numeric(18,2) generated always as (
    round(amount_original * exchange_rate_to_cny, 2)
  ) stored,
  description               text,
  created_by                uuid references public.profiles(id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint finance_costs_cny_rate check (currency <> 'CNY' or exchange_rate_to_cny = 1)
);

comment on table public.finance_order_costs is '按财务订单归集的采购、物流、关税和手续费等成本';

-- 5) 索引：覆盖日期筛选、关联查询与所有 RLS 过滤列
create index if not exists idx_finance_orders_salesperson
  on public.finance_orders (salesperson_id);
create index if not exists idx_finance_orders_order_date
  on public.finance_orders (order_date desc);
create index if not exists idx_finance_orders_created_by
  on public.finance_orders (created_by);
create index if not exists idx_finance_orders_status_date
  on public.finance_orders (status, order_date desc);

create index if not exists idx_finance_transactions_date
  on public.finance_transactions (transaction_date desc);
create index if not exists idx_finance_transactions_type_date
  on public.finance_transactions (transaction_type, transaction_date desc);
create index if not exists idx_finance_transactions_order
  on public.finance_transactions (finance_order_id);
create index if not exists idx_finance_transactions_salesperson
  on public.finance_transactions (salesperson_id);
create index if not exists idx_finance_transactions_created_by
  on public.finance_transactions (created_by);

create index if not exists idx_finance_costs_order
  on public.finance_order_costs (finance_order_id);
create index if not exists idx_finance_costs_date
  on public.finance_order_costs (incurred_date desc);
create index if not exists idx_finance_costs_created_by
  on public.finance_order_costs (created_by);

-- 6) updated_at

drop trigger if exists trg_finance_orders_touch on public.finance_orders;
create trigger trg_finance_orders_touch
  before update on public.finance_orders
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_finance_transactions_touch on public.finance_transactions;
create trigger trg_finance_transactions_touch
  before update on public.finance_transactions
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_finance_costs_touch on public.finance_order_costs;
create trigger trg_finance_costs_touch
  before update on public.finance_order_costs
  for each row execute function public.touch_updated_at();

-- 7) 权限辅助函数
create or replace function public.is_approved_user()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and status::text = 'approved'
  );
$$;

create or replace function public.is_finance_or_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and status::text = 'approved'
      and role::text in ('admin', 'finance')
  );
$$;

revoke all on function public.is_approved_user() from public;
revoke all on function public.is_finance_or_admin() from public;
grant execute on function public.is_approved_user() to authenticated;
grant execute on function public.is_finance_or_admin() to authenticated;

-- 登记订单时强制金额、币种、PI 编号和业务员归属匹配源 PI，防止绕过 UI 伪造业绩。
create or replace function public.finance_order_matches_pi(
  p_pi_id uuid,
  p_pi_number text,
  p_salesperson_id uuid,
  p_amount numeric,
  p_currency public.currency_code
)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1
    from public.proforma_invoices pi
    where pi.id = p_pi_id
      and pi.pi_number = p_pi_number
      and pi.created_by = p_salesperson_id
      and pi.total = p_amount
      and pi.currency = p_currency
      and pi.status::text = 'active'
      and pi.deleted_at is null
      and public.is_approved_user()
      and (
        public.is_finance_or_admin()
        or pi.created_by = (select auth.uid())
      )
  );
$$;

revoke all on function public.finance_order_matches_pi(uuid, text, uuid, numeric, public.currency_code)
  from public;
grant execute on function public.finance_order_matches_pi(uuid, text, uuid, numeric, public.currency_code)
  to authenticated;

-- 数据库端覆盖所有 PI 快照字段，避免绕过 Server Action 伪造客户、业务员或金额。
create or replace function public.populate_finance_order_snapshot()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  source_pi public.proforma_invoices%rowtype;
  salesperson_name text;
begin
  select * into source_pi
  from public.proforma_invoices
  where id = new.pi_id
    and status::text = 'active'
    and deleted_at is null;

  if not found then
    raise exception 'PI does not exist or is inactive';
  end if;

  if source_pi.created_by is null then
    raise exception 'PI has no salesperson';
  end if;

  if not public.is_finance_or_admin()
     and (
       not public.is_approved_user()
       or source_pi.created_by <> (select auth.uid())
     )
  then
    raise exception 'Cannot register another salesperson''s PI';
  end if;

  select coalesce(full_name, email) into salesperson_name
  from public.profiles
  where id = source_pi.created_by;

  new.pi_number_snapshot := source_pi.pi_number;
  new.customer_name_snapshot := coalesce(
    source_pi.customer_snapshot->>'company',
    source_pi.customer_snapshot->>'name'
  );
  new.salesperson_id := source_pi.created_by;
  new.salesperson_name_snapshot := salesperson_name;
  new.amount_original := source_pi.total;
  new.currency := source_pi.currency;
  new.exchange_rate_to_cny := case
    when source_pi.currency::text = 'CNY' then 1
    else new.exchange_rate_to_cny
  end;
  new.created_by := (select auth.uid());
  return new;
end;
$$;

revoke all on function public.populate_finance_order_snapshot() from public;

drop trigger if exists trg_finance_orders_snapshot on public.finance_orders;
create trigger trg_finance_orders_snapshot
  before insert on public.finance_orders
  for each row execute function public.populate_finance_order_snapshot();

-- 8) 修复 profiles 自助更新策略造成的 role/status 提权风险。
-- 普通用户仍可更新自己的姓名等资料，但敏感字段只能由管理员修改。
create or replace function public.protect_profile_privileged_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (select auth.uid()) is not null
     and (
       new.role is distinct from old.role
       or new.status is distinct from old.status
     )
     and not public.is_admin()
  then
    raise exception 'Only administrators can change role or status';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_protect_privileged on public.profiles;
create trigger trg_profiles_protect_privileged
  before update on public.profiles
  for each row execute function public.protect_profile_privileged_fields();

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- 9) 财务角色可只读所有 PI 及明细，用于登记订单和核算成本；原写权限不变。
drop policy if exists "pi_select_own" on public.proforma_invoices;
create policy "pi_select_own" on public.proforma_invoices
  for select to authenticated
  using (
    created_by = (select auth.uid())
    or public.is_finance_or_admin()
  );

drop policy if exists "pi_items_select_own" on public.pi_items;
create policy "pi_items_select_own" on public.pi_items
  for select to authenticated
  using (
    exists (
      select 1
      from public.proforma_invoices pi
      where pi.id = pi_items.pi_id
        and (
          pi.created_by = (select auth.uid())
          or public.is_finance_or_admin()
        )
    )
  );

-- 10) 财务表 RLS
alter table public.finance_orders enable row level security;
alter table public.finance_transactions enable row level security;
alter table public.finance_order_costs enable row level security;

grant select, insert, update, delete on public.finance_orders to authenticated;
grant select, insert, update, delete on public.finance_transactions to authenticated;
grant select, insert, update, delete on public.finance_order_costs to authenticated;

-- 订单业绩：财务/管理员看全部；业务员看本人，并仅能从本人有效 PI 登记。
drop policy if exists "finance_orders_select" on public.finance_orders;
create policy "finance_orders_select" on public.finance_orders
  for select to authenticated
  using (
    public.is_finance_or_admin()
    or (
      public.is_approved_user()
      and salesperson_id = (select auth.uid())
    )
  );

drop policy if exists "finance_orders_insert" on public.finance_orders;
create policy "finance_orders_insert" on public.finance_orders
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and public.finance_order_matches_pi(
      pi_id,
      pi_number_snapshot,
      salesperson_id,
      amount_original,
      currency
    )
  );

drop policy if exists "finance_orders_update" on public.finance_orders;
create policy "finance_orders_update" on public.finance_orders
  for update to authenticated
  using (public.is_finance_or_admin())
  with check (public.is_finance_or_admin());

drop policy if exists "finance_orders_delete" on public.finance_orders;
create policy "finance_orders_delete" on public.finance_orders
  for delete to authenticated
  using (public.is_finance_or_admin());

-- 收支：财务/管理员全量维护；业务员只读归属于自己的流水。
drop policy if exists "finance_transactions_select" on public.finance_transactions;
create policy "finance_transactions_select" on public.finance_transactions
  for select to authenticated
  using (
    public.is_finance_or_admin()
    or (
      public.is_approved_user()
      and salesperson_id = (select auth.uid())
    )
  );

drop policy if exists "finance_transactions_insert" on public.finance_transactions;
create policy "finance_transactions_insert" on public.finance_transactions
  for insert to authenticated
  with check (
    public.is_finance_or_admin()
    and created_by = (select auth.uid())
  );

drop policy if exists "finance_transactions_update" on public.finance_transactions;
create policy "finance_transactions_update" on public.finance_transactions
  for update to authenticated
  using (public.is_finance_or_admin())
  with check (public.is_finance_or_admin());

drop policy if exists "finance_transactions_delete" on public.finance_transactions;
create policy "finance_transactions_delete" on public.finance_transactions
  for delete to authenticated
  using (public.is_finance_or_admin());

-- 成本仅财务/管理员可见和维护。
drop policy if exists "finance_costs_select" on public.finance_order_costs;
create policy "finance_costs_select" on public.finance_order_costs
  for select to authenticated
  using (public.is_finance_or_admin());

drop policy if exists "finance_costs_insert" on public.finance_order_costs;
create policy "finance_costs_insert" on public.finance_order_costs
  for insert to authenticated
  with check (
    public.is_finance_or_admin()
    and created_by = (select auth.uid())
  );

drop policy if exists "finance_costs_update" on public.finance_order_costs;
create policy "finance_costs_update" on public.finance_order_costs
  for update to authenticated
  using (public.is_finance_or_admin())
  with check (public.is_finance_or_admin());

drop policy if exists "finance_costs_delete" on public.finance_order_costs;
create policy "finance_costs_delete" on public.finance_order_costs
  for delete to authenticated
  using (public.is_finance_or_admin());

-- 11) 财务总览聚合：在数据库端汇总，避免 PostgREST 默认行数上限造成少算。
-- security invoker 保留调用者 RLS；即使被直接调用，也只能聚合调用者有权读取的数据。
create or replace function public.get_finance_summary()
returns table (
  order_revenue numeric,
  income numeric,
  expense numeric,
  order_costs numeric,
  gross_profit numeric,
  cash_balance numeric
)
language sql
security invoker
set search_path = public
stable
as $$
  with order_summary as (
    select coalesce(sum(amount_cny), 0) as order_revenue
    from public.finance_orders
    where status = 'active'
  ),
  transaction_summary as (
    select
      coalesce(sum(amount_cny) filter (where transaction_type = 'income'), 0) as income,
      coalesce(sum(amount_cny) filter (where transaction_type = 'expense'), 0) as expense
    from public.finance_transactions
    where status = 'active'
  ),
  cost_summary as (
    select coalesce(sum(amount_cny), 0) as order_costs
    from public.finance_order_costs
  )
  select
    o.order_revenue,
    t.income,
    t.expense,
    c.order_costs,
    o.order_revenue - c.order_costs as gross_profit,
    t.income - t.expense as cash_balance
  from order_summary o
  cross join transaction_summary t
  cross join cost_summary c;
$$;

revoke all on function public.get_finance_summary() from public;
grant execute on function public.get_finance_summary() to authenticated;
