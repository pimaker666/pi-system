-- 0018_finance_daily_orders.sql
-- 财务每日订单台账：独立于旧财务汇总，仅 approved admin/finance 可读写。

do $$ begin
  create type public.daily_order_shipping_category as enum ('stock', 'sample', 'custom');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.daily_order_payment_category as enum ('full', 'deposit', 'balance');
exception when duplicate_object then null; end $$;

create table if not exists public.finance_daily_order_shops (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_daily_order_shops_name_check check (char_length(btrim(name)) between 1 and 100)
);
create unique index if not exists idx_daily_order_shops_name_ci
  on public.finance_daily_order_shops (lower(btrim(name)));
create index if not exists idx_daily_order_shops_active
  on public.finance_daily_order_shops (is_active, name);
create index if not exists idx_daily_order_shops_created_by
  on public.finance_daily_order_shops (created_by);

create table if not exists public.finance_daily_order_shop_salespeople (
  shop_id uuid not null references public.finance_daily_order_shops(id) on delete cascade,
  salesperson_id uuid not null references public.profiles(id) on delete cascade,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (shop_id, salesperson_id)
);
create index if not exists idx_daily_order_assignments_salesperson
  on public.finance_daily_order_shop_salespeople (salesperson_id, is_active);
create index if not exists idx_daily_order_assignments_created_by
  on public.finance_daily_order_shop_salespeople (created_by);

create table if not exists public.finance_daily_orders (
  id uuid primary key default uuid_generate_v4(),
  version int not null default 1 check (version > 0),
  status public.finance_record_status not null default 'active',
  order_date date not null,
  shop_id uuid references public.finance_daily_order_shops(id) on delete set null,
  shop_name_snapshot text not null,
  salesperson_id uuid references public.profiles(id) on delete set null,
  salesperson_name_snapshot text not null,
  order_number text not null,
  shipping_date date not null,
  shipping_number text,
  shipping_category public.daily_order_shipping_category not null default 'stock',
  product_id uuid references public.products(id) on delete set null,
  product_name_snapshot text not null,
  product_sku_snapshot text not null,
  quantity numeric(18,4) not null check (quantity > 0 and quantity <= 999999999999),
  sales_unit_price_amount numeric(18,2) not null check (sales_unit_price_amount >= 0 and sales_unit_price_amount <= 999999999999),
  sales_unit_price_currency public.currency_code not null,
  product_received_amount numeric(18,2) not null check (product_received_amount >= 0 and product_received_amount <= 999999999999),
  product_received_currency public.currency_code not null,
  logistics_fee_amount numeric(18,2) not null check (logistics_fee_amount >= 0 and logistics_fee_amount <= 999999999999),
  logistics_fee_currency public.currency_code not null,
  sales_total_amount numeric(18,2) not null check (sales_total_amount >= 0 and sales_total_amount <= 999999999999),
  sales_total_currency public.currency_code not null,
  payment_category public.daily_order_payment_category not null default 'full',
  remarks text,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  voided_by uuid references public.profiles(id) on delete set null,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_daily_orders_order_number_check check (char_length(btrim(order_number)) between 1 and 200),
  constraint finance_daily_orders_shipping_number_check check (shipping_number is null or char_length(shipping_number) <= 200),
  constraint finance_daily_orders_remarks_check check (remarks is null or char_length(remarks) <= 2000),
  constraint finance_daily_orders_currency_check check (
    sales_unit_price_currency::text in ('CNY', 'USD')
    and product_received_currency::text in ('CNY', 'USD')
    and logistics_fee_currency::text in ('CNY', 'USD')
    and sales_total_currency::text in ('CNY', 'USD')
  ),
  constraint finance_daily_orders_void_check check (
    (status = 'active' and voided_at is null and voided_by is null)
    or (status = 'void' and voided_at is not null and voided_by is not null)
  )
);
comment on table public.finance_daily_orders is '产品维度的财务每日订单台账；订单号允许重复以表示同一订单的多个产品行';

create index if not exists idx_daily_orders_order_date
  on public.finance_daily_orders (order_date desc, created_at desc, id desc);
create index if not exists idx_daily_orders_shop
  on public.finance_daily_orders (shop_id, order_date desc);
create index if not exists idx_daily_orders_salesperson
  on public.finance_daily_orders (salesperson_id, order_date desc);
create index if not exists idx_daily_orders_product
  on public.finance_daily_orders (product_id);
create index if not exists idx_daily_orders_status_date
  on public.finance_daily_orders (status, order_date desc);
create index if not exists idx_daily_orders_shipping_category
  on public.finance_daily_orders (shipping_category);
create index if not exists idx_daily_orders_payment_category
  on public.finance_daily_orders (payment_category);
create index if not exists idx_daily_orders_created_by
  on public.finance_daily_orders (created_by);
create index if not exists idx_daily_orders_updated_by
  on public.finance_daily_orders (updated_by);
create index if not exists idx_daily_orders_voided_by
  on public.finance_daily_orders (voided_by);
create index if not exists idx_daily_orders_order_number
  on public.finance_daily_orders (order_number);

create table if not exists public.finance_daily_order_screenshots (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid not null references public.finance_daily_orders(id) on delete restrict,
  object_path text not null unique,
  original_name text,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png')),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 5242880),
  status public.finance_record_status not null default 'active',
  created_by uuid references public.profiles(id) on delete set null,
  removed_by uuid references public.profiles(id) on delete set null,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint finance_daily_order_screenshot_path_check check (
    object_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$'
  ),
  constraint finance_daily_order_screenshot_removed_check check (
    (status = 'active' and removed_at is null and removed_by is null)
    or (status = 'void' and removed_at is not null and removed_by is not null)
  )
);
create index if not exists idx_daily_order_screenshots_order
  on public.finance_daily_order_screenshots (order_id, status, created_at);
create index if not exists idx_daily_order_screenshots_created_by
  on public.finance_daily_order_screenshots (created_by);
create index if not exists idx_daily_order_screenshots_removed_by
  on public.finance_daily_order_screenshots (removed_by);

drop trigger if exists trg_daily_order_shops_touch on public.finance_daily_order_shops;
create trigger trg_daily_order_shops_touch before update on public.finance_daily_order_shops
  for each row execute function public.touch_updated_at();
drop trigger if exists trg_daily_order_assignments_touch on public.finance_daily_order_shop_salespeople;
create trigger trg_daily_order_assignments_touch before update on public.finance_daily_order_shop_salespeople
  for each row execute function public.touch_updated_at();
drop trigger if exists trg_daily_orders_touch on public.finance_daily_orders;
create trigger trg_daily_orders_touch before update on public.finance_daily_orders
  for each row execute function public.touch_updated_at();

create or replace function public.assert_daily_order_finance_actor()
returns public.profiles
language plpgsql
security definer
set search_path = public
stable
as $$
declare v_actor public.profiles%rowtype;
begin
  select * into v_actor from public.profiles where id = (select auth.uid());
  if not found or v_actor.status::text <> 'approved' or v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Only approved admin or finance users can manage daily orders';
  end if;
  return v_actor;
end;
$$;
revoke all on function public.assert_daily_order_finance_actor() from public;

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

  insert into public.finance_daily_orders (
    order_date, shop_id, shop_name_snapshot, salesperson_id, salesperson_name_snapshot,
    order_number, shipping_date, shipping_number, shipping_category,
    product_id, product_name_snapshot, product_sku_snapshot, quantity,
    sales_unit_price_amount, sales_unit_price_currency,
    product_received_amount, product_received_currency,
    logistics_fee_amount, logistics_fee_currency,
    sales_total_amount, sales_total_currency, payment_category, remarks, created_by, updated_by
  ) values (
    p_order_date, v_shop.id, v_shop.name, v_sales.id, coalesce(nullif(btrim(v_sales.full_name), ''), v_sales.email),
    btrim(p_order_number), p_shipping_date, nullif(btrim(p_shipping_number), ''), p_shipping_category,
    v_product.id, v_product.name, v_product.sku, p_quantity,
    p_sales_unit_price_amount, p_sales_unit_price_currency,
    p_product_received_amount, p_product_received_currency,
    p_logistics_fee_amount, p_logistics_fee_currency,
    p_sales_total_amount, p_sales_total_currency, p_payment_category, nullif(btrim(p_remarks), ''), v_actor.id, v_actor.id
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

  update public.finance_daily_orders as target set
    order_date = p_order_date, shop_id = v_shop.id, shop_name_snapshot = v_shop.name,
    salesperson_id = v_sales.id, salesperson_name_snapshot = coalesce(nullif(btrim(v_sales.full_name), ''), v_sales.email),
    order_number = btrim(p_order_number), shipping_date = p_shipping_date,
    shipping_number = nullif(btrim(p_shipping_number), ''), shipping_category = p_shipping_category,
    product_id = v_product.id, product_name_snapshot = v_product.name, product_sku_snapshot = v_product.sku,
    quantity = p_quantity, sales_unit_price_amount = p_sales_unit_price_amount,
    sales_unit_price_currency = p_sales_unit_price_currency,
    product_received_amount = p_product_received_amount, product_received_currency = p_product_received_currency,
    logistics_fee_amount = p_logistics_fee_amount, logistics_fee_currency = p_logistics_fee_currency,
    sales_total_amount = p_sales_total_amount, sales_total_currency = p_sales_total_currency,
    payment_category = p_payment_category, remarks = nullif(btrim(p_remarks), ''),
    version = target.version + 1, updated_by = v_actor.id
  where target.id = p_order_id
  returning target.id, target.version into id, version;
  return next;
end;
$$;
revoke all on function public.update_finance_daily_order(uuid, int, date, uuid, uuid, text, date, text, public.daily_order_shipping_category, uuid, numeric, numeric, public.currency_code, numeric, public.currency_code, numeric, public.currency_code, numeric, public.currency_code, public.daily_order_payment_category, text) from public;
grant execute on function public.update_finance_daily_order(uuid, int, date, uuid, uuid, text, date, text, public.daily_order_shipping_category, uuid, numeric, numeric, public.currency_code, numeric, public.currency_code, numeric, public.currency_code, numeric, public.currency_code, public.daily_order_payment_category, text) to authenticated;

create or replace function public.bulk_create_finance_daily_orders(p_rows jsonb)
returns table (id uuid, version int)
language plpgsql
security definer
set search_path = public
as $$
declare v_row jsonb; v_created record;
begin
  perform public.assert_daily_order_finance_actor();
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 1 then raise exception 'Rows must be a non-empty array'; end if;
  if jsonb_array_length(p_rows) > 500 then raise exception 'Daily order import cannot exceed 500 rows'; end if;
  for v_row in select value from jsonb_array_elements(p_rows) loop
    select * into v_created from public.create_finance_daily_order(
      (v_row->>'order_date')::date, (v_row->>'shop_id')::uuid, (v_row->>'salesperson_id')::uuid, v_row->>'order_number',
      (v_row->>'shipping_date')::date, v_row->>'shipping_number', (v_row->>'shipping_category')::public.daily_order_shipping_category,
      (v_row->>'product_id')::uuid, (v_row->>'quantity')::numeric,
      (v_row->>'sales_unit_price_amount')::numeric, (v_row->>'sales_unit_price_currency')::public.currency_code,
      (v_row->>'product_received_amount')::numeric, (v_row->>'product_received_currency')::public.currency_code,
      (v_row->>'logistics_fee_amount')::numeric, (v_row->>'logistics_fee_currency')::public.currency_code,
      (v_row->>'sales_total_amount')::numeric, (v_row->>'sales_total_currency')::public.currency_code,
      (v_row->>'payment_category')::public.daily_order_payment_category, v_row->>'remarks'
    );
    id := v_created.id; version := v_created.version; return next;
  end loop;
end;
$$;
revoke all on function public.bulk_create_finance_daily_orders(jsonb) from public;
grant execute on function public.bulk_create_finance_daily_orders(jsonb) to authenticated;

create or replace function public.void_finance_daily_order(p_order_id uuid, p_expected_version int)
returns public.finance_daily_orders
language plpgsql
security definer
set search_path = public
as $$
declare v_actor public.profiles%rowtype; v_order public.finance_daily_orders%rowtype;
begin
  v_actor := public.assert_daily_order_finance_actor();
  select * into v_order from public.finance_daily_orders where id = p_order_id for update;
  if not found then raise exception 'Daily order does not exist'; end if;
  if v_order.status = 'void' then raise exception 'Daily order is already voided'; end if;
  if v_order.version <> p_expected_version then raise exception 'Daily order version conflict'; end if;
  update public.finance_daily_orders set status = 'void', voided_at = now(), voided_by = v_actor.id,
    updated_by = v_actor.id, version = version + 1 where id = p_order_id returning * into v_order;
  return v_order;
end;
$$;
revoke all on function public.void_finance_daily_order(uuid, int) from public;
grant execute on function public.void_finance_daily_order(uuid, int) to authenticated;

create or replace function public.save_finance_daily_order_shop(
  p_shop_id uuid, p_name text, p_is_active boolean, p_salesperson_ids uuid[]
)
returns public.finance_daily_order_shops
language plpgsql
security definer
set search_path = public
as $$
declare v_actor public.profiles%rowtype; v_shop public.finance_daily_order_shops%rowtype; v_sales_id uuid;
begin
  v_actor := public.assert_daily_order_finance_actor();
  if nullif(btrim(p_name), '') is null or char_length(btrim(p_name)) > 100 then raise exception 'Invalid shop name'; end if;
  if coalesce(array_length(p_salesperson_ids, 1), 0) > 200 then raise exception 'Too many salespeople'; end if;
  foreach v_sales_id in array coalesce(p_salesperson_ids, array[]::uuid[]) loop
    if not exists (select 1 from public.profiles where id = v_sales_id and status::text = 'approved' and role::text = 'sales')
      then raise exception 'Salesperson does not exist or is not approved'; end if;
  end loop;
  if p_shop_id is null then
    insert into public.finance_daily_order_shops(name, is_active, created_by)
      values (btrim(p_name), p_is_active, v_actor.id) returning * into v_shop;
  else
    update public.finance_daily_order_shops set name = btrim(p_name), is_active = p_is_active
      where id = p_shop_id returning * into v_shop;
    if not found then raise exception 'Shop does not exist'; end if;
  end if;
  update public.finance_daily_order_shop_salespeople set is_active = false
    where shop_id = v_shop.id and salesperson_id <> all(coalesce(p_salesperson_ids, array[]::uuid[]));
  foreach v_sales_id in array coalesce(p_salesperson_ids, array[]::uuid[]) loop
    insert into public.finance_daily_order_shop_salespeople(shop_id, salesperson_id, is_active, created_by)
      values (v_shop.id, v_sales_id, true, v_actor.id)
    on conflict (shop_id, salesperson_id) do update set is_active = true;
  end loop;
  return v_shop;
end;
$$;
revoke all on function public.save_finance_daily_order_shop(uuid, text, boolean, uuid[]) from public;
grant execute on function public.save_finance_daily_order_shop(uuid, text, boolean, uuid[]) to authenticated;

create or replace function public.bind_finance_daily_order_screenshot(
  p_order_id uuid, p_object_path text, p_original_name text, p_mime_type text, p_size_bytes bigint
)
returns public.finance_daily_order_screenshots
language plpgsql
security definer
set search_path = public
as $$
declare v_actor public.profiles%rowtype; v_result public.finance_daily_order_screenshots%rowtype;
begin
  v_actor := public.assert_daily_order_finance_actor();
  perform 1 from public.finance_daily_orders where id = p_order_id and status = 'active' for update;
  if not found then raise exception 'Daily order does not exist or is voided'; end if;
  if p_mime_type not in ('image/jpeg', 'image/png') or p_size_bytes <= 0 or p_size_bytes > 5242880 then raise exception 'Invalid screenshot type or size'; end if;
  if p_object_path !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$'
     or split_part(p_object_path, '/', 1) <> v_actor.id::text or split_part(p_object_path, '/', 2) <> p_order_id::text then raise exception 'Invalid screenshot path'; end if;
  select * into v_result from public.finance_daily_order_screenshots where object_path = p_object_path;
  if found then
    if v_result.order_id <> p_order_id or v_result.created_by is distinct from v_actor.id or v_result.status <> 'active' then
      raise exception 'Screenshot path is already bound';
    end if;
    return v_result;
  end if;
  if (select count(*) from public.finance_daily_order_screenshots where order_id = p_order_id and status = 'active') >= 10 then raise exception 'Daily order cannot have more than 10 screenshots'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'finance-daily-order-screenshots' and name = p_object_path) then raise exception 'Screenshot object does not exist'; end if;
  insert into public.finance_daily_order_screenshots(order_id, object_path, original_name, mime_type, size_bytes, created_by)
    values (p_order_id, p_object_path, nullif(btrim(p_original_name), ''), p_mime_type, p_size_bytes, v_actor.id)
    returning * into v_result;
  return v_result;
end;
$$;
revoke all on function public.bind_finance_daily_order_screenshot(uuid, text, text, text, bigint) from public;
grant execute on function public.bind_finance_daily_order_screenshot(uuid, text, text, text, bigint) to authenticated;

create or replace function public.remove_finance_daily_order_screenshot(p_screenshot_id uuid)
returns public.finance_daily_order_screenshots
language plpgsql
security definer
set search_path = public
as $$
declare v_actor public.profiles%rowtype; v_result public.finance_daily_order_screenshots%rowtype;
begin
  v_actor := public.assert_daily_order_finance_actor();
  select * into v_result from public.finance_daily_order_screenshots where id = p_screenshot_id for update;
  if not found then raise exception 'Screenshot does not exist'; end if;
  if v_result.status = 'void' then raise exception 'Screenshot is already removed'; end if;
  update public.finance_daily_order_screenshots set status = 'void', removed_at = now(), removed_by = v_actor.id
    where id = p_screenshot_id returning * into v_result;
  return v_result;
end;
$$;
revoke all on function public.remove_finance_daily_order_screenshot(uuid) from public;
grant execute on function public.remove_finance_daily_order_screenshot(uuid) to authenticated;

alter table public.finance_daily_order_shops enable row level security;
alter table public.finance_daily_order_shop_salespeople enable row level security;
alter table public.finance_daily_orders enable row level security;
alter table public.finance_daily_order_screenshots enable row level security;
revoke all on table public.finance_daily_order_shops, public.finance_daily_order_shop_salespeople,
  public.finance_daily_orders, public.finance_daily_order_screenshots from anon, authenticated;
grant select on table public.finance_daily_order_shops, public.finance_daily_order_shop_salespeople,
  public.finance_daily_orders, public.finance_daily_order_screenshots to authenticated;

drop policy if exists "daily_order_shops_select" on public.finance_daily_order_shops;
create policy "daily_order_shops_select" on public.finance_daily_order_shops for select to authenticated using (public.is_finance_or_admin());
drop policy if exists "daily_order_assignments_select" on public.finance_daily_order_shop_salespeople;
create policy "daily_order_assignments_select" on public.finance_daily_order_shop_salespeople for select to authenticated using (public.is_finance_or_admin());
drop policy if exists "daily_orders_select" on public.finance_daily_orders;
create policy "daily_orders_select" on public.finance_daily_orders for select to authenticated using (public.is_finance_or_admin());
drop policy if exists "daily_order_screenshots_select" on public.finance_daily_order_screenshots;
create policy "daily_order_screenshots_select" on public.finance_daily_order_screenshots for select to authenticated using (public.is_finance_or_admin());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('finance-daily-order-screenshots', 'finance-daily-order-screenshots', false, 5242880, array['image/jpeg', 'image/png']::text[])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "finance_daily_order_screenshots_insert" on storage.objects;
create policy "finance_daily_order_screenshots_insert" on storage.objects for insert to authenticated
with check (
  bucket_id = 'finance-daily-order-screenshots'
  and case
    when public.is_finance_or_admin()
      and array_length(storage.foldername(name), 1) = 2
      and (storage.foldername(name))[1] = (select auth.uid())::text
      and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$'
    then exists (select 1 from public.finance_daily_orders where id = ((storage.foldername(name))[2])::uuid and status = 'active')
    else false
  end
);
drop policy if exists "finance_daily_order_screenshots_select" on storage.objects;
create policy "finance_daily_order_screenshots_select" on storage.objects for select to authenticated
using (
  bucket_id = 'finance-daily-order-screenshots'
  and public.is_finance_or_admin()
  and array_length(storage.foldername(name), 1) = 2
  and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$'
);
drop policy if exists "finance_daily_order_screenshots_delete_unbound" on storage.objects;
create policy "finance_daily_order_screenshots_delete_unbound" on storage.objects for delete to authenticated
using (
  bucket_id = 'finance-daily-order-screenshots'
  and public.is_finance_or_admin()
  and array_length(storage.foldername(name), 1) = 2
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and not exists (
    select 1 from public.finance_daily_order_screenshots screenshot
    where screenshot.object_path = storage.objects.name
  )
);
-- 不创建 storage UPDATE policy；只允许上传者清理绑定失败的孤儿对象，已绑定及软作废截图永久保留审计。
