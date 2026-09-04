-- 0022_daily_order_sales_workflow.sql
-- 每日订单「业务认领 / 绑定客户 / 业绩审核 / 提成 / 改动审核」工作流。
--
-- 背景：0018 的 finance_daily_orders 是「产品行」粒度，同一订单号可有多行，且无订单头、
-- 无客户、无归属工作流概念。本迁移在其上叠加一个「订单头」工作流表，键为
-- UNIQUE(salesperson_id, order_number)——同一业务员 + 同一订单号的所有产品行共享一个工作流。
--
-- 设计原则（与既有迁移保持一致）：
--   * 只读可见性仅在既有 SELECT 策略「追加 or ...」，绝不放松写策略；所有写操作走 SECURITY DEFINER RPC。
--   * 敏感的提成金额（commissions）与审计日志（audit_logs）仅 finance/admin 可读，业务/主管不可见。
--   * 业务对「非客户订单字段」的修改一律走 change_requests（待审），审核通过前绝不覆盖原值；驳回需理由。
--   * 乐观版本锁 version、追加式审计。
--   * 外键对 profiles 一律 on delete set null / cascade，绝不因用户被删而阻塞删除（延续 0013 约定）。
--
-- 幂等：可安全重复执行。

-- ------------------------------------------------------------
-- 1) 枚举
-- ------------------------------------------------------------
do $$ begin
  create type public.daily_order_workflow_status as enum ('unclaimed', 'claimed', 'submitted', 'approved', 'rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.daily_order_change_status as enum ('pending', 'approved', 'rejected', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.daily_order_workflow_audit_action as enum (
    'claim', 'bind_customer', 'submit', 'approve', 'reject',
    'commission_saved', 'change_requested', 'change_approved', 'change_rejected', 'change_cancelled'
  );
exception when duplicate_object then null; end $$;

-- ------------------------------------------------------------
-- 2) 订单头工作流表：UNIQUE(salesperson_id, order_number)
-- ------------------------------------------------------------
create table if not exists public.finance_daily_order_workflows (
  id uuid primary key default uuid_generate_v4(),
  version int not null default 1 check (version > 0),
  status public.daily_order_workflow_status not null default 'unclaimed',
  salesperson_id uuid not null references public.profiles(id) on delete cascade,
  salesperson_name_snapshot text not null,
  order_number text not null,
  customer_id uuid references public.customers(id) on delete set null,
  customer_name_snapshot text,
  claimed_at timestamptz,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  review_reason text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fdo_workflow_order_number_check check (char_length(btrim(order_number)) between 1 and 200),
  constraint fdo_workflow_customer_snapshot_check check (customer_name_snapshot is null or char_length(customer_name_snapshot) <= 300),
  constraint fdo_workflow_review_reason_check check (review_reason is null or char_length(review_reason) <= 2000),
  constraint fdo_workflow_customer_required_when_submitted check (
    status not in ('submitted', 'approved') or customer_id is not null
  ),
  unique (salesperson_id, order_number)
);
comment on table public.finance_daily_order_workflows is '每日订单头工作流（按业务员+订单号聚合）：认领、绑定客户、业绩审核状态机';

create index if not exists idx_daily_order_workflows_salesperson
  on public.finance_daily_order_workflows (salesperson_id, status);
create index if not exists idx_daily_order_workflows_status
  on public.finance_daily_order_workflows (status, updated_at desc);
create index if not exists idx_daily_order_workflows_customer
  on public.finance_daily_order_workflows (customer_id);
create index if not exists idx_daily_order_workflows_reviewed_by
  on public.finance_daily_order_workflows (reviewed_by);
create index if not exists idx_daily_order_workflows_created_by
  on public.finance_daily_order_workflows (created_by);

-- ------------------------------------------------------------
-- 3) 提成表（仅 finance/admin 可读写）：与工作流一对一
-- ------------------------------------------------------------
create table if not exists public.finance_daily_order_commissions (
  id uuid primary key default uuid_generate_v4(),
  workflow_id uuid not null unique references public.finance_daily_order_workflows(id) on delete cascade,
  commission_amount numeric(18,2) not null check (commission_amount >= 0 and commission_amount <= 999999999999),
  commission_currency public.currency_code not null,
  remarks text,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fdo_commission_currency_check check (commission_currency::text in ('CNY', 'USD')),
  constraint fdo_commission_remarks_check check (remarks is null or char_length(remarks) <= 2000)
);
comment on table public.finance_daily_order_commissions is '每日订单提成（敏感）：仅 finance/admin 可读写，业务与主管均不可见';

create index if not exists idx_daily_order_commissions_created_by
  on public.finance_daily_order_commissions (created_by);

-- ------------------------------------------------------------
-- 4) 改动申请表：业务对非客户订单字段的修改需财务/管理员审核
-- ------------------------------------------------------------
create table if not exists public.finance_daily_order_change_requests (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid not null references public.finance_daily_orders(id) on delete cascade,
  workflow_id uuid not null references public.finance_daily_order_workflows(id) on delete cascade,
  status public.daily_order_change_status not null default 'pending',
  payload jsonb not null,
  requested_by uuid references public.profiles(id) on delete set null,
  requested_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fdo_change_payload_object_check check (jsonb_typeof(payload) = 'object'),
  constraint fdo_change_review_reason_check check (review_reason is null or char_length(review_reason) <= 2000)
);
comment on table public.finance_daily_order_change_requests is '业务发起的订单字段改动申请（白名单字段）；审核通过前绝不覆盖原订单';

-- 同一订单行同时只允许一条待审改动
create unique index if not exists idx_daily_order_change_one_pending
  on public.finance_daily_order_change_requests (order_id) where status = 'pending';
create index if not exists idx_daily_order_change_requested_by
  on public.finance_daily_order_change_requests (requested_by, status);
create index if not exists idx_daily_order_change_workflow
  on public.finance_daily_order_change_requests (workflow_id, status);
create index if not exists idx_daily_order_change_status
  on public.finance_daily_order_change_requests (status, requested_at desc);

-- ------------------------------------------------------------
-- 5) 追加式审计日志（仅 finance/admin 可读）
-- ------------------------------------------------------------
create table if not exists public.finance_daily_order_workflow_audit_logs (
  id uuid primary key default uuid_generate_v4(),
  workflow_id uuid not null references public.finance_daily_order_workflows(id) on delete cascade,
  action public.daily_order_workflow_audit_action not null,
  actor_id uuid references public.profiles(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_daily_order_workflow_audit_workflow
  on public.finance_daily_order_workflow_audit_logs (workflow_id, created_at desc);
create index if not exists idx_daily_order_workflow_audit_actor
  on public.finance_daily_order_workflow_audit_logs (actor_id);

-- ------------------------------------------------------------
-- 6) 触发器：updated_at 自动维护
-- ------------------------------------------------------------
drop trigger if exists trg_daily_order_workflows_touch on public.finance_daily_order_workflows;
create trigger trg_daily_order_workflows_touch before update on public.finance_daily_order_workflows
  for each row execute function public.touch_updated_at();
drop trigger if exists trg_daily_order_commissions_touch on public.finance_daily_order_commissions;
create trigger trg_daily_order_commissions_touch before update on public.finance_daily_order_commissions
  for each row execute function public.touch_updated_at();
drop trigger if exists trg_daily_order_change_requests_touch on public.finance_daily_order_change_requests;
create trigger trg_daily_order_change_requests_touch before update on public.finance_daily_order_change_requests
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- 7) finance_daily_orders 增加 workflow_id 关联列 + 回填
-- ------------------------------------------------------------
alter table public.finance_daily_orders
  add column if not exists workflow_id uuid references public.finance_daily_order_workflows(id) on delete set null;
create index if not exists idx_daily_orders_workflow
  on public.finance_daily_orders (workflow_id);

-- 回填：为已存在、且有归属业务员的订单行，按 (salesperson_id, order_number) 创建工作流头
insert into public.finance_daily_order_workflows (salesperson_id, salesperson_name_snapshot, order_number, status, created_by)
select distinct on (o.salesperson_id, btrim(o.order_number))
  o.salesperson_id, o.salesperson_name_snapshot, btrim(o.order_number), 'unclaimed', o.created_by
from public.finance_daily_orders o
where o.salesperson_id is not null
order by o.salesperson_id, btrim(o.order_number), o.created_at
on conflict (salesperson_id, order_number) do nothing;

update public.finance_daily_orders o
set workflow_id = w.id
from public.finance_daily_order_workflows w
where w.salesperson_id = o.salesperson_id
  and w.order_number = btrim(o.order_number)
  and o.salesperson_id is not null
  and o.workflow_id is null;

-- ------------------------------------------------------------
-- 8) 内部辅助函数
-- ------------------------------------------------------------

-- 8a) find-or-create 工作流头（由 create/update RPC 内部调用，不直接对外授权）
create or replace function public.resolve_daily_order_workflow(
  p_salesperson_id uuid, p_salesperson_name text, p_order_number text, p_actor_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid; v_num text;
begin
  v_num := btrim(p_order_number);
  select id into v_id from public.finance_daily_order_workflows
    where salesperson_id = p_salesperson_id and order_number = v_num;
  if found then
    return v_id;
  end if;
  insert into public.finance_daily_order_workflows(salesperson_id, salesperson_name_snapshot, order_number, status, created_by)
    values (p_salesperson_id, p_salesperson_name, v_num, 'unclaimed', p_actor_id)
  on conflict (salesperson_id, order_number) do update set salesperson_id = excluded.salesperson_id
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.resolve_daily_order_workflow(uuid, text, text, uuid) from public, anon, authenticated, service_role;

-- 8b) 追加审计
create or replace function public.write_daily_order_workflow_audit(
  p_workflow_id uuid, p_action public.daily_order_workflow_audit_action, p_actor uuid, p_detail jsonb
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.finance_daily_order_workflow_audit_logs(workflow_id, action, actor_id, detail)
  values (p_workflow_id, p_action, p_actor, coalesce(p_detail, '{}'::jsonb));
$$;
revoke all on function public.write_daily_order_workflow_audit(uuid, public.daily_order_workflow_audit_action, uuid, jsonb) from public, anon, authenticated, service_role;

-- 8c) 已审核 sales 断言
create or replace function public.assert_daily_order_sales_actor()
returns public.profiles
language plpgsql
security definer
set search_path = public
stable
as $$
declare v_actor public.profiles%rowtype;
begin
  select * into v_actor from public.profiles where id = (select auth.uid());
  if not found or v_actor.status::text <> 'approved' or v_actor.role::text <> 'sales' then
    raise exception 'Only approved sales users can perform this action';
  end if;
  return v_actor;
end;
$$;
revoke all on function public.assert_daily_order_sales_actor() from public, anon, authenticated, service_role;

-- 8d) 改动申请白名单校验（request 与 review-approve 共用）
create or replace function public.validate_daily_order_change_payload(p_payload jsonb)
returns void
language plpgsql
immutable
set search_path = public
as $$
declare v_num numeric;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Change payload must be a JSON object';
  end if;
  if p_payload = '{}'::jsonb then
    raise exception 'Change payload cannot be empty';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_payload) as k(key)
    where k.key not in (
      'shipping_date', 'shipping_number', 'shipping_category', 'quantity',
      'sales_unit_price_amount', 'sales_unit_price_currency',
      'product_received_amount', 'product_received_currency',
      'logistics_fee_amount', 'logistics_fee_currency',
      'sales_total_amount', 'sales_total_currency',
      'payment_category', 'remarks'
    )
  ) then
    raise exception 'Change payload contains unsupported fields';
  end if;

  if p_payload ? 'shipping_date' then
    perform (p_payload->>'shipping_date')::date;
  end if;
  if p_payload ? 'shipping_number' and char_length(coalesce(p_payload->>'shipping_number', '')) > 200 then
    raise exception 'Shipping number is too long';
  end if;
  if p_payload ? 'shipping_category' then
    perform (p_payload->>'shipping_category')::public.daily_order_shipping_category;
  end if;
  if p_payload ? 'payment_category' then
    perform (p_payload->>'payment_category')::public.daily_order_payment_category;
  end if;
  if p_payload ? 'remarks' and char_length(coalesce(p_payload->>'remarks', '')) > 2000 then
    raise exception 'Remarks are too long';
  end if;

  if p_payload ? 'quantity' then
    v_num := (p_payload->>'quantity')::numeric;
    if v_num <= 0 or v_num > 999999999999 or v_num <> round(v_num, 4) then
      raise exception 'Quantity must be positive and within 4 decimal places';
    end if;
  end if;

  foreach v_num in array (
    select coalesce(array_agg((p_payload->>col)::numeric), array[]::numeric[])
    from unnest(array[
      'sales_unit_price_amount', 'product_received_amount', 'logistics_fee_amount', 'sales_total_amount'
    ]) as col
    where p_payload ? col
  ) loop
    if v_num < 0 or v_num > 999999999999 or v_num <> round(v_num, 2) then
      raise exception 'Amounts must be non-negative and within 2 decimal places';
    end if;
  end loop;

  if p_payload ? 'sales_unit_price_currency' then
    perform (p_payload->>'sales_unit_price_currency')::public.currency_code;
    if (p_payload->>'sales_unit_price_currency') not in ('CNY', 'USD') then raise exception 'Unsupported currency'; end if;
  end if;
  if p_payload ? 'product_received_currency' then
    perform (p_payload->>'product_received_currency')::public.currency_code;
    if (p_payload->>'product_received_currency') not in ('CNY', 'USD') then raise exception 'Unsupported currency'; end if;
  end if;
  if p_payload ? 'logistics_fee_currency' then
    perform (p_payload->>'logistics_fee_currency')::public.currency_code;
    if (p_payload->>'logistics_fee_currency') not in ('CNY', 'USD') then raise exception 'Unsupported currency'; end if;
  end if;
  if p_payload ? 'sales_total_currency' then
    perform (p_payload->>'sales_total_currency')::public.currency_code;
    if (p_payload->>'sales_total_currency') not in ('CNY', 'USD') then raise exception 'Unsupported currency'; end if;
  end if;
end;
$$;
revoke all on function public.validate_daily_order_change_payload(jsonb) from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 9) CREATE OR REPLACE：create/update RPC 增加 workflow_id 解析
--    （签名与 0018 完全一致，仅新增工作流关联逻辑）
-- ------------------------------------------------------------
create or replace function public.create_finance_daily_order(
  p_order_date date, p_shop_id uuid, p_salesperson_id uuid, p_order_number text,
  p_shipping_date date, p_shipping_number text, p_shipping_category public.daily_order_shipping_category,
  p_product_id uuid, p_quantity numeric,
  p_sales_unit_price_amount numeric, p_sales_unit_price_currency public.currency_code,
  p_product_received_amount numeric, p_product_received_currency public.currency_code,
  p_logistics_fee_amount numeric, p_logistics_fee_currency public.currency_code,
  p_sales_total_amount numeric, p_sales_total_currency public.currency_code,
  p_payment_category public.daily_order_payment_category, p_remarks text
)
returns table (id uuid, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_shop public.finance_daily_order_shops%rowtype;
  v_sales public.profiles%rowtype;
  v_product public.products%rowtype;
  v_order public.finance_daily_orders%rowtype;
  v_workflow_id uuid;
  v_sales_name text;
begin
  v_actor := public.assert_daily_order_finance_actor();
  if p_order_date is null or p_shipping_date is null then raise exception 'Order and shipping dates are required'; end if;
  if nullif(btrim(p_order_number), '') is null or char_length(btrim(p_order_number)) > 200 then raise exception 'Invalid order number'; end if;
  if char_length(coalesce(p_shipping_number, '')) > 200 then raise exception 'Shipping number is too long'; end if;
  if char_length(coalesce(p_remarks, '')) > 2000 then raise exception 'Remarks are too long'; end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 999999999999 then raise exception 'Quantity must be greater than zero'; end if;
  if p_quantity <> round(p_quantity, 4) then raise exception 'Quantity cannot exceed 4 decimal places'; end if;
  if p_sales_unit_price_amount is null or p_sales_unit_price_amount < 0 or p_sales_unit_price_amount > 999999999999
     or p_product_received_amount is null or p_product_received_amount < 0 or p_product_received_amount > 999999999999
     or p_logistics_fee_amount is null or p_logistics_fee_amount < 0 or p_logistics_fee_amount > 999999999999
     or p_sales_total_amount is null or p_sales_total_amount < 0 or p_sales_total_amount > 999999999999
  then raise exception 'Amounts must be non-negative and within range'; end if;
  if p_sales_unit_price_amount <> round(p_sales_unit_price_amount, 2)
     or p_product_received_amount <> round(p_product_received_amount, 2)
     or p_logistics_fee_amount <> round(p_logistics_fee_amount, 2)
     or p_sales_total_amount <> round(p_sales_total_amount, 2)
  then raise exception 'Amounts cannot exceed 2 decimal places'; end if;

  select * into v_shop
  from public.finance_daily_order_shops as shops
  where shops.id = p_shop_id and shops.is_active = true;
  if not found then raise exception 'Shop does not exist or is inactive'; end if;
  select * into v_sales
  from public.profiles as salespeople
  where salespeople.id = p_salesperson_id
    and salespeople.status::text = 'approved'
    and salespeople.role::text = 'sales';
  if not found then raise exception 'Salesperson does not exist or is not approved'; end if;
  if not exists (
    select 1 from public.finance_daily_order_shop_salespeople as assignments
    where assignments.shop_id = p_shop_id
      and assignments.salesperson_id = p_salesperson_id
      and assignments.is_active = true
  ) then raise exception 'Salesperson is not assigned to shop'; end if;
  select * into v_product
  from public.products as products
  where products.id = p_product_id and products.is_active = true;
  if not found then raise exception 'Product does not exist or is inactive'; end if;

  v_sales_name := coalesce(nullif(btrim(v_sales.full_name), ''), v_sales.email);
  v_workflow_id := public.resolve_daily_order_workflow(v_sales.id, v_sales_name, p_order_number, v_actor.id);

  insert into public.finance_daily_orders (
    order_date, shop_id, shop_name_snapshot, salesperson_id, salesperson_name_snapshot,
    order_number, shipping_date, shipping_number, shipping_category,
    product_id, product_name_snapshot, product_sku_snapshot, quantity,
    sales_unit_price_amount, sales_unit_price_currency,
    product_received_amount, product_received_currency,
    logistics_fee_amount, logistics_fee_currency,
    sales_total_amount, sales_total_currency, payment_category, remarks, workflow_id, created_by, updated_by
  ) values (
    p_order_date, v_shop.id, v_shop.name, v_sales.id, v_sales_name,
    btrim(p_order_number), p_shipping_date, nullif(btrim(p_shipping_number), ''), p_shipping_category,
    v_product.id, v_product.name, v_product.sku, p_quantity,
    p_sales_unit_price_amount, p_sales_unit_price_currency,
    p_product_received_amount, p_product_received_currency,
    p_logistics_fee_amount, p_logistics_fee_currency,
    p_sales_total_amount, p_sales_total_currency, p_payment_category, nullif(btrim(p_remarks), ''), v_workflow_id, v_actor.id, v_actor.id
  ) returning * into v_order;
  return query select v_order.id, v_order.version;
end;
$$;
revoke all on function public.create_finance_daily_order(date, uuid, uuid, text, date, text, public.daily_order_shipping_category, uuid, numeric, numeric, public.currency_code, numeric, public.currency_code, numeric, public.currency_code, numeric, public.currency_code, public.daily_order_payment_category, text) from public;
grant execute on function public.create_finance_daily_order(date, uuid, uuid, text, date, text, public.daily_order_shipping_category, uuid, numeric, numeric, public.currency_code, numeric, public.currency_code, numeric, public.currency_code, numeric, public.currency_code, public.daily_order_payment_category, text) to authenticated;

create or replace function public.update_finance_daily_order(
  p_order_id uuid, p_expected_version int,
  p_order_date date, p_shop_id uuid, p_salesperson_id uuid, p_order_number text,
  p_shipping_date date, p_shipping_number text, p_shipping_category public.daily_order_shipping_category,
  p_product_id uuid, p_quantity numeric,
  p_sales_unit_price_amount numeric, p_sales_unit_price_currency public.currency_code,
  p_product_received_amount numeric, p_product_received_currency public.currency_code,
  p_logistics_fee_amount numeric, p_logistics_fee_currency public.currency_code,
  p_sales_total_amount numeric, p_sales_total_currency public.currency_code,
  p_payment_category public.daily_order_payment_category, p_remarks text
)
returns table (id uuid, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_existing public.finance_daily_orders%rowtype;
  v_shop public.finance_daily_order_shops%rowtype;
  v_sales public.profiles%rowtype;
  v_product public.products%rowtype;
  v_workflow_id uuid;
  v_sales_name text;
begin
  v_actor := public.assert_daily_order_finance_actor();
  select * into v_existing from public.finance_daily_orders where finance_daily_orders.id = p_order_id for update;
  if not found then raise exception 'Daily order does not exist'; end if;
  if v_existing.status <> 'active' then raise exception 'Voided daily order cannot be edited'; end if;
  if v_existing.version <> p_expected_version then raise exception 'Daily order version conflict'; end if;
  if p_order_date is null or p_shipping_date is null then raise exception 'Order and shipping dates are required'; end if;
  if nullif(btrim(p_order_number), '') is null or char_length(btrim(p_order_number)) > 200 then raise exception 'Invalid order number'; end if;
  if char_length(coalesce(p_shipping_number, '')) > 200 or char_length(coalesce(p_remarks, '')) > 2000 then raise exception 'Text field is too long'; end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 999999999999 then raise exception 'Quantity must be greater than zero'; end if;
  if p_quantity <> round(p_quantity, 4) then raise exception 'Quantity cannot exceed 4 decimal places'; end if;
  if p_sales_unit_price_amount is null or p_sales_unit_price_amount < 0 or p_sales_unit_price_amount > 999999999999
     or p_product_received_amount is null or p_product_received_amount < 0 or p_product_received_amount > 999999999999
     or p_logistics_fee_amount is null or p_logistics_fee_amount < 0 or p_logistics_fee_amount > 999999999999
     or p_sales_total_amount is null or p_sales_total_amount < 0 or p_sales_total_amount > 999999999999
  then raise exception 'Amounts must be non-negative and within range'; end if;
  if p_sales_unit_price_amount <> round(p_sales_unit_price_amount, 2)
     or p_product_received_amount <> round(p_product_received_amount, 2)
     or p_logistics_fee_amount <> round(p_logistics_fee_amount, 2)
     or p_sales_total_amount <> round(p_sales_total_amount, 2)
  then raise exception 'Amounts cannot exceed 2 decimal places'; end if;
  select * into v_shop
  from public.finance_daily_order_shops as shops
  where shops.id = p_shop_id and shops.is_active = true;
  if not found then raise exception 'Shop does not exist or is inactive'; end if;
  select * into v_sales
  from public.profiles as salespeople
  where salespeople.id = p_salesperson_id
    and salespeople.status::text = 'approved'
    and salespeople.role::text = 'sales';
  if not found then raise exception 'Salesperson does not exist or is not approved'; end if;
  if not exists (
    select 1 from public.finance_daily_order_shop_salespeople as assignments
    where assignments.shop_id = p_shop_id
      and assignments.salesperson_id = p_salesperson_id
      and assignments.is_active = true
  ) then raise exception 'Salesperson is not assigned to shop'; end if;
  select * into v_product
  from public.products as products
  where products.id = p_product_id and products.is_active = true;
  if not found then raise exception 'Product does not exist or is inactive'; end if;

  v_sales_name := coalesce(nullif(btrim(v_sales.full_name), ''), v_sales.email);
  v_workflow_id := public.resolve_daily_order_workflow(v_sales.id, v_sales_name, p_order_number, v_actor.id);

  update public.finance_daily_orders as target set
    order_date = p_order_date, shop_id = v_shop.id, shop_name_snapshot = v_shop.name,
    salesperson_id = v_sales.id, salesperson_name_snapshot = v_sales_name,
    order_number = btrim(p_order_number), shipping_date = p_shipping_date,
    shipping_number = nullif(btrim(p_shipping_number), ''), shipping_category = p_shipping_category,
    product_id = v_product.id, product_name_snapshot = v_product.name, product_sku_snapshot = v_product.sku,
    quantity = p_quantity, sales_unit_price_amount = p_sales_unit_price_amount,
    sales_unit_price_currency = p_sales_unit_price_currency,
    product_received_amount = p_product_received_amount, product_received_currency = p_product_received_currency,
    logistics_fee_amount = p_logistics_fee_amount, logistics_fee_currency = p_logistics_fee_currency,
    sales_total_amount = p_sales_total_amount, sales_total_currency = p_sales_total_currency,
    payment_category = p_payment_category, remarks = nullif(btrim(p_remarks), ''),
    workflow_id = v_workflow_id,
    version = target.version + 1, updated_by = v_actor.id
  where target.id = p_order_id
  returning target.id, target.version into id, version;
  return next;
end;
$$;
revoke all on function public.update_finance_daily_order(uuid, int, date, uuid, uuid, text, date, text, public.daily_order_shipping_category, uuid, numeric, numeric, public.currency_code, numeric, public.currency_code, numeric, public.currency_code, numeric, public.currency_code, public.daily_order_payment_category, text) from public;
grant execute on function public.update_finance_daily_order(uuid, int, date, uuid, uuid, text, date, text, public.daily_order_shipping_category, uuid, numeric, numeric, public.currency_code, numeric, public.currency_code, numeric, public.currency_code, numeric, public.currency_code, public.daily_order_payment_category, text) to authenticated;

-- ------------------------------------------------------------
-- 10) 工作流 RPC
-- ------------------------------------------------------------

-- 10a) 业务认领订单
create or replace function public.claim_daily_order_workflow(p_workflow_id uuid, p_expected_version int)
returns public.finance_daily_order_workflows
language plpgsql
security definer
set search_path = public
as $$
declare v_actor public.profiles%rowtype; v_wf public.finance_daily_order_workflows%rowtype;
begin
  v_actor := public.assert_daily_order_sales_actor();
  select * into v_wf from public.finance_daily_order_workflows where id = p_workflow_id for update;
  if not found then raise exception 'Workflow does not exist'; end if;
  if v_wf.salesperson_id <> v_actor.id then raise exception 'This order does not belong to you'; end if;
  if v_wf.version <> p_expected_version then raise exception 'Workflow version conflict'; end if;
  if v_wf.status <> 'unclaimed' then raise exception 'Order has already been claimed'; end if;
  update public.finance_daily_order_workflows set
    status = 'claimed', claimed_at = now(), version = version + 1
  where id = p_workflow_id returning * into v_wf;
  perform public.write_daily_order_workflow_audit(p_workflow_id, 'claim', v_actor.id, '{}'::jsonb);
  return v_wf;
end;
$$;
revoke all on function public.claim_daily_order_workflow(uuid, int) from public;
grant execute on function public.claim_daily_order_workflow(uuid, int) to authenticated;

-- 10b) 绑定客户（业务本人：claimed/rejected；财务/管理员：除 approved 外均可）
create or replace function public.bind_daily_order_workflow_customer(
  p_workflow_id uuid, p_expected_version int, p_customer_id uuid
)
returns public.finance_daily_order_workflows
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_me public.profiles%rowtype;
  v_wf public.finance_daily_order_workflows%rowtype;
  v_customer public.customers%rowtype;
  v_is_finance boolean;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  select * into v_me from public.profiles where id = v_uid;
  if not found or v_me.status::text <> 'approved' then raise exception 'Account is not approved'; end if;
  v_is_finance := v_me.role::text in ('admin', 'finance');

  select * into v_wf from public.finance_daily_order_workflows where id = p_workflow_id for update;
  if not found then raise exception 'Workflow does not exist'; end if;
  if v_wf.version <> p_expected_version then raise exception 'Workflow version conflict'; end if;

  if v_is_finance then
    if v_wf.status = 'approved' then raise exception 'Approved orders cannot rebind customers'; end if;
  else
    if v_me.role::text <> 'sales' then raise exception 'Only sales, finance, or admin can bind customers'; end if;
    if v_wf.salesperson_id <> v_uid then raise exception 'This order does not belong to you'; end if;
    if v_wf.status not in ('claimed', 'rejected') then raise exception 'Customer can only be bound after claiming and before performance approval'; end if;
  end if;

  select * into v_customer from public.customers where id = p_customer_id;
  if not found then raise exception 'Customer does not exist'; end if;

  update public.finance_daily_order_workflows set
    customer_id = v_customer.id,
    customer_name_snapshot = left(coalesce(nullif(btrim(v_customer.name), ''), nullif(btrim(v_customer.company), ''), '客户'), 300),
    version = version + 1
  where id = p_workflow_id returning * into v_wf;
  perform public.write_daily_order_workflow_audit(
    p_workflow_id, 'bind_customer', v_uid,
    jsonb_build_object('customer_id', v_customer.id, 'customer_name', v_wf.customer_name_snapshot)
  );
  return v_wf;
end;
$$;
revoke all on function public.bind_daily_order_workflow_customer(uuid, int, uuid) from public;
grant execute on function public.bind_daily_order_workflow_customer(uuid, int, uuid) to authenticated;

-- 10c) 业务提交业绩审核（要求已绑定客户）
create or replace function public.submit_daily_order_performance(p_workflow_id uuid, p_expected_version int)
returns public.finance_daily_order_workflows
language plpgsql
security definer
set search_path = public
as $$
declare v_actor public.profiles%rowtype; v_wf public.finance_daily_order_workflows%rowtype;
begin
  v_actor := public.assert_daily_order_sales_actor();
  select * into v_wf from public.finance_daily_order_workflows where id = p_workflow_id for update;
  if not found then raise exception 'Workflow does not exist'; end if;
  if v_wf.salesperson_id <> v_actor.id then raise exception 'This order does not belong to you'; end if;
  if v_wf.version <> p_expected_version then raise exception 'Workflow version conflict'; end if;
  if v_wf.status not in ('claimed', 'rejected') then raise exception 'Only claimed or rejected orders can be submitted'; end if;
  if v_wf.customer_id is null then raise exception 'Bind a customer before submitting for review'; end if;
  update public.finance_daily_order_workflows set
    status = 'submitted', submitted_at = now(), review_reason = null, version = version + 1
  where id = p_workflow_id returning * into v_wf;
  perform public.write_daily_order_workflow_audit(p_workflow_id, 'submit', v_actor.id, '{}'::jsonb);
  return v_wf;
end;
$$;
revoke all on function public.submit_daily_order_performance(uuid, int) from public;
grant execute on function public.submit_daily_order_performance(uuid, int) to authenticated;

-- 10d) 财务/管理员审核业绩（approve / reject，reject 需理由）
create or replace function public.review_daily_order_performance(
  p_workflow_id uuid, p_expected_version int, p_approve boolean, p_reason text
)
returns public.finance_daily_order_workflows
language plpgsql
security definer
set search_path = public
as $$
declare v_actor public.profiles%rowtype; v_wf public.finance_daily_order_workflows%rowtype;
begin
  v_actor := public.assert_daily_order_finance_actor();
  select * into v_wf from public.finance_daily_order_workflows where id = p_workflow_id for update;
  if not found then raise exception 'Workflow does not exist'; end if;
  if v_wf.version <> p_expected_version then raise exception 'Workflow version conflict'; end if;
  if v_wf.status <> 'submitted' then raise exception 'Only submitted orders can be reviewed'; end if;
  if p_approve then
    update public.finance_daily_order_workflows set
      status = 'approved', reviewed_at = now(), reviewed_by = v_actor.id, review_reason = null, version = version + 1
    where id = p_workflow_id returning * into v_wf;
    perform public.write_daily_order_workflow_audit(p_workflow_id, 'approve', v_actor.id, '{}'::jsonb);
  else
    if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'A reason is required to reject'; end if;
    if char_length(p_reason) > 2000 then raise exception 'Reason is too long'; end if;
    update public.finance_daily_order_workflows set
      status = 'rejected', reviewed_at = now(), reviewed_by = v_actor.id, review_reason = btrim(p_reason), version = version + 1
    where id = p_workflow_id returning * into v_wf;
    perform public.write_daily_order_workflow_audit(p_workflow_id, 'reject', v_actor.id, jsonb_build_object('reason', btrim(p_reason)));
  end if;
  return v_wf;
end;
$$;
revoke all on function public.review_daily_order_performance(uuid, int, boolean, text) from public;
grant execute on function public.review_daily_order_performance(uuid, int, boolean, text) to authenticated;

-- 10e) 财务/管理员填写/更新提成（要求业绩已 approved）
create or replace function public.save_daily_order_commission(
  p_workflow_id uuid, p_commission_amount numeric, p_commission_currency public.currency_code, p_remarks text
)
returns public.finance_daily_order_commissions
language plpgsql
security definer
set search_path = public
as $$
declare v_actor public.profiles%rowtype; v_wf public.finance_daily_order_workflows%rowtype; v_row public.finance_daily_order_commissions%rowtype;
begin
  v_actor := public.assert_daily_order_finance_actor();
  select * into v_wf from public.finance_daily_order_workflows where id = p_workflow_id for update;
  if not found then raise exception 'Workflow does not exist'; end if;
  if v_wf.status <> 'approved' then raise exception 'Commission can only be recorded after performance approval'; end if;
  if p_commission_amount is null or p_commission_amount < 0 or p_commission_amount > 999999999999 or p_commission_amount <> round(p_commission_amount, 2) then
    raise exception 'Commission amount must be non-negative and within 2 decimal places';
  end if;
  if p_commission_currency::text not in ('CNY', 'USD') then raise exception 'Unsupported commission currency'; end if;
  if char_length(coalesce(p_remarks, '')) > 2000 then raise exception 'Remarks are too long'; end if;

  insert into public.finance_daily_order_commissions(workflow_id, commission_amount, commission_currency, remarks, created_by, updated_by)
    values (p_workflow_id, p_commission_amount, p_commission_currency, nullif(btrim(p_remarks), ''), v_actor.id, v_actor.id)
  on conflict (workflow_id) do update set
    commission_amount = excluded.commission_amount,
    commission_currency = excluded.commission_currency,
    remarks = excluded.remarks,
    updated_by = v_actor.id
  returning * into v_row;
  perform public.write_daily_order_workflow_audit(
    p_workflow_id, 'commission_saved', v_actor.id,
    jsonb_build_object('amount', p_commission_amount, 'currency', p_commission_currency::text)
  );
  return v_row;
end;
$$;
revoke all on function public.save_daily_order_commission(uuid, numeric, public.currency_code, text) from public;
grant execute on function public.save_daily_order_commission(uuid, numeric, public.currency_code, text) to authenticated;

-- 10f) 业务发起订单字段改动申请（白名单字段，一订单行仅一条待审）
create or replace function public.request_daily_order_change(p_order_id uuid, p_payload jsonb)
returns public.finance_daily_order_change_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_order public.finance_daily_orders%rowtype;
  v_wf public.finance_daily_order_workflows%rowtype;
  v_row public.finance_daily_order_change_requests%rowtype;
begin
  v_actor := public.assert_daily_order_sales_actor();
  perform public.validate_daily_order_change_payload(p_payload);

  select * into v_order from public.finance_daily_orders where id = p_order_id;
  if not found then raise exception 'Daily order does not exist'; end if;
  if v_order.status <> 'active' then raise exception 'Voided order cannot be changed'; end if;
  if v_order.workflow_id is null then raise exception 'Order has no workflow to attribute the change'; end if;

  select * into v_wf from public.finance_daily_order_workflows where id = v_order.workflow_id;
  if not found or v_wf.salesperson_id <> v_actor.id then raise exception 'This order does not belong to you'; end if;
  if v_wf.status = 'unclaimed' then raise exception 'Claim the order before requesting changes'; end if;

  if exists (select 1 from public.finance_daily_order_change_requests where order_id = p_order_id and status = 'pending') then
    raise exception 'A pending change request already exists for this order line';
  end if;

  insert into public.finance_daily_order_change_requests(order_id, workflow_id, status, payload, requested_by)
    values (p_order_id, v_order.workflow_id, 'pending', p_payload, v_actor.id)
  returning * into v_row;
  perform public.write_daily_order_workflow_audit(
    v_order.workflow_id, 'change_requested', v_actor.id,
    jsonb_build_object('order_id', p_order_id, 'change_id', v_row.id)
  );
  return v_row;
end;
$$;
revoke all on function public.request_daily_order_change(uuid, jsonb) from public;
grant execute on function public.request_daily_order_change(uuid, jsonb) to authenticated;

-- 10g) 财务/管理员审核改动申请（approve 时才写回订单行；reject 需理由）
create or replace function public.review_daily_order_change(
  p_change_id uuid, p_approve boolean, p_reason text
)
returns public.finance_daily_order_change_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_change public.finance_daily_order_change_requests%rowtype;
  v_order public.finance_daily_orders%rowtype;
  v_p jsonb;
begin
  v_actor := public.assert_daily_order_finance_actor();
  select * into v_change from public.finance_daily_order_change_requests where id = p_change_id for update;
  if not found then raise exception 'Change request does not exist'; end if;
  if v_change.status <> 'pending' then raise exception 'Change request is no longer pending'; end if;
  v_p := v_change.payload;

  if p_approve then
    perform public.validate_daily_order_change_payload(v_p);
    select * into v_order from public.finance_daily_orders where id = v_change.order_id for update;
    if not found then raise exception 'Daily order does not exist'; end if;
    if v_order.status <> 'active' then raise exception 'Voided order cannot be changed'; end if;

    update public.finance_daily_orders o set
      shipping_date = case when v_p ? 'shipping_date' then (v_p->>'shipping_date')::date else o.shipping_date end,
      shipping_number = case when v_p ? 'shipping_number' then nullif(btrim(v_p->>'shipping_number'), '') else o.shipping_number end,
      shipping_category = case when v_p ? 'shipping_category' then (v_p->>'shipping_category')::public.daily_order_shipping_category else o.shipping_category end,
      quantity = case when v_p ? 'quantity' then (v_p->>'quantity')::numeric else o.quantity end,
      sales_unit_price_amount = case when v_p ? 'sales_unit_price_amount' then (v_p->>'sales_unit_price_amount')::numeric else o.sales_unit_price_amount end,
      sales_unit_price_currency = case when v_p ? 'sales_unit_price_currency' then (v_p->>'sales_unit_price_currency')::public.currency_code else o.sales_unit_price_currency end,
      product_received_amount = case when v_p ? 'product_received_amount' then (v_p->>'product_received_amount')::numeric else o.product_received_amount end,
      product_received_currency = case when v_p ? 'product_received_currency' then (v_p->>'product_received_currency')::public.currency_code else o.product_received_currency end,
      logistics_fee_amount = case when v_p ? 'logistics_fee_amount' then (v_p->>'logistics_fee_amount')::numeric else o.logistics_fee_amount end,
      logistics_fee_currency = case when v_p ? 'logistics_fee_currency' then (v_p->>'logistics_fee_currency')::public.currency_code else o.logistics_fee_currency end,
      sales_total_amount = case when v_p ? 'sales_total_amount' then (v_p->>'sales_total_amount')::numeric else o.sales_total_amount end,
      sales_total_currency = case when v_p ? 'sales_total_currency' then (v_p->>'sales_total_currency')::public.currency_code else o.sales_total_currency end,
      payment_category = case when v_p ? 'payment_category' then (v_p->>'payment_category')::public.daily_order_payment_category else o.payment_category end,
      remarks = case when v_p ? 'remarks' then nullif(btrim(v_p->>'remarks'), '') else o.remarks end,
      version = o.version + 1, updated_by = v_actor.id
    where o.id = v_change.order_id;

    update public.finance_daily_order_change_requests set
      status = 'approved', reviewed_at = now(), reviewed_by = v_actor.id, review_reason = null
    where id = p_change_id returning * into v_change;
    perform public.write_daily_order_workflow_audit(
      v_change.workflow_id, 'change_approved', v_actor.id,
      jsonb_build_object('order_id', v_change.order_id, 'change_id', p_change_id)
    );
  else
    if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'A reason is required to reject'; end if;
    if char_length(p_reason) > 2000 then raise exception 'Reason is too long'; end if;
    update public.finance_daily_order_change_requests set
      status = 'rejected', reviewed_at = now(), reviewed_by = v_actor.id, review_reason = btrim(p_reason)
    where id = p_change_id returning * into v_change;
    perform public.write_daily_order_workflow_audit(
      v_change.workflow_id, 'change_rejected', v_actor.id,
      jsonb_build_object('order_id', v_change.order_id, 'change_id', p_change_id, 'reason', btrim(p_reason))
    );
  end if;
  return v_change;
end;
$$;
revoke all on function public.review_daily_order_change(uuid, boolean, text) from public;
grant execute on function public.review_daily_order_change(uuid, boolean, text) to authenticated;

-- 10h) 业务撤销自己的待审改动申请
create or replace function public.cancel_daily_order_change(p_change_id uuid)
returns public.finance_daily_order_change_requests
language plpgsql
security definer
set search_path = public
as $$
declare v_actor public.profiles%rowtype; v_change public.finance_daily_order_change_requests%rowtype;
begin
  v_actor := public.assert_daily_order_sales_actor();
  select * into v_change from public.finance_daily_order_change_requests where id = p_change_id for update;
  if not found then raise exception 'Change request does not exist'; end if;
  if v_change.requested_by is distinct from v_actor.id then raise exception 'This change request does not belong to you'; end if;
  if v_change.status <> 'pending' then raise exception 'Only pending change requests can be cancelled'; end if;
  update public.finance_daily_order_change_requests set
    status = 'cancelled', reviewed_at = now()
  where id = p_change_id returning * into v_change;
  perform public.write_daily_order_workflow_audit(
    v_change.workflow_id, 'change_cancelled', v_actor.id,
    jsonb_build_object('order_id', v_change.order_id, 'change_id', p_change_id)
  );
  return v_change;
end;
$$;
revoke all on function public.cancel_daily_order_change(uuid) from public;
grant execute on function public.cancel_daily_order_change(uuid) to authenticated;

-- ------------------------------------------------------------
-- 11) RLS：新表启用行级安全，写操作全部走 RPC
-- ------------------------------------------------------------
alter table public.finance_daily_order_workflows enable row level security;
alter table public.finance_daily_order_commissions enable row level security;
alter table public.finance_daily_order_change_requests enable row level security;
alter table public.finance_daily_order_workflow_audit_logs enable row level security;

revoke all on table public.finance_daily_order_workflows, public.finance_daily_order_commissions,
  public.finance_daily_order_change_requests, public.finance_daily_order_workflow_audit_logs from anon, authenticated;
grant select on table public.finance_daily_order_workflows, public.finance_daily_order_commissions,
  public.finance_daily_order_change_requests, public.finance_daily_order_workflow_audit_logs to authenticated;

-- 工作流头：财务/管理员全量；业务本人；主管可见下属
drop policy if exists "daily_order_workflows_select" on public.finance_daily_order_workflows;
create policy "daily_order_workflows_select" on public.finance_daily_order_workflows
  for select to authenticated
  using (
    public.is_finance_or_admin()
    or salesperson_id = (select auth.uid())
    or public.is_my_subordinate(salesperson_id)
  );

-- 提成：仅财务/管理员可读（业务与主管均不可见）
drop policy if exists "daily_order_commissions_select" on public.finance_daily_order_commissions;
create policy "daily_order_commissions_select" on public.finance_daily_order_commissions
  for select to authenticated
  using (public.is_finance_or_admin());

-- 改动申请：财务/管理员全量；发起人本人；主管可见下属发起的
drop policy if exists "daily_order_change_requests_select" on public.finance_daily_order_change_requests;
create policy "daily_order_change_requests_select" on public.finance_daily_order_change_requests
  for select to authenticated
  using (
    public.is_finance_or_admin()
    or requested_by = (select auth.uid())
    or public.is_my_subordinate(requested_by)
  );

-- 工作流审计：仅财务/管理员可读
drop policy if exists "daily_order_workflow_audit_select" on public.finance_daily_order_workflow_audit_logs;
create policy "daily_order_workflow_audit_select" on public.finance_daily_order_workflow_audit_logs
  for select to authenticated
  using (public.is_finance_or_admin());

-- ------------------------------------------------------------
-- 12) 扩展既有 SELECT 策略：业务可见自己名下的订单行与截图（仅追加 or 分支）
-- ------------------------------------------------------------
drop policy if exists "daily_orders_select" on public.finance_daily_orders;
create policy "daily_orders_select" on public.finance_daily_orders
  for select to authenticated
  using (
    public.is_finance_or_admin()
    or salesperson_id = (select auth.uid())
    or public.is_my_subordinate(salesperson_id)
  );

drop policy if exists "daily_order_screenshots_select" on public.finance_daily_order_screenshots;
create policy "daily_order_screenshots_select" on public.finance_daily_order_screenshots
  for select to authenticated
  using (
    public.is_finance_or_admin()
    or exists (
      select 1
      from public.finance_daily_orders o
      where o.id = finance_daily_order_screenshots.order_id
        and (
          o.salesperson_id = (select auth.uid())
          or public.is_my_subordinate(o.salesperson_id)
        )
    )
  );

drop policy if exists "finance_daily_order_screenshots_select" on storage.objects;
create policy "finance_daily_order_screenshots_select" on storage.objects for select to authenticated
using (
  bucket_id = 'finance-daily-order-screenshots'
  and array_length(storage.foldername(name), 1) = 2
  and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$'
  and (
    public.is_finance_or_admin()
    or exists (
      select 1
      from public.finance_daily_orders o
      where o.id = ((storage.foldername(name))[2])::uuid
        and (
          o.salesperson_id = (select auth.uid())
          or public.is_my_subordinate(o.salesperson_id)
        )
    )
  )
);
