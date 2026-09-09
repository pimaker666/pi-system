-- 0034_restore_daily_order_entry.sql
-- Restore the former daily-order entry fields on business_orders, which remains
-- the only writable order source. Legacy finance_daily_orders stay archived.

-- -----------------------------------------------------------------------------
-- 1. Daily-entry fields on the canonical order and item tables
-- -----------------------------------------------------------------------------
alter table public.business_orders
  add column if not exists shop_id uuid references public.finance_daily_order_shops(id) on delete restrict,
  add column if not exists shop_name_snapshot text,
  add column if not exists shop_group_id uuid references public.finance_daily_order_shop_groups(id) on delete set null,
  add column if not exists shop_group_name_snapshot text,
  add column if not exists external_order_number text,
  add column if not exists daily_shipping_date date,
  add column if not exists daily_shipping_number text,
  add column if not exists daily_payment_category public.daily_order_payment_category,
  add column if not exists total_product_received_amount numeric(18,2),
  add column if not exists total_product_received_overridden boolean not null default false,
  add column if not exists total_shipping_received_amount numeric(18,2),
  add column if not exists total_shipping_received_overridden boolean not null default false,
  add column if not exists total_sales_amount numeric(18,2),
  add column if not exists total_sales_overridden boolean not null default false;

alter table public.business_orders
  drop constraint if exists business_orders_shop_snapshot_check,
  drop constraint if exists business_orders_shop_group_snapshot_check,
  drop constraint if exists business_orders_external_number_check,
  drop constraint if exists business_orders_daily_shipping_number_check,
  drop constraint if exists business_orders_daily_amounts_check,
  drop constraint if exists business_orders_daily_totals_balance_check,
  drop constraint if exists business_orders_daily_fields_complete_check;

alter table public.business_orders
  add constraint business_orders_shop_snapshot_check check (
    shop_name_snapshot is null
    or char_length(btrim(shop_name_snapshot)) between 1 and 100
  ),
  add constraint business_orders_shop_group_snapshot_check check (
    shop_group_name_snapshot is null
    or char_length(btrim(shop_group_name_snapshot)) between 1 and 100
  ),
  add constraint business_orders_external_number_check check (
    external_order_number is null
    or char_length(btrim(external_order_number)) between 1 and 200
  ),
  add constraint business_orders_daily_shipping_number_check check (
    daily_shipping_number is null
    or char_length(daily_shipping_number) <= 200
  ),
  add constraint business_orders_daily_amounts_check check (
    (total_product_received_amount is null or (
      total_product_received_amount >= 0 and total_product_received_amount <= 999999999999
    ))
    and (total_shipping_received_amount is null or (
      total_shipping_received_amount >= 0 and total_shipping_received_amount <= 999999999999
    ))
    and (total_sales_amount is null or (
      total_sales_amount >= 0 and total_sales_amount <= 999999999999
    ))
  ),
  add constraint business_orders_daily_totals_balance_check check (
    total_sales_amount is null
    or total_product_received_amount is null
    or total_shipping_received_amount is null
    or total_sales_amount = total_product_received_amount + total_shipping_received_amount
  ),
  add constraint business_orders_daily_fields_complete_check check (
    (
      shop_id is null
      and shop_name_snapshot is null
      and shop_group_id is null
      and shop_group_name_snapshot is null
      and external_order_number is null
      and daily_shipping_date is null
      and daily_shipping_number is null
      and daily_payment_category is null
      and total_product_received_amount is null
      and total_shipping_received_amount is null
      and total_sales_amount is null
      and not total_product_received_overridden
      and not total_shipping_received_overridden
      and not total_sales_overridden
    )
    or (
      shop_id is not null
      and shop_name_snapshot is not null
      and external_order_number is not null
      and daily_shipping_date is not null
      and daily_payment_category is not null
      and total_product_received_amount is not null
      and total_shipping_received_amount is not null
      and total_sales_amount is not null
    )
  );

alter table public.business_order_items
  add column if not exists daily_shipping_category public.daily_order_shipping_category,
  add column if not exists product_received_amount numeric(18,2),
  add column if not exists product_received_overridden boolean not null default false,
  add column if not exists logistics_fee_amount numeric(18,2),
  add column if not exists sales_total_amount numeric(18,2),
  add column if not exists sales_total_overridden boolean not null default false;

alter table public.business_order_items
  drop constraint if exists business_order_items_daily_amounts_check,
  drop constraint if exists business_order_items_daily_fields_complete_check;

alter table public.business_order_items
  add constraint business_order_items_daily_amounts_check check (
    (product_received_amount is null or (
      product_received_amount >= 0 and product_received_amount <= 999999999999
    ))
    and (logistics_fee_amount is null or (
      logistics_fee_amount >= 0 and logistics_fee_amount <= 999999999999
    ))
    and (sales_total_amount is null or (
      sales_total_amount >= 0 and sales_total_amount <= 999999999999
    ))
  ),
  add constraint business_order_items_daily_fields_complete_check check (
    (
      daily_shipping_category is null
      and product_received_amount is null
      and logistics_fee_amount is null
      and sales_total_amount is null
      and not product_received_overridden
      and not sales_total_overridden
    )
    or (
      daily_shipping_category is not null
      and product_received_amount is not null
      and logistics_fee_amount is not null
      and sales_total_amount is not null
    )
  );

comment on column public.business_orders.shop_group_name_snapshot is
  'Immutable shop-group name captured when daily-order fields are created or edited.';
comment on column public.business_orders.external_order_number is
  'External marketplace/order number formerly stored in finance_daily_orders.order_number.';
comment on column public.business_orders.daily_shipping_date is
  'Daily-order shipping date; separate from shipment event timestamps.';
comment on column public.business_orders.total_product_received_overridden is
  'True when the order-level product received total was manually overridden.';
comment on column public.business_orders.total_shipping_received_overridden is
  'True when the order-level shipping received total was manually overridden.';
comment on column public.business_orders.total_sales_overridden is
  'True when the order-level sales total was manually overridden.';

create index if not exists idx_business_orders_shop_date
  on public.business_orders (shop_id, order_date desc);
create index if not exists idx_business_orders_shop_group_date
  on public.business_orders (shop_group_id, order_date desc);
create index if not exists idx_business_orders_external_number
  on public.business_orders (external_order_number);
create index if not exists idx_business_orders_daily_shipping_date
  on public.business_orders (daily_shipping_date desc);
create index if not exists idx_business_orders_daily_payment_category
  on public.business_orders (daily_payment_category);
create index if not exists idx_business_order_items_daily_shipping_category
  on public.business_order_items (daily_shipping_category);

-- -----------------------------------------------------------------------------
-- 2. Lock restored fields once money or shipping records depend on the order
-- -----------------------------------------------------------------------------
create or replace function public.protect_business_order_daily_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if row(
    new.shop_id,
    new.shop_name_snapshot,
    new.shop_group_id,
    new.shop_group_name_snapshot,
    new.salesperson_id,
    new.salesperson_name_snapshot,
    new.external_order_number,
    new.daily_shipping_date,
    new.daily_shipping_number,
    new.daily_payment_category,
    new.total_product_received_amount,
    new.total_product_received_overridden,
    new.total_shipping_received_amount,
    new.total_shipping_received_overridden,
    new.total_sales_amount,
    new.total_sales_overridden
  ) is distinct from row(
    old.shop_id,
    old.shop_name_snapshot,
    old.shop_group_id,
    old.shop_group_name_snapshot,
    old.salesperson_id,
    old.salesperson_name_snapshot,
    old.external_order_number,
    old.daily_shipping_date,
    old.daily_shipping_number,
    old.daily_payment_category,
    old.total_product_received_amount,
    old.total_product_received_overridden,
    old.total_shipping_received_amount,
    old.total_shipping_received_overridden,
    old.total_sales_amount,
    old.total_sales_overridden
  ) and (
    exists (
      select 1
      from public.business_order_payment_allocations a
      join public.business_customer_transfers t on t.id = a.transfer_id
      where a.order_id = old.id
        and a.voided_at is null
        and t.voided_at is null
    )
    or exists (
      select 1
      from public.business_order_shipments s
      where s.order_id = old.id and s.voided_at is null
    )
  ) then
    raise exception 'Business order daily fields cannot be changed after payment or shipment';
  end if;
  return new;
end;
$$;
revoke all on function public.protect_business_order_daily_fields()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_protect_business_order_daily_fields on public.business_orders;
create trigger trg_protect_business_order_daily_fields
  before update on public.business_orders
  for each row execute function public.protect_business_order_daily_fields();

create or replace function public.protect_business_order_item_daily_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if row(
    new.daily_shipping_category,
    new.product_received_amount,
    new.product_received_overridden,
    new.logistics_fee_amount,
    new.sales_total_amount,
    new.sales_total_overridden
  ) is distinct from row(
    old.daily_shipping_category,
    old.product_received_amount,
    old.product_received_overridden,
    old.logistics_fee_amount,
    old.sales_total_amount,
    old.sales_total_overridden
  ) and (
    exists (
      select 1
      from public.business_order_payment_allocations a
      join public.business_customer_transfers t on t.id = a.transfer_id
      where a.order_id = old.order_id
        and a.voided_at is null
        and t.voided_at is null
    )
    or exists (
      select 1
      from public.business_order_shipments s
      where s.order_id = old.order_id and s.voided_at is null
    )
  ) then
    raise exception 'Business order item daily fields cannot be changed after payment or shipment';
  end if;
  return new;
end;
$$;
revoke all on function public.protect_business_order_item_daily_fields()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_protect_business_order_item_daily_fields
  on public.business_order_items;
create trigger trg_protect_business_order_item_daily_fields
  before update on public.business_order_items
  for each row execute function public.protect_business_order_item_daily_fields();

-- -----------------------------------------------------------------------------
-- 3. Private daily-field applicator shared by V3 create/update
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
     or v_actor.role::text not in ('sales', 'supervisor', 'admin') then
    raise exception 'Approved sales, supervisor, or admin account required';
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
  if v_actor.role::text = 'admin' then
    if v_salesperson.role::text not in ('sales', 'supervisor', 'admin') then
      raise exception 'Administrator can assign only approved sales, supervisor, or admin users';
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
-- 4. V3 order RPCs. V2 remains unchanged for compatibility.
-- -----------------------------------------------------------------------------
create or replace function public.create_business_order_v3(
  p_customer_id uuid,
  p_order_date date,
  p_fulfillment_type public.business_fulfillment_type,
  p_currency public.currency_code,
  p_exchange_rate_to_cny numeric,
  p_shipping_fee numeric,
  p_tracking_number text,
  p_sales_notes text,
  p_items jsonb,
  p_payment_due_date date,
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
  p_total_sales_overridden boolean
)
returns table (id uuid, order_number text, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_created record;
begin
  select * into v_created
  from public.create_business_order_v2(
    p_customer_id,
    p_order_date,
    p_fulfillment_type,
    p_currency,
    p_exchange_rate_to_cny,
    p_shipping_fee,
    p_tracking_number,
    p_sales_notes,
    p_items,
    p_payment_due_date
  );

  perform public.apply_business_order_daily_entry(
    v_created.id,
    p_shop_id,
    p_salesperson_id,
    p_external_order_number,
    p_daily_shipping_date,
    p_daily_shipping_number,
    p_daily_payment_category,
    p_total_product_received_amount,
    p_total_product_received_overridden,
    p_total_shipping_received_amount,
    p_total_shipping_received_overridden,
    p_total_sales_amount,
    p_total_sales_overridden,
    p_items,
    v_uid,
    true,
    'Set daily-order fields during V3 creation'
  );

  return query select v_created.id, v_created.order_number, v_created.version;
end;
$$;
revoke all on function public.create_business_order_v3(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb, date, uuid, uuid, text, date, text,
  public.daily_order_payment_category, numeric, boolean, numeric, boolean,
  numeric, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.create_business_order_v3(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb, date, uuid, uuid, text, date, text,
  public.daily_order_payment_category, numeric, boolean, numeric, boolean,
  numeric, boolean
) to authenticated;

create or replace function public.update_business_order_v3(
  p_order_id uuid,
  p_expected_version int,
  p_customer_id uuid,
  p_order_date date,
  p_fulfillment_type public.business_fulfillment_type,
  p_currency public.currency_code,
  p_exchange_rate_to_cny numeric,
  p_shipping_fee numeric,
  p_tracking_number text,
  p_sales_notes text,
  p_items jsonb,
  p_payment_due_date date,
  p_reason text,
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
  p_total_sales_overridden boolean
)
returns table (id uuid, order_number text, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_updated record;
begin
  select * into v_updated
  from public.update_business_order_v2(
    p_order_id,
    p_expected_version,
    p_customer_id,
    p_order_date,
    p_fulfillment_type,
    p_currency,
    p_exchange_rate_to_cny,
    p_shipping_fee,
    p_tracking_number,
    p_sales_notes,
    p_items,
    p_payment_due_date,
    p_reason
  );

  perform public.apply_business_order_daily_entry(
    v_updated.id,
    p_shop_id,
    p_salesperson_id,
    p_external_order_number,
    p_daily_shipping_date,
    p_daily_shipping_number,
    p_daily_payment_category,
    p_total_product_received_amount,
    p_total_product_received_overridden,
    p_total_shipping_received_amount,
    p_total_shipping_received_overridden,
    p_total_sales_amount,
    p_total_sales_overridden,
    p_items,
    v_uid,
    false,
    p_reason
  );

  return query select v_updated.id, v_updated.order_number, v_updated.version;
end;
$$;
revoke all on function public.update_business_order_v3(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text,
  uuid, uuid, text, date, text, public.daily_order_payment_category,
  numeric, boolean, numeric, boolean, numeric, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.update_business_order_v3(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text,
  uuid, uuid, text, date, text, public.daily_order_payment_category,
  numeric, boolean, numeric, boolean, numeric, boolean
) to authenticated;

-- -----------------------------------------------------------------------------
-- 5. Business-order attachments in the existing private screenshot bucket
-- -----------------------------------------------------------------------------
create table if not exists public.business_order_attachments (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid not null references public.business_orders(id) on delete restrict,
  object_path text not null unique,
  original_name text,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png')),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 5242880),
  status public.finance_record_status not null default 'active',
  created_by uuid references public.profiles(id) on delete set null,
  removed_by uuid references public.profiles(id) on delete set null,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint business_order_attachment_name_check check (
    original_name is null or char_length(original_name) <= 255
  ),
  constraint business_order_attachment_path_check check (
    object_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$'
  ),
  constraint business_order_attachment_removed_check check (
    (status = 'active' and removed_at is null and removed_by is null)
    or (status = 'void' and removed_at is not null and removed_by is not null)
  )
);
comment on table public.business_order_attachments is
  'Private JPEG/PNG attachments for canonical business orders; removed rows are retained for audit.';

create index if not exists idx_business_order_attachments_order
  on public.business_order_attachments (order_id, status, created_at);
create index if not exists idx_business_order_attachments_created_by
  on public.business_order_attachments (created_by);
create index if not exists idx_business_order_attachments_removed_by
  on public.business_order_attachments (removed_by);

alter table public.business_order_attachments enable row level security;
revoke all on table public.business_order_attachments
  from public, anon, authenticated, service_role;
grant select on table public.business_order_attachments to authenticated;

drop policy if exists "business_order_attachments_select"
  on public.business_order_attachments;
create policy "business_order_attachments_select"
  on public.business_order_attachments
  for select to authenticated
  using (public.can_view_business_order(order_id));

create or replace function public.bind_business_order_attachment(
  p_order_id uuid,
  p_object_path text,
  p_original_name text,
  p_mime_type text,
  p_size_bytes bigint
)
returns public.business_order_attachments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_object storage.objects%rowtype;
  v_result public.business_order_attachments%rowtype;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin') then
    raise exception 'Approved sales, supervisor, or admin account required';
  end if;

  select * into v_order
  from public.business_orders bo
  where bo.id = p_order_id
  for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if v_order.closed_at is not null or v_order.status::text not in ('draft', 'rejected') then
    raise exception 'Business order attachments cannot be changed in current status';
  end if;
  if v_actor.role::text in ('sales', 'supervisor')
     and v_order.salesperson_id is distinct from v_uid then
    raise exception 'Sales user cannot edit another owner business order';
  end if;

  if p_mime_type not in ('image/jpeg', 'image/png')
     or p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > 5242880 then
    raise exception 'Invalid attachment type or size';
  end if;
  if char_length(coalesce(p_original_name, '')) > 255 then
    raise exception 'Attachment name cannot exceed 255 characters';
  end if;
  if p_object_path !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$'
     or split_part(p_object_path, '/', 1) <> v_uid::text
     or split_part(p_object_path, '/', 2) <> p_order_id::text then
    raise exception 'Invalid attachment path';
  end if;

  select * into v_object
  from storage.objects o
  where o.bucket_id = 'finance-daily-order-screenshots'
    and o.name = p_object_path;
  if not found then raise exception 'Attachment object does not exist'; end if;
  if lower(coalesce(v_object.metadata->>'mimetype', '')) <> p_mime_type
     or coalesce(v_object.metadata->>'size', '') !~ '^\d+$'
     or (v_object.metadata->>'size')::bigint <> p_size_bytes then
    raise exception 'Attachment object metadata does not match';
  end if;

  select * into v_result
  from public.business_order_attachments a
  where a.object_path = p_object_path;
  if found then
    if v_result.order_id is distinct from p_order_id
       or v_result.created_by is distinct from v_uid
       or v_result.status::text <> 'active'
       or v_result.mime_type <> p_mime_type
       or v_result.size_bytes <> p_size_bytes then
      raise exception 'Attachment path is already bound';
    end if;
    return v_result;
  end if;

  if (
    select count(*)
    from public.business_order_attachments a
    where a.order_id = p_order_id and a.status::text = 'active'
  ) >= 10 then
    raise exception 'Business order cannot have more than 10 attachments';
  end if;

  insert into public.business_order_attachments (
    order_id, object_path, original_name, mime_type, size_bytes, created_by
  ) values (
    p_order_id, p_object_path, nullif(btrim(p_original_name), ''),
    p_mime_type, p_size_bytes, v_uid
  ) returning * into v_result;

  return v_result;
end;
$$;
revoke all on function public.bind_business_order_attachment(uuid, text, text, text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.bind_business_order_attachment(uuid, text, text, text, bigint)
  to authenticated;

create or replace function public.remove_business_order_attachment(p_attachment_id uuid)
returns public.business_order_attachments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_result public.business_order_attachments%rowtype;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin') then
    raise exception 'Approved sales, supervisor, or admin account required';
  end if;

  select * into v_result
  from public.business_order_attachments a
  where a.id = p_attachment_id
  for update;
  if not found then raise exception 'Business order attachment does not exist'; end if;
  if v_result.status::text = 'void' then raise exception 'Business order attachment is already removed'; end if;

  select * into v_order
  from public.business_orders bo
  where bo.id = v_result.order_id
  for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if v_order.closed_at is not null or v_order.status::text not in ('draft', 'rejected') then
    raise exception 'Business order attachments cannot be changed in current status';
  end if;
  if v_actor.role::text in ('sales', 'supervisor')
     and v_order.salesperson_id is distinct from v_uid then
    raise exception 'Sales user cannot edit another owner business order';
  end if;

  update public.business_order_attachments a
  set status = 'void', removed_at = now(), removed_by = v_uid
  where a.id = p_attachment_id
  returning * into v_result;
  return v_result;
end;
$$;
revoke all on function public.remove_business_order_attachment(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.remove_business_order_attachment(uuid)
  to authenticated;

-- -----------------------------------------------------------------------------
-- 6. Reuse the legacy private bucket without breaking legacy screenshot reads
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'finance-daily-order-screenshots',
  'finance-daily-order-screenshots',
  false,
  5242880,
  array['image/jpeg', 'image/png']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "finance_daily_order_screenshots_insert" on storage.objects;
create policy "finance_daily_order_screenshots_insert"
  on storage.objects for insert to authenticated
with check (
  bucket_id = 'finance-daily-order-screenshots'
  and case
    when array_length(storage.foldername(name), 1) = 2
      and (storage.foldername(name))[1] = (select auth.uid())::text
      and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$'
    then exists (
      select 1
      from public.business_orders bo
      join public.profiles actor on actor.id = (select auth.uid())
      where bo.id = ((storage.foldername(name))[2])::uuid
        and actor.status::text = 'approved'
        and actor.role::text in ('sales', 'supervisor', 'admin')
        and bo.closed_at is null
        and bo.status::text in ('draft', 'rejected')
        and (actor.role::text = 'admin' or bo.salesperson_id = actor.id)
    )
    else false
  end
);

drop policy if exists "finance_daily_order_screenshots_select" on storage.objects;
create policy "finance_daily_order_screenshots_select"
  on storage.objects for select to authenticated
using (
  bucket_id = 'finance-daily-order-screenshots'
  and case
    when array_length(storage.foldername(name), 1) = 2
      and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$'
    then (
      public.is_finance_or_admin()
      or exists (
        select 1
        from public.finance_daily_orders legacy_order
        where legacy_order.id = ((storage.foldername(name))[2])::uuid
          and (
            legacy_order.salesperson_id = (select auth.uid())
            or public.is_my_subordinate(legacy_order.salesperson_id)
          )
      )
      or public.can_view_business_order(((storage.foldername(name))[2])::uuid)
    )
    else false
  end
);

create or replace function public.daily_order_screenshot_object_is_unbound(p_object_path text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select not exists (
    select 1
    from public.finance_daily_order_screenshots legacy_attachment
    where legacy_attachment.object_path = p_object_path
  ) and not exists (
    select 1
    from public.business_order_attachments attachment
    where attachment.object_path = p_object_path
  );
$$;
comment on function public.daily_order_screenshot_object_is_unbound(text) is
  'RLS-independent check used by the storage delete policy so that bound or soft-removed audit evidence can never be deleted.';
revoke all on function public.daily_order_screenshot_object_is_unbound(text)
  from public, anon, authenticated, service_role;
grant execute on function public.daily_order_screenshot_object_is_unbound(text) to authenticated;

drop policy if exists "finance_daily_order_screenshots_delete_unbound" on storage.objects;
create policy "finance_daily_order_screenshots_delete_unbound"
  on storage.objects for delete to authenticated
using (
  bucket_id = 'finance-daily-order-screenshots'
  and array_length(storage.foldername(name), 1) = 2
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and public.daily_order_screenshot_object_is_unbound(storage.objects.name)
);

-- No storage UPDATE policy is created. Bound and soft-removed objects remain
-- immutable audit evidence; only the uploader can delete an unbound object.

-- -----------------------------------------------------------------------------
-- 7. V3 becomes the only client-callable order write path
-- -----------------------------------------------------------------------------
-- V1/V2 stay available to SECURITY DEFINER callers (V3 wraps them), but direct
-- client execution is revoked: it could write business_orders while skipping the
-- restored daily-order fields and their consistency checks.
revoke execute on function public.create_business_order(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb
) from authenticated;
revoke execute on function public.update_business_order(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, text
) from authenticated;
revoke execute on function public.create_business_order_v2(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb, date
) from authenticated;
revoke execute on function public.update_business_order_v2(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text
) from authenticated;

-- -----------------------------------------------------------------------------
-- 8. Shop assignment candidates match business-order owner candidates
-- -----------------------------------------------------------------------------
-- 0027 limited shop assignment to ('sales', 'admin'), but business orders treat
-- supervisors as first-class owners (they may create their own orders). Without
-- this alignment a supervisor can never satisfy the shop-assignment check in
-- apply_business_order_daily_entry, so daily-order entry would be impossible for
-- them. Everything else keeps the 0027 behaviour.
create or replace function public.save_finance_daily_order_shop(
  p_shop_id uuid, p_name text, p_group_id uuid, p_is_active boolean,
  p_salesperson_ids uuid[], p_default_currency public.currency_code
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
  if p_default_currency is null or p_default_currency::text not in ('CNY', 'USD') then raise exception 'Invalid shop currency'; end if;
  if p_group_id is not null and not exists (select 1 from public.finance_daily_order_shop_groups where id = p_group_id)
    then raise exception 'Shop group does not exist'; end if;
  if coalesce(array_length(p_salesperson_ids, 1), 0) > 200 then raise exception 'Too many salespeople'; end if;
  foreach v_sales_id in array coalesce(p_salesperson_ids, array[]::uuid[]) loop
    if not exists (
      select 1 from public.profiles
      where id = v_sales_id
        and status::text = 'approved'
        and role::text in ('sales', 'supervisor', 'admin')
    ) then raise exception 'Salesperson does not exist or is not approved'; end if;
  end loop;
  if p_shop_id is null then
    insert into public.finance_daily_order_shops(name, group_id, is_active, default_currency, created_by)
      values (btrim(p_name), p_group_id, p_is_active, p_default_currency, v_actor.id) returning * into v_shop;
  else
    update public.finance_daily_order_shops
      set name = btrim(p_name), group_id = p_group_id, is_active = p_is_active, default_currency = p_default_currency
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
revoke all on function public.save_finance_daily_order_shop(
  uuid, text, uuid, boolean, uuid[], public.currency_code
) from public, anon, authenticated, service_role;
grant execute on function public.save_finance_daily_order_shop(
  uuid, text, uuid, boolean, uuid[], public.currency_code
) to authenticated;


-- -----------------------------------------------------------------------------
-- 9. Sales and supervisors can read the shop reference data they need
-- -----------------------------------------------------------------------------
-- 0018/0024 restricted shops, shop groups and assignments to finance/admin,
-- because only finance created legacy daily orders. Now that shop_id is a
-- mandatory field of every business order created by sales/supervisor/admin, the
-- entry form must be able to list the shops the actor is actively assigned to.
-- The helpers are SECURITY DEFINER so the policies are not blinded by the RLS of
-- the assignment table itself; both stay read-only.
create or replace function public.can_view_daily_order_shop(p_shop_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.is_finance_or_admin()
     or exists (
       select 1
       from public.finance_daily_order_shop_salespeople a
       join public.profiles actor on actor.id = (select auth.uid())
       where a.shop_id = p_shop_id
         and a.is_active
         and actor.status::text = 'approved'
         and actor.role::text in ('sales', 'supervisor', 'admin')
         and (a.salesperson_id = actor.id or public.is_my_subordinate(a.salesperson_id))
     );
$$;
comment on function public.can_view_daily_order_shop(uuid) is
  'Read-only visibility helper: finance/admin see every shop, approved sales/supervisor see shops assigned to themselves or their subordinates.';
revoke all on function public.can_view_daily_order_shop(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.can_view_daily_order_shop(uuid) to authenticated;

create or replace function public.can_view_daily_order_shop_group(p_group_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.is_finance_or_admin()
     or exists (
       select 1
       from public.finance_daily_order_shops s
       where s.group_id = p_group_id
         and public.can_view_daily_order_shop(s.id)
     );
$$;
comment on function public.can_view_daily_order_shop_group(uuid) is
  'Read-only visibility helper: a shop group is visible when at least one of its shops is visible to the actor.';
revoke all on function public.can_view_daily_order_shop_group(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.can_view_daily_order_shop_group(uuid) to authenticated;

drop policy if exists "daily_order_shops_select" on public.finance_daily_order_shops;
create policy "daily_order_shops_select"
  on public.finance_daily_order_shops
  for select to authenticated
  using (public.can_view_daily_order_shop(id));

drop policy if exists "daily_order_shop_groups_select" on public.finance_daily_order_shop_groups;
create policy "daily_order_shop_groups_select"
  on public.finance_daily_order_shop_groups
  for select to authenticated
  using (public.can_view_daily_order_shop_group(id));

drop policy if exists "daily_order_assignments_select" on public.finance_daily_order_shop_salespeople;
create policy "daily_order_assignments_select"
  on public.finance_daily_order_shop_salespeople
  for select to authenticated
  using (
    public.is_finance_or_admin()
    or salesperson_id = (select auth.uid())
    or public.is_my_subordinate(salesperson_id)
  );
