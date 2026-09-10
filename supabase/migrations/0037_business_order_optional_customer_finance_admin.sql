begin;

create or replace function public.guard_current_customer_assignment_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_customer_owner uuid;
begin
  if v_actor_id is null then
    return new;
  end if;

  select * into v_actor
  from public.profiles
  where id = v_actor_id
  for update;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Only approved users can create customer assets';
  end if;

  if tg_table_name = 'business_orders' then
    if v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
      raise exception 'Current user cannot create business orders';
    end if;
    if new.customer_id is null then
      if v_actor.role::text not in ('admin', 'finance') then
        raise exception 'Business order customer is required';
      end if;
      return new;
    end if;
  end if;

  select created_by into v_customer_owner
  from public.customers
  where id = new.customer_id
  for share;
  if not found then
    raise exception 'Customer does not exist';
  end if;

  if tg_table_name = 'business_orders' then
    if v_actor.role::text in ('sales', 'supervisor')
       and (
         new.salesperson_id is distinct from v_actor.id
         or v_customer_owner is distinct from v_actor.id
       ) then
      raise exception 'Business order salesperson must match the current customer owner';
    end if;
  elsif v_actor.role::text not in ('admin', 'finance')
        and v_customer_owner is distinct from v_actor.id then
    raise exception 'Customer is not manageable by current user';
  end if;

  return new;
end;
$$;
revoke all on function public.guard_current_customer_assignment_insert()
  from public, anon, authenticated, service_role;

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
      if not v_custom_product.is_shared and (
        v_order.customer_id is null
        or v_custom_product.customer_id is distinct from v_order.customer_id
      ) then
        raise exception 'Custom product is not available for this order customer';
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

create or replace function public.create_business_order(
  p_customer_id uuid,
  p_order_date date,
  p_fulfillment_type public.business_fulfillment_type,
  p_currency public.currency_code,
  p_exchange_rate_to_cny numeric,
  p_shipping_fee numeric,
  p_tracking_number text,
  p_sales_notes text,
  p_items jsonb
)
returns table (id uuid, order_number text, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_customer public.customers%rowtype;
  v_customer_snapshot jsonb := '{}'::jsonb;
  v_order public.business_orders%rowtype;
  v_subtotal numeric(18,2);
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Only approved sales, supervisor, admin, or finance users can create business orders';
  end if;
  if p_customer_id is null and v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Business order customer is required';
  end if;
  if p_order_date is null then raise exception 'Order date is required'; end if;
  if p_exchange_rate_to_cny is null or p_exchange_rate_to_cny <= 0
     or p_exchange_rate_to_cny > 1000000 then raise exception 'Exchange rate is invalid'; end if;
  if p_currency::text = 'CNY' and p_exchange_rate_to_cny <> 1 then
    raise exception 'CNY exchange rate must equal one';
  end if;
  if p_shipping_fee is null or p_shipping_fee < 0 or p_shipping_fee > 999999999999 then
    raise exception 'Shipping fee is invalid';
  end if;
  if char_length(coalesce(p_tracking_number, '')) > 200
     or char_length(coalesce(p_sales_notes, '')) > 2000 then
    raise exception 'Business order text exceeds maximum length';
  end if;

  if p_customer_id is not null then
    select * into v_customer from public.customers c where c.id = p_customer_id;
    if not found or (
      v_actor.role::text in ('sales', 'supervisor') and v_customer.created_by is distinct from v_uid
    ) then
      raise exception 'Customer does not exist or is not manageable by current user';
    end if;
    v_customer_snapshot := jsonb_build_object(
      'name', v_customer.name, 'company', v_customer.company,
      'email', v_customer.email, 'phone', v_customer.phone,
      'address', v_customer.address, 'city', v_customer.city,
      'state', v_customer.state, 'postal_code', v_customer.postal_code,
      'country', v_customer.country, 'contact_person', v_customer.contact_person
    );
  end if;

  insert into public.business_orders (
    order_number, customer_id, customer_snapshot, salesperson_id,
    salesperson_name_snapshot, order_date, fulfillment_type, currency,
    exchange_rate_to_cny, items_subtotal, shipping_fee, total_amount,
    tracking_number, sales_notes
  ) values (
    public.next_business_order_number(), p_customer_id, v_customer_snapshot,
    v_uid, coalesce(
      nullif(btrim(v_actor.chinese_name), ''),
      nullif(btrim(v_actor.full_name), ''),
      v_actor.email
    ),
    p_order_date, p_fulfillment_type, p_currency, p_exchange_rate_to_cny,
    0, p_shipping_fee, p_shipping_fee,
    nullif(btrim(p_tracking_number), ''), nullif(btrim(p_sales_notes), '')
  ) returning * into v_order;

  v_subtotal := public.replace_business_order_items(v_order.id, p_items);
  update public.business_orders bo
  set items_subtotal = v_subtotal, total_amount = v_subtotal + p_shipping_fee
  where bo.id = v_order.id returning * into v_order;

  perform public.write_business_order_audit(
    v_order.id, 'order', v_order.id, 'create', null, v_order.status, null,
    jsonb_build_object(
      'order', to_jsonb(v_order),
      'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order)
                         from public.business_order_items i
                         where i.order_id = v_order.id), '[]'::jsonb)
    ), null, v_uid
  );
  return query select v_order.id, v_order.order_number, v_order.version;
end;
$$;
revoke all on function public.create_business_order(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb
) from public, anon, authenticated, service_role;

create or replace function public.update_business_order(
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
  p_reason text
)
returns table (id uuid, order_number text, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_customer public.customers%rowtype;
  v_customer_snapshot jsonb := '{}'::jsonb;
  v_old jsonb;
  v_subtotal numeric(18,2);
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin') then
    raise exception 'Approved sales, supervisor, or admin account required';
  end if;
  select * into v_order from public.business_orders bo where bo.id = p_order_id for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if v_order.version <> p_expected_version then raise exception 'Business order version conflict'; end if;
  if v_order.status::text = 'completed' or v_order.closed_at is not null then
    raise exception 'Completed or closed business order cannot be edited';
  end if;
  if v_order.status::text not in ('draft', 'rejected') then
    raise exception 'Business order cannot be edited in current status';
  end if;
  if v_actor.role::text in ('sales', 'supervisor') and v_order.salesperson_id is distinct from v_uid then
    raise exception 'Sales user cannot edit another owner business order';
  end if;
  if p_customer_id is null and v_actor.role::text <> 'admin' then
    raise exception 'Business order customer is required';
  end if;
  if p_order_date is null then raise exception 'Order date is required'; end if;
  if p_exchange_rate_to_cny is null or p_exchange_rate_to_cny <= 0
     or p_exchange_rate_to_cny > 1000000 then raise exception 'Exchange rate is invalid'; end if;
  if p_currency::text = 'CNY' and p_exchange_rate_to_cny <> 1 then
    raise exception 'CNY exchange rate must equal one';
  end if;
  if p_shipping_fee is null or p_shipping_fee < 0 or p_shipping_fee > 999999999999 then
    raise exception 'Shipping fee is invalid';
  end if;
  if char_length(coalesce(p_tracking_number, '')) > 200
     or char_length(coalesce(p_sales_notes, '')) > 2000
     or char_length(coalesce(p_reason, '')) > 1000 then
    raise exception 'Business order text exceeds maximum length';
  end if;

  if p_customer_id is not null then
    select * into v_customer from public.customers c where c.id = p_customer_id;
    if not found or (
      v_actor.role::text in ('sales', 'supervisor') and v_customer.created_by is distinct from v_uid
    ) then
      raise exception 'Customer does not exist or is not manageable by current user';
    end if;
    v_customer_snapshot := jsonb_build_object(
      'name', v_customer.name, 'company', v_customer.company,
      'email', v_customer.email, 'phone', v_customer.phone,
      'address', v_customer.address, 'city', v_customer.city,
      'state', v_customer.state, 'postal_code', v_customer.postal_code,
      'country', v_customer.country, 'contact_person', v_customer.contact_person
    );
  end if;

  v_old := jsonb_build_object(
    'order', to_jsonb(v_order),
    'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order)
                       from public.business_order_items i
                       where i.order_id = v_order.id), '[]'::jsonb)
  );

  update public.business_orders bo set
    customer_id = p_customer_id,
    customer_snapshot = v_customer_snapshot
  where bo.id = v_order.id;

  v_subtotal := public.replace_business_order_items(v_order.id, p_items);

  update public.business_orders bo set
    customer_id = p_customer_id,
    customer_snapshot = v_customer_snapshot,
    order_date = p_order_date, fulfillment_type = p_fulfillment_type,
    currency = p_currency, exchange_rate_to_cny = p_exchange_rate_to_cny,
    items_subtotal = v_subtotal, shipping_fee = p_shipping_fee,
    total_amount = v_subtotal + p_shipping_fee,
    tracking_number = nullif(btrim(p_tracking_number), ''),
    sales_notes = nullif(btrim(p_sales_notes), ''), version = bo.version + 1
  where bo.id = v_order.id returning * into v_order;

  perform public.write_business_order_audit(
    v_order.id, 'order', v_order.id, 'update', v_order.status, v_order.status,
    v_old,
    jsonb_build_object(
      'order', to_jsonb(v_order),
      'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order)
                         from public.business_order_items i
                         where i.order_id = v_order.id), '[]'::jsonb)
    ), p_reason, v_uid
  );
  return query select v_order.id, v_order.order_number, v_order.version;
end;
$$;
revoke all on function public.update_business_order(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, text
) from public, anon, authenticated, service_role;

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
      raise exception 'Administrator or finance user can assign only approved sales, supervisor, or admin users';
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
  v_effective_sales_total := p_total_sales_amount;

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

create or replace function public.create_business_order_v4(
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
  p_total_sales_overridden boolean,
  p_receivable_received_difference_reason text
)
returns table (id uuid, order_number text, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_created record;
  v_order public.business_orders%rowtype;
  v_reason text := nullif(regexp_replace(
    coalesce(p_receivable_received_difference_reason, ''),
    '^[[:space:]]+|[[:space:]]+$',
    '',
    'g'
  ), '');
begin
  if char_length(coalesce(p_receivable_received_difference_reason, '')) > 1000 then
    raise exception 'Receivable and received amount difference reason cannot exceed 1000 characters';
  end if;

  select * into v_created
  from public.create_business_order_v3(
    p_customer_id, p_order_date, p_fulfillment_type, p_currency,
    p_exchange_rate_to_cny, p_shipping_fee, p_tracking_number, p_sales_notes,
    p_items, p_payment_due_date, p_shop_id, p_salesperson_id,
    p_external_order_number, p_daily_shipping_date, p_daily_shipping_number,
    p_daily_payment_category, p_total_product_received_amount,
    p_total_product_received_overridden, p_total_shipping_received_amount,
    p_total_shipping_received_overridden, p_total_sales_amount,
    p_total_sales_overridden
  );

  select * into v_order
  from public.business_orders bo
  where bo.id = v_created.id
  for update;

  if round(v_order.total_amount, 2) = round(v_order.total_sales_amount, 2) then
    v_reason := null;
  end if;

  update public.business_orders bo
  set receivable_received_difference_reason = v_reason
  where bo.id = v_order.id
  returning * into v_order;

  if v_reason is not null then
    perform public.write_business_order_audit(
      v_order.id, 'order', v_order.id, 'update', v_order.status, v_order.status,
      jsonb_build_object('receivable_received_difference_reason', null),
      jsonb_build_object(
        'total_amount', v_order.total_amount,
        'total_sales_amount', v_order.total_sales_amount,
        'receivable_received_difference_reason', v_reason
      ),
      v_reason,
      v_uid
    );
  end if;

  return query select v_created.id, v_created.order_number, v_created.version;
end;
$$;
revoke all on function public.create_business_order_v4(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb, date, uuid, uuid, text, date, text,
  public.daily_order_payment_category, numeric, boolean, numeric, boolean,
  numeric, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_business_order_v4(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb, date, uuid, uuid, text, date, text,
  public.daily_order_payment_category, numeric, boolean, numeric, boolean,
  numeric, boolean, text
) to authenticated;

create or replace function public.update_business_order_v4(
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
  p_total_sales_overridden boolean,
  p_receivable_received_difference_reason text
)
returns table (id uuid, order_number text, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_updated record;
  v_order public.business_orders%rowtype;
  v_old_reason text;
  v_reason text := nullif(regexp_replace(
    coalesce(p_receivable_received_difference_reason, ''),
    '^[[:space:]]+|[[:space:]]+$',
    '',
    'g'
  ), '');
  v_audit_reason text;
begin
  if char_length(coalesce(p_receivable_received_difference_reason, '')) > 1000 then
    raise exception 'Receivable and received amount difference reason cannot exceed 1000 characters';
  end if;

  v_audit_reason := coalesce(nullif(btrim(p_reason), ''), v_reason);

  select * into v_updated
  from public.update_business_order_v3(
    p_order_id, p_expected_version, p_customer_id, p_order_date,
    p_fulfillment_type, p_currency, p_exchange_rate_to_cny, p_shipping_fee,
    p_tracking_number, p_sales_notes, p_items, p_payment_due_date,
    v_audit_reason, p_shop_id, p_salesperson_id, p_external_order_number,
    p_daily_shipping_date, p_daily_shipping_number, p_daily_payment_category,
    p_total_product_received_amount, p_total_product_received_overridden,
    p_total_shipping_received_amount, p_total_shipping_received_overridden,
    p_total_sales_amount, p_total_sales_overridden
  );

  select * into v_order
  from public.business_orders bo
  where bo.id = v_updated.id
  for update;

  v_old_reason := v_order.receivable_received_difference_reason;
  if round(v_order.total_amount, 2) = round(v_order.total_sales_amount, 2) then
    v_reason := null;
  end if;

  update public.business_orders bo
  set receivable_received_difference_reason = v_reason
  where bo.id = v_order.id
  returning * into v_order;

  if v_old_reason is distinct from v_reason then
    perform public.write_business_order_audit(
      v_order.id,
      'order',
      v_order.id,
      'update',
      v_order.status,
      v_order.status,
      jsonb_build_object('receivable_received_difference_reason', v_old_reason),
      jsonb_build_object(
        'total_amount', v_order.total_amount,
        'total_sales_amount', v_order.total_sales_amount,
        'receivable_received_difference_reason', v_reason
      ),
      coalesce(v_audit_reason, '应收实收差额已归零'),
      v_uid
    );
  end if;

  return query select v_updated.id, v_updated.order_number, v_updated.version;
end;
$$;
revoke all on function public.update_business_order_v4(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text,
  uuid, uuid, text, date, text, public.daily_order_payment_category,
  numeric, boolean, numeric, boolean, numeric, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.update_business_order_v4(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text,
  uuid, uuid, text, date, text, public.daily_order_payment_category,
  numeric, boolean, numeric, boolean, numeric, boolean, text
) to authenticated;

create or replace function public.validate_business_order_receivable_received_gap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text;
begin
  select bo.receivable_received_difference_reason
    into v_reason
  from public.business_orders bo
  where bo.id = new.id;

  if not found then return null; end if;
  if char_length(coalesce(v_reason, '')) > 1000 then
    raise exception 'Receivable and received amount difference reason cannot exceed 1000 characters';
  end if;
  return null;
end;
$$;
revoke all on function public.validate_business_order_receivable_received_gap()
  from public, anon, authenticated, service_role;

alter table public.business_order_attachments
  drop constraint if exists business_order_attachments_size_bytes_check;
alter table public.business_order_attachments
  add constraint business_order_attachments_size_bytes_check
  check (size_bytes > 0 and size_bytes <= 20971520);

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
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved sales, supervisor, admin, or finance account required';
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
     or p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > 20971520 then
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
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved sales, supervisor, admin, or finance account required';
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

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'finance-daily-order-screenshots',
  'finance-daily-order-screenshots',
  false,
  20971520,
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
  public.is_approved_user()
  and bucket_id = 'finance-daily-order-screenshots'
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
        and actor.role::text in ('sales', 'supervisor', 'admin', 'finance')
        and bo.closed_at is null
        and bo.status::text in ('draft', 'rejected')
        and (actor.role::text in ('admin', 'finance') or bo.salesperson_id = actor.id)
    )
    else false
  end
);

create or replace function public.save_finance_daily_order_shop(
  p_shop_id uuid, p_name text, p_group_id uuid, p_is_active boolean,
  p_salesperson_ids uuid[], p_default_currency public.currency_code
)
returns public.finance_daily_order_shops
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_shop public.finance_daily_order_shops%rowtype;
  v_sales_id uuid;
  v_group_name text;
  v_default_currency public.currency_code;
begin
  v_actor := public.assert_daily_order_finance_actor();
  if nullif(btrim(p_name), '') is null or char_length(btrim(p_name)) > 100 then
    raise exception 'Invalid shop name';
  end if;
  if p_default_currency is null or p_default_currency::text not in ('CNY', 'USD') then
    raise exception 'Invalid shop currency';
  end if;
  if p_group_id is not null then
    select nullif(btrim(g.name), '')
      into v_group_name
    from public.finance_daily_order_shop_groups g
    where g.id = p_group_id;
    if not found then raise exception 'Shop group does not exist'; end if;
  end if;
  v_default_currency := case
    when v_group_name like '%1688%' then 'CNY'::public.currency_code
    when v_group_name like '%国际站%' then 'USD'::public.currency_code
    else p_default_currency
  end;
  if coalesce(array_length(p_salesperson_ids, 1), 0) > 200 then
    raise exception 'Too many salespeople';
  end if;
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
      values (btrim(p_name), p_group_id, p_is_active, v_default_currency, v_actor.id)
      returning * into v_shop;
  else
    update public.finance_daily_order_shops
      set name = btrim(p_name), group_id = p_group_id, is_active = p_is_active,
          default_currency = v_default_currency
      where id = p_shop_id
      returning * into v_shop;
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

update public.finance_daily_order_shops s
set default_currency = case
  when g.name like '%1688%' then 'CNY'::public.currency_code
  when g.name like '%国际站%' then 'USD'::public.currency_code
  else s.default_currency
end
from public.finance_daily_order_shop_groups g
where g.id = s.group_id
  and (g.name like '%1688%' or g.name like '%国际站%');

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
        if not v_custom_product.is_shared and (
          v_order.customer_id is null
          or v_custom_product.customer_id is distinct from v_order.customer_id
        ) then
          raise exception 'Custom product is not available for this order customer';
        end if;
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
