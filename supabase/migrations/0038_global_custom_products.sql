-- 0038_global_custom_products.sql
-- 定制产品改为全局产品库；旧客户字段仅为历史兼容保留，不再参与权限、读取或订单可用性判断。

begin;

-- -----------------------------------------------------------------------------
-- 1. 全局定制产品与不可变版本字段
-- -----------------------------------------------------------------------------
alter table public.business_custom_products
  alter column customer_id drop not null;

drop trigger if exists trg_custom_products_current_customer
  on public.business_custom_products;

drop index if exists public.idx_business_custom_products_customer_active;
drop index if exists public.idx_business_custom_products_shared_active;
create index idx_business_custom_products_active
  on public.business_custom_products (is_archived, updated_at desc);

alter table public.business_custom_product_versions
  add column product_group_id uuid references public.product_groups(id) on delete restrict,
  add column quantity numeric(18,4),
  add column received_amount numeric(18,2);

alter table public.business_custom_product_versions
  add column order_amount numeric(18,2) generated always as (
    case
      when quantity is null then null
      else round(quantity * default_unit_price, 2)
    end
  ) stored,
  add column outstanding_amount numeric(18,2) generated always as (
    case
      when quantity is null then null
      else round((quantity * default_unit_price) - coalesce(received_amount, 0), 2)
    end
  ) stored,
  add constraint business_custom_product_versions_quantity_check
    check (quantity is null or (quantity > 0 and quantity <= 999999999999)),
  add constraint business_custom_product_versions_received_amount_check
    check (received_amount is null or (
      received_amount >= 0 and received_amount <= 999999999999
    ));

create index idx_business_custom_product_versions_group
  on public.business_custom_product_versions (product_group_id, created_at desc)
  where product_group_id is not null;

comment on table public.business_custom_products is
  '全局定制产品身份；客户归属及共享字段仅保留历史兼容，不参与当前业务逻辑';
comment on table public.business_custom_product_versions is
  '全局定制产品不可变版本；订单金额与未收尾款由版本数量、单价及实收金额确定性计算';

-- -----------------------------------------------------------------------------
-- 2. 全局读取权限
-- -----------------------------------------------------------------------------
alter table public.business_custom_products enable row level security;
alter table public.business_custom_product_versions enable row level security;

drop policy if exists "business_custom_products_select" on public.business_custom_products;
create policy "business_custom_products_select" on public.business_custom_products
  for select to authenticated
  using (exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.status::text = 'approved'
      and p.role::text in ('sales', 'supervisor', 'admin', 'finance')
  ));

drop policy if exists "business_custom_product_versions_select"
  on public.business_custom_product_versions;
create policy "business_custom_product_versions_select"
  on public.business_custom_product_versions
  for select to authenticated
  using (exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.status::text = 'approved'
      and p.role::text in ('sales', 'supervisor', 'admin', 'finance')
  ));

-- -----------------------------------------------------------------------------
-- 3. 全局定制产品 RPC
-- -----------------------------------------------------------------------------
-- 旧产品创建函数依赖旧版本创建函数，必须先删除调用方。
drop function if exists public.create_business_custom_product(uuid, jsonb, boolean);
drop function if exists public.add_business_custom_product_version(
  uuid, text, text, text, text, text, text, numeric, public.currency_code
);
drop function if exists public.set_business_custom_product_state(uuid, boolean, boolean, text);
drop function if exists public.list_business_custom_products_for_customer(uuid);
drop function if exists public.list_business_custom_products_library(text, uuid, text, text);

create function public.add_business_custom_product_version(
  p_custom_product_id uuid,
  p_product_group_id uuid,
  p_code text,
  p_name text,
  p_description text,
  p_specification text,
  p_unit text,
  p_image_url text,
  p_default_unit_price numeric,
  p_default_currency public.currency_code,
  p_quantity numeric,
  p_received_amount numeric
)
returns public.business_custom_product_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_product public.business_custom_products%rowtype;
  v_version public.business_custom_product_versions%rowtype;
  v_version_no int;
begin
  select * into v_actor from public.profiles where id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved business role required to create custom product versions';
  end if;

  select * into v_product
  from public.business_custom_products
  where id = p_custom_product_id
  for update;
  if not found then
    raise exception 'Custom product does not exist';
  end if;
  if v_product.is_archived then
    raise exception 'Archived custom product cannot receive a new version';
  end if;

  if p_product_group_id is null or not exists (
    select 1 from public.product_groups where id = p_product_group_id
  ) then
    raise exception 'Product group does not exist';
  end if;
  if nullif(btrim(p_code), '') is null or char_length(btrim(p_code)) > 100 then
    raise exception 'Custom product code is required and cannot exceed 100 characters';
  end if;
  if nullif(btrim(p_name), '') is null or char_length(btrim(p_name)) > 300 then
    raise exception 'Custom product name is required and cannot exceed 300 characters';
  end if;
  if nullif(btrim(p_unit), '') is null or char_length(btrim(p_unit)) > 100 then
    raise exception 'Custom product unit is required and cannot exceed 100 characters';
  end if;
  if char_length(coalesce(p_description, '')) > 4000
     or char_length(coalesce(p_specification, '')) > 2000
     or char_length(coalesce(p_image_url, '')) > 2000 then
    raise exception 'Custom product version text exceeds maximum length';
  end if;
  if p_default_unit_price is null or p_default_unit_price < 0
     or p_default_unit_price > 999999999999 then
    raise exception 'Default unit price is invalid';
  end if;
  if p_default_currency is null then
    raise exception 'Default currency is required';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 999999999999 then
    raise exception 'Custom product quantity is invalid';
  end if;
  if round(round(p_quantity, 4) * round(p_default_unit_price, 2), 2)
     > 9999999999999999.99 then
    raise exception 'Custom product order amount is invalid';
  end if;
  if p_received_amount is not null and (
    p_received_amount < 0 or p_received_amount > 999999999999
  ) then
    raise exception 'Custom product received amount is invalid';
  end if;

  select coalesce(max(version_no), 0) + 1 into v_version_no
  from public.business_custom_product_versions
  where custom_product_id = v_product.id;

  insert into public.business_custom_product_versions (
    custom_product_id, version_no, product_group_id, code, name, description,
    specification, unit, image_url, default_unit_price, default_currency,
    quantity, received_amount, created_by
  ) values (
    v_product.id, v_version_no, p_product_group_id, btrim(p_code), btrim(p_name),
    nullif(btrim(p_description), ''), nullif(btrim(p_specification), ''),
    btrim(p_unit), nullif(btrim(p_image_url), ''), p_default_unit_price,
    p_default_currency, round(p_quantity, 4),
    case when p_received_amount is null then null else round(p_received_amount, 2) end,
    v_uid
  ) returning * into v_version;

  update public.business_custom_products set updated_by = v_uid where id = v_product.id;

  perform public.write_business_lifecycle_audit(
    null, null, 'custom_product_version', v_version.id,
    'version_create', null, to_jsonb(v_version), null, v_uid
  );
  return v_version;
end;
$$;
revoke all on function public.add_business_custom_product_version(
  uuid, uuid, text, text, text, text, text, text, numeric,
  public.currency_code, numeric, numeric
) from public, anon, authenticated, service_role;
grant execute on function public.add_business_custom_product_version(
  uuid, uuid, text, text, text, text, text, text, numeric,
  public.currency_code, numeric, numeric
) to authenticated;

create function public.create_business_custom_product(p_initial_version jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_product public.business_custom_products%rowtype;
  v_version public.business_custom_product_versions%rowtype;
begin
  select * into v_actor from public.profiles where id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved business role required to create custom products';
  end if;
  if p_initial_version is not null and jsonb_typeof(p_initial_version) <> 'object' then
    raise exception 'Initial version must be a JSON object or null';
  end if;

  insert into public.business_custom_products (created_by, updated_by)
  values (v_uid, v_uid)
  returning * into v_product;

  perform public.write_business_lifecycle_audit(
    null, null, 'custom_product', v_product.id,
    'create', null, to_jsonb(v_product), null, v_uid
  );

  if p_initial_version is not null then
    v_version := public.add_business_custom_product_version(
      v_product.id,
      (p_initial_version->>'product_group_id')::uuid,
      p_initial_version->>'code',
      p_initial_version->>'name',
      p_initial_version->>'description',
      p_initial_version->>'specification',
      p_initial_version->>'unit',
      p_initial_version->>'image_url',
      (p_initial_version->>'default_unit_price')::numeric,
      (p_initial_version->>'default_currency')::public.currency_code,
      (p_initial_version->>'quantity')::numeric,
      (p_initial_version->>'received_amount')::numeric
    );
  end if;

  return jsonb_build_object('product', to_jsonb(v_product), 'version', to_jsonb(v_version));
end;
$$;
revoke all on function public.create_business_custom_product(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_business_custom_product(jsonb) to authenticated;

create function public.set_business_custom_product_state(
  p_custom_product_id uuid,
  p_is_archived boolean,
  p_reason text
)
returns public.business_custom_products
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_old public.business_custom_products%rowtype;
  v_new public.business_custom_products%rowtype;
begin
  select * into v_actor from public.profiles where id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Only approved administrators or finance users can change custom product state';
  end if;
  if p_is_archived is null then
    raise exception 'Archived flag is required';
  end if;
  if char_length(coalesce(p_reason, '')) > 1000 then
    raise exception 'Reason cannot exceed 1000 characters';
  end if;

  select * into v_old from public.business_custom_products
  where id = p_custom_product_id for update;
  if not found then
    raise exception 'Custom product does not exist';
  end if;

  update public.business_custom_products
  set is_archived = p_is_archived,
      updated_by = v_uid
  where id = p_custom_product_id
  returning * into v_new;

  perform public.write_business_lifecycle_audit(
    null, null, 'custom_product', v_new.id,
    'state_change', to_jsonb(v_old), to_jsonb(v_new), p_reason, v_uid
  );
  return v_new;
end;
$$;
revoke all on function public.set_business_custom_product_state(uuid, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.set_business_custom_product_state(uuid, boolean, text)
  to authenticated;

create function public.list_business_custom_products()
returns table (
  custom_product_id uuid,
  is_archived boolean,
  created_by uuid,
  created_at timestamptz,
  updated_by uuid,
  updated_at timestamptz,
  version_id uuid,
  version_no int,
  product_group_id uuid,
  product_group_name text,
  code text,
  name text,
  description text,
  specification text,
  unit text,
  image_url text,
  quantity numeric,
  default_unit_price numeric,
  default_currency public.currency_code,
  order_amount numeric,
  received_amount numeric,
  outstanding_amount numeric
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved business role required';
  end if;

  return query
  select cp.id, cp.is_archived, cp.created_by, cp.created_at, cp.updated_by, cp.updated_at,
         cv.id, cv.version_no, cv.product_group_id, pg.name,
         cv.code, cv.name, cv.description, cv.specification, cv.unit, cv.image_url,
         cv.quantity, cv.default_unit_price, cv.default_currency, cv.order_amount,
         cv.received_amount, cv.outstanding_amount
  from public.business_custom_products cp
  join public.business_custom_product_versions cv on cv.custom_product_id = cp.id
  left join public.product_groups pg on pg.id = cv.product_group_id
  where not cp.is_archived
  order by cv.name, cp.id, cv.version_no desc;
end;
$$;
revoke all on function public.list_business_custom_products()
  from public, anon, authenticated, service_role;
grant execute on function public.list_business_custom_products() to authenticated;

create function public.list_business_custom_products_library(
  p_search text,
  p_product_group_id uuid,
  p_status text
)
returns table (
  custom_product_id uuid,
  is_archived boolean,
  created_by uuid,
  created_at timestamptz,
  updated_by uuid,
  updated_at timestamptz,
  latest_version_id uuid,
  latest_version_no int,
  version_count bigint,
  product_group_id uuid,
  product_group_name text,
  code text,
  name text,
  description text,
  specification text,
  unit text,
  image_url text,
  quantity numeric,
  default_unit_price numeric,
  default_currency public.currency_code,
  order_amount numeric,
  received_amount numeric,
  outstanding_amount numeric
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_status text := coalesce(nullif(lower(btrim(p_status)), ''), 'active');
  v_search text := nullif(btrim(p_search), '');
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved business role required';
  end if;
  if v_status not in ('active', 'archived', 'all') then
    raise exception 'Invalid custom product library status';
  end if;

  return query
  select cp.id, cp.is_archived, cp.created_by, cp.created_at, cp.updated_by, cp.updated_at,
         latest.id, latest.version_no, counts.version_count,
         latest.product_group_id, pg.name,
         latest.code, latest.name, latest.description, latest.specification,
         latest.unit, latest.image_url, latest.quantity, latest.default_unit_price,
         latest.default_currency, latest.order_amount, latest.received_amount,
         latest.outstanding_amount
  from public.business_custom_products cp
  left join lateral (
    select v.*
    from public.business_custom_product_versions v
    where v.custom_product_id = cp.id
    order by v.version_no desc
    limit 1
  ) latest on true
  left join public.product_groups pg on pg.id = latest.product_group_id
  cross join lateral (
    select count(*) as version_count
    from public.business_custom_product_versions v
    where v.custom_product_id = cp.id
  ) counts
  where (p_product_group_id is null or latest.product_group_id = p_product_group_id)
    and (v_status = 'all'
         or (v_status = 'active' and not cp.is_archived)
         or (v_status = 'archived' and cp.is_archived))
    and (v_search is null or concat_ws(
      ' ', latest.code, latest.name, latest.description, latest.specification, pg.name
    ) ilike '%' || v_search || '%')
  order by cp.updated_at desc, cp.id;
end;
$$;
revoke all on function public.list_business_custom_products_library(text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_business_custom_products_library(text, uuid, text)
  to authenticated;

-- -----------------------------------------------------------------------------
-- 4. 财务可通过当前 V4 建单入口填写每日订单字段，并指定已审批业务员。
-- -----------------------------------------------------------------------------
create or replace function public.apply_business_order_daily_entry(
  p_order_id uuid,
  p_shop_id uuid,
  p_salesperson_id uuid,
  p_external_order_number text,
  p_daily_shipping_date date,
  p_daily_shipping_number text,
  p_daily_payment_category public.daily_order_payment_category,
  p_total_product_received_amount numeric,
  p_total_product_received_overridden boolean,
  p_total_shipping_received_amount numeric,
  p_total_shipping_received_overridden boolean,
  p_total_sales_amount numeric,
  p_total_sales_overridden boolean,
  p_items jsonb,
  p_actor_id uuid,
  p_is_create boolean,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_salesperson public.profiles%rowtype;
  v_shop public.finance_daily_order_shops%rowtype;
  v_shop_group_id uuid;
  v_shop_group_name text;
  v_order public.business_orders%rowtype;
  v_item jsonb;
  v_order_item public.business_order_items%rowtype;
  v_sort_order int := 0;
  v_product_amount numeric;
  v_logistics_amount numeric;
  v_sales_amount numeric;
  v_product_overridden boolean;
  v_sales_overridden boolean;
  v_product_sum numeric(18,2) := 0;
  v_shipping_sum numeric(18,2) := 0;
  v_sales_sum numeric(18,2) := 0;
  v_effective_product_total numeric(18,2);
  v_effective_shipping_total numeric(18,2);
  v_effective_sales_total numeric(18,2);
  v_old jsonb;
  v_new jsonb;
begin
  select * into v_actor from public.profiles p where p.id = p_actor_id;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved sales, supervisor, admin, or finance account required';
  end if;

  select * into v_order
  from public.business_orders bo
  where bo.id = p_order_id
  for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if v_order.status::text = 'completed' or v_order.closed_at is not null then
    raise exception 'Completed or closed business order cannot be edited';
  end if;

  select * into v_salesperson
  from public.profiles p
  where p.id = p_salesperson_id and p.status::text = 'approved';
  if not found then raise exception 'Assigned salesperson must be approved'; end if;
  if v_actor.role::text in ('admin', 'finance') then
    if v_salesperson.role::text not in ('sales', 'supervisor', 'admin') then
      raise exception 'Administrator or finance can assign only approved sales, supervisor, or admin users';
    end if;
  elsif p_salesperson_id is distinct from p_actor_id then
    raise exception 'Sales or supervisor users can assign orders only to themselves';
  end if;

  select * into v_shop
  from public.finance_daily_order_shops s
  where s.id = p_shop_id;
  if not found then raise exception 'Daily order shop does not exist'; end if;
  if not v_shop.is_active and (p_is_create or v_order.shop_id is distinct from p_shop_id) then
    raise exception 'Daily order shop is inactive';
  end if;
  if not exists (
    select 1
    from public.finance_daily_order_shop_salespeople a
    where a.shop_id = p_shop_id
      and a.salesperson_id = p_salesperson_id
      and a.is_active
  ) then
    raise exception 'Salesperson is not actively assigned to this shop';
  end if;

  if v_shop.group_id is not null then
    select g.id, nullif(btrim(g.name), '')
      into v_shop_group_id, v_shop_group_name
    from public.finance_daily_order_shop_groups g
    where g.id = v_shop.group_id;
    if not found then raise exception 'Daily order shop group does not exist'; end if;
  else
    v_shop_group_id := null;
    v_shop_group_name := null;
  end if;

  if nullif(btrim(p_external_order_number), '') is null
     or char_length(btrim(p_external_order_number)) > 200 then
    raise exception 'External order number is required and cannot exceed 200 characters';
  end if;
  if p_daily_shipping_date is null then raise exception 'Daily shipping date is required'; end if;
  if p_daily_payment_category is null then raise exception 'Daily payment category is required'; end if;
  if char_length(coalesce(p_daily_shipping_number, '')) > 200 then
    raise exception 'Daily shipping number cannot exceed 200 characters';
  end if;
  if char_length(coalesce(p_reason, '')) > 1000 then
    raise exception 'Reason cannot exceed 1000 characters';
  end if;

  if p_total_product_received_amount is null
     or p_total_shipping_received_amount is null
     or p_total_sales_amount is null
     or p_total_product_received_overridden is null
     or p_total_shipping_received_overridden is null
     or p_total_sales_overridden is null then
    raise exception 'Daily order totals are incomplete';
  end if;
  if p_total_product_received_amount < 0
     or p_total_product_received_amount > 999999999999
     or p_total_product_received_amount <> round(p_total_product_received_amount, 2)
     or p_total_shipping_received_amount < 0
     or p_total_shipping_received_amount > 999999999999
     or p_total_shipping_received_amount <> round(p_total_shipping_received_amount, 2)
     or p_total_sales_amount < 0
     or p_total_sales_amount > 999999999999
     or p_total_sales_amount <> round(p_total_sales_amount, 2) then
    raise exception 'Daily order totals must be non-negative and within 2 decimal places';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 500 then
    raise exception 'Order items count must be between 1 and 500';
  end if;
  if jsonb_array_length(p_items) <> (
    select count(*) from public.business_order_items i where i.order_id = p_order_id
  ) then
    raise exception 'Daily order item count does not match business order items';
  end if;

  v_old := jsonb_build_object(
    'order', jsonb_build_object(
      'shop_id', v_order.shop_id,
      'shop_name_snapshot', v_order.shop_name_snapshot,
      'shop_group_id', v_order.shop_group_id,
      'shop_group_name_snapshot', v_order.shop_group_name_snapshot,
      'salesperson_id', v_order.salesperson_id,
      'salesperson_name_snapshot', v_order.salesperson_name_snapshot,
      'external_order_number', v_order.external_order_number,
      'daily_shipping_date', v_order.daily_shipping_date,
      'daily_shipping_number', v_order.daily_shipping_number,
      'daily_payment_category', v_order.daily_payment_category,
      'total_product_received_amount', v_order.total_product_received_amount,
      'total_product_received_overridden', v_order.total_product_received_overridden,
      'total_shipping_received_amount', v_order.total_shipping_received_amount,
      'total_shipping_received_overridden', v_order.total_shipping_received_overridden,
      'total_sales_amount', v_order.total_sales_amount,
      'total_sales_overridden', v_order.total_sales_overridden
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id,
        'daily_shipping_category', i.daily_shipping_category,
        'product_received_amount', i.product_received_amount,
        'product_received_overridden', i.product_received_overridden,
        'logistics_fee_amount', i.logistics_fee_amount,
        'sales_total_amount', i.sales_total_amount,
        'sales_total_overridden', i.sales_total_overridden
      ) order by i.sort_order)
      from public.business_order_items i where i.order_id = p_order_id
    ), '[]'::jsonb)
  );

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) <> 'object'
       or not (v_item ?& array[
         'daily_shipping_category',
         'product_received_amount',
         'product_received_overridden',
         'logistics_fee_amount',
         'sales_total_amount',
         'sales_total_overridden'
       ]) then
      raise exception 'Daily order item fields are incomplete';
    end if;
    if v_item->>'daily_shipping_category' not in ('stock', 'sample', 'custom', 'purchase') then
      raise exception 'Invalid daily shipping category';
    end if;
    if jsonb_typeof(v_item->'product_received_overridden') <> 'boolean'
       or jsonb_typeof(v_item->'sales_total_overridden') <> 'boolean' then
      raise exception 'Daily order item override flags are required';
    end if;

    begin
      v_product_amount := (v_item->>'product_received_amount')::numeric;
      v_logistics_amount := (v_item->>'logistics_fee_amount')::numeric;
      v_sales_amount := (v_item->>'sales_total_amount')::numeric;
      v_product_overridden := (v_item->>'product_received_overridden')::boolean;
      v_sales_overridden := (v_item->>'sales_total_overridden')::boolean;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Daily order item amounts are invalid';
    end;

    if v_product_amount is null or v_logistics_amount is null or v_sales_amount is null
       or v_product_amount < 0 or v_product_amount > 999999999999
       or v_product_amount <> round(v_product_amount, 2)
       or v_logistics_amount < 0 or v_logistics_amount > 999999999999
       or v_logistics_amount <> round(v_logistics_amount, 2)
       or v_sales_amount < 0 or v_sales_amount > 999999999999
       or v_sales_amount <> round(v_sales_amount, 2) then
      raise exception 'Daily order item amounts must be non-negative and within 2 decimal places';
    end if;

    select * into v_order_item
    from public.business_order_items i
    where i.order_id = p_order_id and i.sort_order = v_sort_order
    for update;
    if not found then raise exception 'Daily order item does not match business order item'; end if;

    if not v_product_overridden then
      v_product_amount := round(v_order_item.quantity * v_order_item.unit_price, 2);
    end if;
    if not v_sales_overridden then
      v_sales_amount := v_product_amount + v_logistics_amount;
    end if;

    update public.business_order_items i
    set daily_shipping_category = (v_item->>'daily_shipping_category')::public.daily_order_shipping_category,
        product_received_amount = v_product_amount,
        product_received_overridden = v_product_overridden,
        logistics_fee_amount = v_logistics_amount,
        sales_total_amount = v_sales_amount,
        sales_total_overridden = v_sales_overridden
    where i.id = v_order_item.id;

    v_product_sum := v_product_sum + v_product_amount;
    v_shipping_sum := v_shipping_sum + v_logistics_amount;
    v_sales_sum := v_sales_sum + v_sales_amount;
    v_sort_order := v_sort_order + 1;
  end loop;

  v_effective_product_total := case
    when p_total_product_received_overridden then p_total_product_received_amount
    else v_product_sum
  end;
  v_effective_shipping_total := case
    when p_total_shipping_received_overridden then p_total_shipping_received_amount
    else v_shipping_sum
  end;
  v_effective_sales_total := case
    when p_total_sales_overridden then p_total_sales_amount
    else v_sales_sum
  end;

  if v_effective_sales_total <> v_effective_product_total + v_effective_shipping_total then
    raise exception 'Total sales amount must equal product received plus shipping received';
  end if;

  update public.business_orders bo
  set shop_id = v_shop.id,
      shop_name_snapshot = btrim(v_shop.name),
      shop_group_id = v_shop_group_id,
      shop_group_name_snapshot = v_shop_group_name,
      salesperson_id = v_salesperson.id,
      salesperson_name_snapshot = coalesce(
        nullif(btrim(v_salesperson.chinese_name), ''),
        nullif(btrim(v_salesperson.full_name), ''),
        v_salesperson.email
      ),
      external_order_number = btrim(p_external_order_number),
      daily_shipping_date = p_daily_shipping_date,
      daily_shipping_number = nullif(btrim(p_daily_shipping_number), ''),
      daily_payment_category = p_daily_payment_category,
      total_product_received_amount = v_effective_product_total,
      total_product_received_overridden = p_total_product_received_overridden,
      total_shipping_received_amount = v_effective_shipping_total,
      total_shipping_received_overridden = p_total_shipping_received_overridden,
      total_sales_amount = v_effective_sales_total,
      total_sales_overridden = p_total_sales_overridden
  where bo.id = p_order_id
  returning * into v_order;

  v_new := jsonb_build_object(
    'order', jsonb_build_object(
      'shop_id', v_order.shop_id,
      'shop_name_snapshot', v_order.shop_name_snapshot,
      'shop_group_id', v_order.shop_group_id,
      'shop_group_name_snapshot', v_order.shop_group_name_snapshot,
      'salesperson_id', v_order.salesperson_id,
      'salesperson_name_snapshot', v_order.salesperson_name_snapshot,
      'external_order_number', v_order.external_order_number,
      'daily_shipping_date', v_order.daily_shipping_date,
      'daily_shipping_number', v_order.daily_shipping_number,
      'daily_payment_category', v_order.daily_payment_category,
      'total_product_received_amount', v_order.total_product_received_amount,
      'total_product_received_overridden', v_order.total_product_received_overridden,
      'total_shipping_received_amount', v_order.total_shipping_received_amount,
      'total_shipping_received_overridden', v_order.total_shipping_received_overridden,
      'total_sales_amount', v_order.total_sales_amount,
      'total_sales_overridden', v_order.total_sales_overridden
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id,
        'daily_shipping_category', i.daily_shipping_category,
        'product_received_amount', i.product_received_amount,
        'product_received_overridden', i.product_received_overridden,
        'logistics_fee_amount', i.logistics_fee_amount,
        'sales_total_amount', i.sales_total_amount,
        'sales_total_overridden', i.sales_total_overridden
      ) order by i.sort_order)
      from public.business_order_items i where i.order_id = p_order_id
    ), '[]'::jsonb)
  );

  if v_old is distinct from v_new then
    perform public.write_business_order_audit(
      v_order.id,
      'order',
      v_order.id,
      'update',
      v_order.status,
      v_order.status,
      v_old,
      v_new,
      p_reason,
      p_actor_id
    );
  end if;
end;
$$;
revoke all on function public.apply_business_order_daily_entry(
  uuid, uuid, uuid, text, date, text, public.daily_order_payment_category,
  numeric, boolean, numeric, boolean, numeric, boolean, jsonb, uuid, boolean, text
) from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. 订单行全局定制产品可用性：仅移除客户/共享判断，保留其余保护逻辑。
-- -----------------------------------------------------------------------------
create or replace function public.replace_business_order_items(
  p_order_id uuid,
  p_items jsonb
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_order public.business_orders%rowtype;
  v_existing public.business_order_items%rowtype;
  v_product public.products%rowtype;
  v_custom_product public.business_custom_products%rowtype;
  v_custom_version public.business_custom_product_versions%rowtype;
  v_source_type text;
  v_requested_id uuid;
  v_product_id uuid;
  v_custom_product_id uuid;
  v_custom_version_id uuid;
  v_quantity numeric;
  v_unit_price numeric;
  v_sort_order int := 0;
  v_subtotal numeric(18,2) := 0;
  v_matched_ids uuid[] := array[]::uuid[];
  v_is_existing boolean;
begin
  select * into v_order from public.business_orders bo where bo.id = p_order_id for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if v_order.status::text = 'completed' or v_order.closed_at is not null then
    raise exception 'Completed or closed order items cannot be replaced';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 500 then
    raise exception 'Order items count must be between 1 and 500';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_items) as x(id uuid)
    where x.id is not null
    group by x.id having count(*) > 1
  ) then
    raise exception 'Each order item id must be unique';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) <> 'object' then raise exception 'Each item must be an object'; end if;
    v_requested_id := nullif(v_item->>'id', '')::uuid;
    v_product_id := nullif(v_item->>'product_id', '')::uuid;
    v_custom_product_id := nullif(v_item->>'custom_product_id', '')::uuid;
    v_custom_version_id := nullif(v_item->>'custom_product_version_id', '')::uuid;
    v_source_type := coalesce(nullif(v_item->>'source_type', ''),
      case when v_custom_product_id is not null or v_custom_version_id is not null
           then 'custom' else 'catalog' end);
    v_quantity := round((v_item->>'quantity')::numeric, 4);
    v_unit_price := round((v_item->>'unit_price')::numeric, 2);
    if v_quantity is null or v_quantity <= 0 or v_quantity > 999999999999 then
      raise exception 'Quantity is invalid';
    end if;
    if v_unit_price is null or v_unit_price < 0 or v_unit_price > 999999999999 then
      raise exception 'Unit price is invalid';
    end if;

    v_existing := null;
    if v_requested_id is not null then
      select * into v_existing from public.business_order_items
      where id = v_requested_id and order_id = p_order_id;
      if not found then raise exception 'Order item id does not belong to order'; end if;
    elsif v_source_type = 'catalog' then
      select * into v_existing from public.business_order_items
      where order_id = p_order_id and source_type = 'catalog'
        and product_id = v_product_id and not (id = any(v_matched_ids))
      order by sort_order, id limit 1;
    elsif v_source_type = 'custom' then
      select * into v_existing from public.business_order_items
      where order_id = p_order_id and source_type = 'custom'
        and custom_product_id = v_custom_product_id
        and custom_product_version_id = v_custom_version_id
        and not (id = any(v_matched_ids))
      order by sort_order, id limit 1;
    end if;
    v_is_existing := v_existing.id is not null;

    if v_source_type = 'catalog' then
      if v_product_id is null or v_custom_product_id is not null or v_custom_version_id is not null then
        raise exception 'Catalog item requires only product_id';
      end if;
      select * into v_product from public.products where id = v_product_id;
      if not found or (
        not v_product.is_active and (
          not v_is_existing
          or v_existing.source_type <> 'catalog'
          or v_existing.product_id is distinct from v_product_id
        )
      ) then
        raise exception 'Product does not exist or is inactive';
      end if;

      if v_is_existing then
        update public.business_order_items set
          source_type = 'catalog', product_id = v_product.id,
          custom_product_id = null, custom_product_version_id = null,
          sku_snapshot = v_product.sku, name_snapshot = v_product.name,
          description_snapshot = v_product.description,
          specification_snapshot = v_product.specification,
          unit_snapshot = v_product.unit, image_url_snapshot = v_product.image_url,
          quantity = v_quantity, unit_price = v_unit_price, sort_order = v_sort_order
        where id = v_existing.id returning * into v_existing;
      else
        insert into public.business_order_items (
          order_id, source_type, product_id, sku_snapshot, name_snapshot,
          description_snapshot, specification_snapshot, unit_snapshot,
          image_url_snapshot, quantity, unit_price, sort_order
        ) values (
          p_order_id, 'catalog', v_product.id, v_product.sku, v_product.name,
          v_product.description, v_product.specification, v_product.unit,
          v_product.image_url, v_quantity, v_unit_price, v_sort_order
        ) returning * into v_existing;
      end if;
    elsif v_source_type = 'custom' then
      if v_product_id is not null or v_custom_product_id is null or v_custom_version_id is null then
        raise exception 'Custom item requires only custom_product_id and custom_product_version_id';
      end if;
      select * into v_custom_product from public.business_custom_products
      where id = v_custom_product_id;
      if not found then raise exception 'Custom product does not exist'; end if;
      select * into v_custom_version from public.business_custom_product_versions
      where id = v_custom_version_id and custom_product_id = v_custom_product.id;
      if not found then raise exception 'Custom product version does not belong to custom product'; end if;
      if v_custom_product.is_archived and (
        not v_is_existing
        or v_existing.source_type <> 'custom'
        or v_existing.custom_product_id is distinct from v_custom_product_id
        or v_existing.custom_product_version_id is distinct from v_custom_version_id
      ) then
        raise exception 'Custom product is archived';
      end if;

      if v_is_existing then
        update public.business_order_items set
          source_type = 'custom', product_id = null,
          custom_product_id = v_custom_product.id,
          custom_product_version_id = v_custom_version.id,
          sku_snapshot = v_custom_version.code, name_snapshot = v_custom_version.name,
          description_snapshot = v_custom_version.description,
          specification_snapshot = v_custom_version.specification,
          unit_snapshot = v_custom_version.unit, image_url_snapshot = v_custom_version.image_url,
          quantity = v_quantity, unit_price = v_unit_price, sort_order = v_sort_order
        where id = v_existing.id returning * into v_existing;
      else
        insert into public.business_order_items (
          order_id, source_type, custom_product_id, custom_product_version_id,
          sku_snapshot, name_snapshot, description_snapshot, specification_snapshot,
          unit_snapshot, image_url_snapshot, quantity, unit_price, sort_order
        ) values (
          p_order_id, 'custom', v_custom_product.id, v_custom_version.id,
          v_custom_version.code, v_custom_version.name, v_custom_version.description,
          v_custom_version.specification, v_custom_version.unit, v_custom_version.image_url,
          v_quantity, v_unit_price, v_sort_order
        ) returning * into v_existing;
      end if;
    else
      raise exception 'Invalid order item source_type';
    end if;

    v_matched_ids := array_append(v_matched_ids, v_existing.id);
    v_subtotal := v_subtotal + round(v_quantity * v_unit_price, 2);
    v_sort_order := v_sort_order + 1;
  end loop;

  delete from public.business_order_items
  where order_id = p_order_id and not (id = any(v_matched_ids));
  return v_subtotal;
end;
$$;
revoke all on function public.replace_business_order_items(uuid, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.adjust_business_order_items(
  p_order_id uuid,
  p_expected_version int,
  p_items jsonb,
  p_reason_type text,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_idempotency public.business_rpc_idempotency%rowtype;
  v_item jsonb;
  v_existing public.business_order_items%rowtype;
  v_product public.products%rowtype;
  v_custom_product public.business_custom_products%rowtype;
  v_custom_version public.business_custom_product_versions%rowtype;
  v_requested_id uuid;
  v_source_type text;
  v_product_id uuid;
  v_custom_product_id uuid;
  v_custom_version_id uuid;
  v_quantity numeric;
  v_quantity_before numeric;
  v_unit_price numeric;
  v_sort_order int;
  v_changes jsonb := '[]'::jsonb;
  v_subtotal_before numeric(18,2);
  v_total_before numeric(18,2);
  v_subtotal_after numeric(18,2);
  v_revision public.business_order_amount_revisions%rowtype;
  v_hash text;
  v_old jsonb;
  v_new jsonb;
  v_result jsonb;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin') then
    raise exception 'Approved sales, supervisor, or admin account required';
  end if;
  if p_reason_type not in ('add_on', 'quantity_fix') then
    raise exception 'Adjustment reason type must be add_on or quantity_fix';
  end if;
  if char_length(coalesce(p_reason, '')) > 1000 then
    raise exception 'Adjustment reason cannot exceed 1000 characters';
  end if;
  if nullif(btrim(coalesce(p_idempotency_key, '')), '') is null
     or char_length(btrim(p_idempotency_key)) > 200 then
    raise exception 'Idempotency key is invalid';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 500 then
    raise exception 'Adjustment items count must be between 1 and 500';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_items) as x(id uuid)
    where x.id is not null
    group by x.id having count(*) > 1
  ) then
    raise exception 'Each adjustment order item id must be unique';
  end if;

  select * into v_order from public.business_orders bo where bo.id = p_order_id for update;
  if not found then raise exception 'Business order does not exist'; end if;

  v_hash := encode(digest(jsonb_build_object(
    'order_id', p_order_id,
    'expected_version', p_expected_version,
    'items', p_items,
    'reason_type', p_reason_type,
    'reason', nullif(btrim(p_reason), '')
  )::text, 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    v_uid::text || ':adjust_business_order_items:' || btrim(p_idempotency_key), 0));
  select * into v_idempotency from public.business_rpc_idempotency
  where actor_id = v_uid and operation = 'adjust_business_order_items'
    and idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_idempotency.payload_hash <> v_hash then
      raise exception 'Idempotency key was already used with a different payload';
    end if;
    return v_idempotency.result;
  end if;

  if v_order.version <> p_expected_version then
    raise exception 'Business order version conflict';
  end if;
  if v_order.closed_at is not null then
    raise exception 'Closed business order cannot be adjusted';
  end if;
  if v_order.status::text = 'completed' then
    raise exception 'Completed business order is immutable';
  end if;
  if v_order.status::text <> 'approved' or v_order.approval_status <> 'approved' then
    raise exception 'Only approved orders can be adjusted; edit the draft instead';
  end if;
  if v_actor.role::text in ('sales', 'supervisor')
     and v_order.salesperson_id is distinct from v_uid then
    raise exception 'Sales user cannot adjust another owner business order';
  end if;

  v_old := jsonb_build_object(
    'order', to_jsonb(v_order),
    'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order, i.id)
                       from public.business_order_items i
                       where i.order_id = v_order.id), '[]'::jsonb)
  );
  v_subtotal_before := v_order.items_subtotal;
  v_total_before := v_order.total_amount;
  select coalesce(max(i.sort_order), -1) + 1 into v_sort_order
  from public.business_order_items i where i.order_id = p_order_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) <> 'object' then raise exception 'Each item must be an object'; end if;
    v_requested_id := nullif(v_item->>'id', '')::uuid;
    v_product_id := nullif(v_item->>'product_id', '')::uuid;
    v_custom_product_id := nullif(v_item->>'custom_product_id', '')::uuid;
    v_custom_version_id := nullif(v_item->>'custom_product_version_id', '')::uuid;
    v_quantity := round((v_item->>'quantity')::numeric, 4);
    if v_quantity is null or v_quantity <= 0 or v_quantity > 999999999999 then
      raise exception 'Quantity is invalid';
    end if;

    if v_requested_id is not null then
      select * into v_existing from public.business_order_items
      where id = v_requested_id and order_id = p_order_id for update;
      if not found then raise exception 'Order item id does not belong to order'; end if;
      if v_quantity <= v_existing.quantity then
        raise exception 'Adjustment can only increase an existing order item quantity';
      end if;
      if v_item ? 'unit_price'
         and round((v_item->>'unit_price')::numeric, 2) is distinct from v_existing.unit_price then
        raise exception 'Order item unit price cannot be changed by an adjustment';
      end if;
      if (v_product_id is not null and v_product_id is distinct from v_existing.product_id)
         or (v_custom_product_id is not null
             and v_custom_product_id is distinct from v_existing.custom_product_id)
         or (v_custom_version_id is not null
             and v_custom_version_id is distinct from v_existing.custom_product_version_id) then
        raise exception 'Order item product cannot be replaced by an adjustment';
      end if;

      v_quantity_before := v_existing.quantity;
      update public.business_order_items set quantity = v_quantity
      where id = v_existing.id
      returning * into v_existing;

      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'kind', 'quantity_increased',
        'order_item_id', v_existing.id,
        'name_snapshot', v_existing.name_snapshot,
        'unit_snapshot', v_existing.unit_snapshot,
        'unit_price', v_existing.unit_price,
        'quantity_before', v_quantity_before,
        'quantity_after', v_existing.quantity
      ));
    else
      v_unit_price := round((v_item->>'unit_price')::numeric, 2);
      if v_unit_price is null or v_unit_price < 0 or v_unit_price > 999999999999 then
        raise exception 'Unit price is invalid';
      end if;
      v_source_type := coalesce(nullif(v_item->>'source_type', ''),
        case when v_custom_product_id is not null or v_custom_version_id is not null
             then 'custom' else 'catalog' end);

      if v_source_type = 'catalog' then
        if v_product_id is null or v_custom_product_id is not null
           or v_custom_version_id is not null then
          raise exception 'Catalog item requires only product_id';
        end if;
        select * into v_product from public.products where id = v_product_id;
        if not found or not v_product.is_active then
          raise exception 'Product does not exist or is inactive';
        end if;
        insert into public.business_order_items (
          order_id, source_type, product_id, sku_snapshot, name_snapshot,
          description_snapshot, specification_snapshot, unit_snapshot,
          image_url_snapshot, quantity, unit_price, sort_order
        ) values (
          p_order_id, 'catalog', v_product.id, v_product.sku, v_product.name,
          v_product.description, v_product.specification, v_product.unit,
          v_product.image_url, v_quantity, v_unit_price, v_sort_order
        ) returning * into v_existing;
      elsif v_source_type = 'custom' then
        if v_product_id is not null or v_custom_product_id is null
           or v_custom_version_id is null then
          raise exception 'Custom item requires only custom_product_id and custom_product_version_id';
        end if;
        select * into v_custom_product from public.business_custom_products
        where id = v_custom_product_id;
        if not found then raise exception 'Custom product does not exist'; end if;
        select * into v_custom_version from public.business_custom_product_versions
        where id = v_custom_version_id and custom_product_id = v_custom_product.id;
        if not found then
          raise exception 'Custom product version does not belong to custom product';
        end if;
        if v_custom_product.is_archived then raise exception 'Custom product is archived'; end if;
        insert into public.business_order_items (
          order_id, source_type, custom_product_id, custom_product_version_id,
          sku_snapshot, name_snapshot, description_snapshot, specification_snapshot,
          unit_snapshot, image_url_snapshot, quantity, unit_price, sort_order
        ) values (
          p_order_id, 'custom', v_custom_product.id, v_custom_version.id,
          v_custom_version.code, v_custom_version.name, v_custom_version.description,
          v_custom_version.specification, v_custom_version.unit, v_custom_version.image_url,
          v_quantity, v_unit_price, v_sort_order
        ) returning * into v_existing;
      else
        raise exception 'Invalid order item source_type';
      end if;

      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'kind', 'appended',
        'order_item_id', v_existing.id,
        'name_snapshot', v_existing.name_snapshot,
        'unit_snapshot', v_existing.unit_snapshot,
        'unit_price', v_existing.unit_price,
        'quantity_before', 0,
        'quantity_after', v_existing.quantity
      ));
      v_sort_order := v_sort_order + 1;
    end if;
  end loop;

  select coalesce(sum(i.line_amount), 0) into v_subtotal_after
  from public.business_order_items i where i.order_id = p_order_id;
  if round(v_subtotal_after, 2) = round(v_subtotal_before, 2) then
    raise exception 'Adjustment does not change the order amount';
  end if;

  update public.business_orders bo set
    items_subtotal = v_subtotal_after,
    total_amount = v_subtotal_after + bo.shipping_fee,
    version = bo.version + 1
  where bo.id = p_order_id;

  perform public.business_refresh_order_fulfillment_status(p_order_id);
  select * into v_order from public.business_orders where id = p_order_id;

  v_revision := public.business_write_order_amount_revision(
    p_order_id,
    p_reason_type,
    v_subtotal_before, v_order.items_subtotal,
    v_total_before, v_order.total_amount,
    jsonb_build_object('lines', v_changes),
    p_reason,
    v_uid
  );

  v_new := jsonb_build_object(
    'order', to_jsonb(v_order),
    'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order, i.id)
                       from public.business_order_items i
                       where i.order_id = v_order.id), '[]'::jsonb)
  );
  perform public.write_business_order_audit(
    v_order.id, 'order', v_order.id, 'update', v_order.status, v_order.status,
    v_old, v_new, p_reason, v_uid
  );

  v_result := jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'version', v_order.version,
    'items_subtotal', v_order.items_subtotal,
    'total_amount', v_order.total_amount,
    'fulfillment_status', v_order.fulfillment_status,
    'revision', to_jsonb(v_revision)
  );
  insert into public.business_rpc_idempotency (
    actor_id, operation, idempotency_key, payload_hash, result
  ) values (
    v_uid, 'adjust_business_order_items', btrim(p_idempotency_key), v_hash, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.adjust_business_order_items(uuid, int, jsonb, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.adjust_business_order_items(uuid, int, jsonb, text, text, text)
  to authenticated;

commit;
