-- 0025_daily_order_totals.sql
-- 为每日订单工作流头保存订单级总额；产品明细金额字段保持不变。

alter table public.finance_daily_order_workflows
  add column if not exists total_product_received_amount numeric(18,2) not null default 0,
  add column if not exists total_product_received_currency public.currency_code not null default 'CNY',
  add column if not exists total_product_received_overridden boolean not null default false,
  add column if not exists total_shipping_received_amount numeric(18,2) not null default 0,
  add column if not exists total_shipping_received_currency public.currency_code not null default 'CNY',
  add column if not exists total_shipping_received_overridden boolean not null default false,
  add column if not exists total_sales_amount numeric(18,2) not null default 0,
  add column if not exists total_sales_currency public.currency_code not null default 'CNY',
  add column if not exists total_sales_overridden boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'fdo_workflow_total_product_received_check'
      and conrelid = 'public.finance_daily_order_workflows'::regclass
  ) then
    alter table public.finance_daily_order_workflows
      add constraint fdo_workflow_total_product_received_check
      check (total_product_received_amount >= 0 and total_product_received_amount <= 999999999999);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'fdo_workflow_total_shipping_received_check'
      and conrelid = 'public.finance_daily_order_workflows'::regclass
  ) then
    alter table public.finance_daily_order_workflows
      add constraint fdo_workflow_total_shipping_received_check
      check (total_shipping_received_amount >= 0 and total_shipping_received_amount <= 999999999999);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'fdo_workflow_total_sales_check'
      and conrelid = 'public.finance_daily_order_workflows'::regclass
  ) then
    alter table public.finance_daily_order_workflows
      add constraint fdo_workflow_total_sales_check
      check (total_sales_amount >= 0 and total_sales_amount <= 999999999999);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'fdo_workflow_total_currencies_check'
      and conrelid = 'public.finance_daily_order_workflows'::regclass
  ) then
    alter table public.finance_daily_order_workflows
      add constraint fdo_workflow_total_currencies_check check (
        total_product_received_currency::text in ('CNY', 'USD')
        and total_shipping_received_currency::text in ('CNY', 'USD')
        and total_sales_currency::text in ('CNY', 'USD')
      );
  end if;
end;
$$;

comment on column public.finance_daily_order_workflows.total_product_received_amount is '订单级总产品实收金额，可在创建订单时覆盖明细自动加总值';
comment on column public.finance_daily_order_workflows.total_shipping_received_amount is '订单级总运费实收金额，可在创建订单时覆盖明细自动加总值';
comment on column public.finance_daily_order_workflows.total_sales_amount is '订单级销售总金额，可在创建订单时覆盖明细自动加总值';

-- 在查找或创建订单头前先取得汇总全局锁，避免 workflow 唯一键锁与汇总锁形成反向等待。
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
  perform pg_advisory_xact_lock(hashtext('finance_daily_order_totals')::bigint);
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

-- 所有产品行写路径共用的汇总器：拒绝混合币种，只刷新未人工覆盖的字段。
create or replace function public.refresh_daily_order_workflow_totals(p_workflow_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_amount numeric;
  v_product_currency public.currency_code;
  v_product_currency_count bigint;
  v_shipping_amount numeric;
  v_shipping_currency public.currency_code;
  v_shipping_currency_count bigint;
  v_sales_amount numeric;
  v_sales_currency public.currency_code;
  v_sales_currency_count bigint;
begin
  if p_workflow_id is null then return; end if;

  -- 所有订单头汇总共用同一事务级锁，避免跨订单批量写入时因锁顺序相反产生死锁。
  perform pg_advisory_xact_lock(hashtext('finance_daily_order_totals')::bigint);
  perform 1
  from public.finance_daily_order_workflows as workflows
  where workflows.id = p_workflow_id;
  if not found then return; end if;

  select
    coalesce(sum(orders.product_received_amount), 0),
    coalesce(min(orders.product_received_currency::text), 'CNY')::public.currency_code,
    count(distinct orders.product_received_currency),
    coalesce(sum(orders.logistics_fee_amount), 0),
    coalesce(min(orders.logistics_fee_currency::text), 'CNY')::public.currency_code,
    count(distinct orders.logistics_fee_currency),
    coalesce(sum(orders.sales_total_amount), 0),
    coalesce(min(orders.sales_total_currency::text), 'CNY')::public.currency_code,
    count(distinct orders.sales_total_currency)
  into
    v_product_amount, v_product_currency, v_product_currency_count,
    v_shipping_amount, v_shipping_currency, v_shipping_currency_count,
    v_sales_amount, v_sales_currency, v_sales_currency_count
  from public.finance_daily_orders as orders
  where orders.workflow_id = p_workflow_id and orders.status = 'active';

  if v_product_currency_count > 1 or v_shipping_currency_count > 1 or v_sales_currency_count > 1 then
    raise exception 'Order total currencies must match across product lines';
  end if;

  update public.finance_daily_order_workflows as workflows
  set
    total_product_received_amount = case when workflows.total_product_received_overridden then workflows.total_product_received_amount else v_product_amount end,
    total_product_received_currency = case when workflows.total_product_received_overridden then workflows.total_product_received_currency else v_product_currency end,
    total_shipping_received_amount = case when workflows.total_shipping_received_overridden then workflows.total_shipping_received_amount else v_shipping_amount end,
    total_shipping_received_currency = case when workflows.total_shipping_received_overridden then workflows.total_shipping_received_currency else v_shipping_currency end,
    total_sales_amount = case when workflows.total_sales_overridden then workflows.total_sales_amount else v_sales_amount end,
    total_sales_currency = case when workflows.total_sales_overridden then workflows.total_sales_currency else v_sales_currency end
  where workflows.id = p_workflow_id;
end;
$$;
revoke all on function public.refresh_daily_order_workflow_totals(uuid) from public, anon, authenticated, service_role;

create or replace function public.sync_daily_order_workflow_totals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.refresh_daily_order_workflow_totals(old.workflow_id);
    return old;
  end if;
  if tg_op = 'INSERT' then
    perform public.refresh_daily_order_workflow_totals(new.workflow_id);
    return new;
  end if;
  if new.workflow_id is distinct from old.workflow_id then
    perform public.refresh_daily_order_workflow_totals(old.workflow_id);
  end if;
  perform public.refresh_daily_order_workflow_totals(new.workflow_id);
  return new;
end;
$$;
revoke all on function public.sync_daily_order_workflow_totals() from public, anon, authenticated, service_role;

drop trigger if exists trg_daily_orders_sync_workflow_totals on public.finance_daily_orders;
create trigger trg_daily_orders_sync_workflow_totals
  after insert or delete or update of workflow_id, status,
    product_received_amount, product_received_currency,
    logistics_fee_amount, logistics_fee_currency,
    sales_total_amount, sales_total_currency
  on public.finance_daily_orders
  for each row execute function public.sync_daily_order_workflow_totals();

-- 触发器安装后做最终历史对账；CREATE TRIGGER 会等待在途写事务结束，之后的新写入均由触发器维护。
-- 各金额字段独立处理，历史混合币种字段保留默认值，避免在没有汇率时错误相加。
with totals as (
  select
    workflows.id as workflow_id,
    coalesce(sum(orders.product_received_amount) filter (where orders.status = 'active'), 0) as product_amount,
    coalesce(min(orders.product_received_currency::text) filter (where orders.status = 'active'), 'CNY')::public.currency_code as product_currency,
    count(distinct orders.product_received_currency) filter (where orders.status = 'active') as product_currency_count,
    coalesce(sum(orders.logistics_fee_amount) filter (where orders.status = 'active'), 0) as shipping_amount,
    coalesce(min(orders.logistics_fee_currency::text) filter (where orders.status = 'active'), 'CNY')::public.currency_code as shipping_currency,
    count(distinct orders.logistics_fee_currency) filter (where orders.status = 'active') as shipping_currency_count,
    coalesce(sum(orders.sales_total_amount) filter (where orders.status = 'active'), 0) as sales_amount,
    coalesce(min(orders.sales_total_currency::text) filter (where orders.status = 'active'), 'CNY')::public.currency_code as sales_currency,
    count(distinct orders.sales_total_currency) filter (where orders.status = 'active') as sales_currency_count
  from public.finance_daily_order_workflows as workflows
  left join public.finance_daily_orders as orders on orders.workflow_id = workflows.id
  group by workflows.id
)
update public.finance_daily_order_workflows as workflows
set
  total_product_received_amount = case when not workflows.total_product_received_overridden and totals.product_currency_count <= 1 then totals.product_amount else workflows.total_product_received_amount end,
  total_product_received_currency = case when not workflows.total_product_received_overridden and totals.product_currency_count <= 1 then totals.product_currency else workflows.total_product_received_currency end,
  total_shipping_received_amount = case when not workflows.total_shipping_received_overridden and totals.shipping_currency_count <= 1 then totals.shipping_amount else workflows.total_shipping_received_amount end,
  total_shipping_received_currency = case when not workflows.total_shipping_received_overridden and totals.shipping_currency_count <= 1 then totals.shipping_currency else workflows.total_shipping_received_currency end,
  total_sales_amount = case when not workflows.total_sales_overridden and totals.sales_currency_count <= 1 then totals.sales_amount else workflows.total_sales_amount end,
  total_sales_currency = case when not workflows.total_sales_overridden and totals.sales_currency_count <= 1 then totals.sales_currency else workflows.total_sales_currency end
from totals
where workflows.id = totals.workflow_id;

-- 新建单据专用：批量创建产品行后，仅用用户确实修改过的总额覆盖自动汇总值。
create or replace function public.bulk_create_finance_daily_orders_with_totals(p_rows jsonb, p_totals jsonb)
returns table (id uuid, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created record;
  v_ids uuid[] := array[]::uuid[];
  v_workflow_id uuid;
  v_workflow_count int;
  v_product_amount numeric;
  v_shipping_amount numeric;
  v_sales_amount numeric;
  v_product_currency public.currency_code;
  v_shipping_currency public.currency_code;
  v_sales_currency public.currency_code;
  v_product_overridden boolean;
  v_shipping_overridden boolean;
  v_sales_overridden boolean;
begin
  perform public.assert_daily_order_finance_actor();
  if p_totals is null or jsonb_typeof(p_totals) <> 'object' then
    raise exception 'Order totals must be an object';
  end if;
  if not (p_totals ?& array[
    'total_product_received_amount', 'total_product_received_currency', 'total_product_received_overridden',
    'total_shipping_received_amount', 'total_shipping_received_currency', 'total_shipping_received_overridden',
    'total_sales_amount', 'total_sales_currency', 'total_sales_overridden'
  ]) then
    raise exception 'Order totals are incomplete';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_totals) as fields(key)
    where fields.key not in (
      'total_product_received_amount', 'total_product_received_currency', 'total_product_received_overridden',
      'total_shipping_received_amount', 'total_shipping_received_currency', 'total_shipping_received_overridden',
      'total_sales_amount', 'total_sales_currency', 'total_sales_overridden'
    )
  ) then
    raise exception 'Order totals contain unsupported fields';
  end if;

  v_product_amount := (p_totals->>'total_product_received_amount')::numeric;
  v_shipping_amount := (p_totals->>'total_shipping_received_amount')::numeric;
  v_sales_amount := (p_totals->>'total_sales_amount')::numeric;
  if v_product_amount < 0 or v_product_amount > 999999999999 or v_product_amount <> round(v_product_amount, 2)
     or v_shipping_amount < 0 or v_shipping_amount > 999999999999 or v_shipping_amount <> round(v_shipping_amount, 2)
     or v_sales_amount < 0 or v_sales_amount > 999999999999 or v_sales_amount <> round(v_sales_amount, 2)
  then
    raise exception 'Order totals must be non-negative and within 2 decimal places';
  end if;
  if p_totals->>'total_product_received_currency' not in ('CNY', 'USD')
     or p_totals->>'total_shipping_received_currency' not in ('CNY', 'USD')
     or p_totals->>'total_sales_currency' not in ('CNY', 'USD')
  then
    raise exception 'Order total currencies must be CNY or USD';
  end if;
  v_product_currency := (p_totals->>'total_product_received_currency')::public.currency_code;
  v_shipping_currency := (p_totals->>'total_shipping_received_currency')::public.currency_code;
  v_sales_currency := (p_totals->>'total_sales_currency')::public.currency_code;
  v_product_overridden := (p_totals->>'total_product_received_overridden')::boolean;
  v_shipping_overridden := (p_totals->>'total_shipping_received_overridden')::boolean;
  v_sales_overridden := (p_totals->>'total_sales_overridden')::boolean;
  if v_product_overridden is null or v_shipping_overridden is null or v_sales_overridden is null then
    raise exception 'Order total override flags are required';
  end if;

  for v_created in select * from public.bulk_create_finance_daily_orders(p_rows) loop
    v_ids := array_append(v_ids, v_created.id);
    id := v_created.id;
    version := v_created.version;
    return next;
  end loop;

  select count(distinct orders.workflow_id), min(orders.workflow_id::text)::uuid
  into v_workflow_count, v_workflow_id
  from public.finance_daily_orders as orders
  where orders.id = any(v_ids);
  if v_workflow_count <> 1 or v_workflow_id is null then
    raise exception 'Rows with explicit order totals must belong to one order';
  end if;

  perform 1
  from public.finance_daily_order_workflows as workflows
  where workflows.id = v_workflow_id
  for update;

  update public.finance_daily_order_workflows as workflows
  set
    total_product_received_amount = case when v_product_overridden then v_product_amount else workflows.total_product_received_amount end,
    total_product_received_currency = case when v_product_overridden then v_product_currency else workflows.total_product_received_currency end,
    total_product_received_overridden = workflows.total_product_received_overridden or v_product_overridden,
    total_shipping_received_amount = case when v_shipping_overridden then v_shipping_amount else workflows.total_shipping_received_amount end,
    total_shipping_received_currency = case when v_shipping_overridden then v_shipping_currency else workflows.total_shipping_received_currency end,
    total_shipping_received_overridden = workflows.total_shipping_received_overridden or v_shipping_overridden,
    total_sales_amount = case when v_sales_overridden then v_sales_amount else workflows.total_sales_amount end,
    total_sales_currency = case when v_sales_overridden then v_sales_currency else workflows.total_sales_currency end,
    total_sales_overridden = workflows.total_sales_overridden or v_sales_overridden
  where workflows.id = v_workflow_id;
end;
$$;
revoke all on function public.bulk_create_finance_daily_orders_with_totals(jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.bulk_create_finance_daily_orders_with_totals(jsonb, jsonb) to authenticated;
