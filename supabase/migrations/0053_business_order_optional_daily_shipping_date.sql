-- 0053 业务订单发货日期可留空
--
-- V3/V4 保留原有必填语义；新增 V5 作为发货日期可空的唯一客户端写入路径。

begin;

alter table public.business_orders
  drop constraint if exists business_orders_daily_fields_complete_check;

alter table public.business_orders
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
      and daily_payment_category is not null
      and total_product_received_amount is not null
      and total_shipping_received_amount is not null
      and total_sales_amount is not null
    )
  );

comment on column public.business_orders.daily_shipping_date is
  '发货日期，非必填；留空落 NULL，不以订单日期或占位日期替代';

create or replace function public.apply_business_order_daily_entry_v2(
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

  if char_length(coalesce(btrim(p_external_order_number), '')) > 200 then
    raise exception 'External order number cannot exceed 200 characters';
  end if;
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
      external_order_number = nullif(btrim(p_external_order_number), ''),
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

  perform public.business_refresh_order_payment_status(p_order_id);

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
revoke all on function public.apply_business_order_daily_entry_v2(
  uuid, uuid, uuid, text, date, text, public.daily_order_payment_category,
  numeric, boolean, numeric, boolean, numeric, boolean, jsonb, uuid, boolean, text
) from public, anon, authenticated, service_role;

create or replace function public.create_business_order_v5(
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
  p_receivable_received_difference_reason text,
  p_payment_account text
)
returns table (id uuid, order_number text, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_created record;
  v_order public.business_orders%rowtype;
  v_before jsonb;
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
  if char_length(coalesce(p_payment_account, '')) > 200 then
    raise exception 'Payment account cannot exceed 200 characters';
  end if;

  select * into v_actor from public.profiles p where p.id = v_uid;

  select * into v_created
  from public.create_business_order_v2(
    p_customer_id, p_order_date, p_fulfillment_type, p_currency,
    p_exchange_rate_to_cny, p_shipping_fee, p_tracking_number, p_sales_notes,
    p_items, p_payment_due_date
  );

  perform public.apply_business_order_daily_entry_v2(
    v_created.id, p_shop_id, p_salesperson_id, p_external_order_number,
    p_daily_shipping_date, p_daily_shipping_number, p_daily_payment_category,
    p_total_product_received_amount, p_total_product_received_overridden,
    p_total_shipping_received_amount, p_total_shipping_received_overridden,
    p_total_sales_amount, p_total_sales_overridden, p_items, v_uid, true,
    'Set daily-order fields during V5 creation'
  );

  select * into v_order
  from public.business_orders bo
  where bo.id = v_created.id
  for update;

  update public.business_orders bo
  set payment_account = nullif(btrim(p_payment_account), '')
  where bo.id = v_order.id
  returning * into v_order;

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

  if v_actor.role::text in ('admin', 'finance') then
    v_before := to_jsonb(v_order);
    update public.business_orders bo
    set status = 'approved',
        approval_status = 'approved',
        submitted_by = v_uid,
        submitted_at = now(),
        reviewed_by = v_uid,
        reviewed_at = now(),
        version = bo.version + 1
    where bo.id = v_order.id
    returning * into v_order;

    perform public.write_business_order_audit(
      v_order.id, 'order', v_order.id, 'approve',
      (v_before->>'status')::public.business_order_status, v_order.status,
      v_before, to_jsonb(v_order), '管理员或财务建单免审核', v_uid
    );
  end if;

  return query select v_order.id, v_order.order_number, v_order.version;
end;
$$;
revoke all on function public.create_business_order_v5(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb, date, uuid, uuid, text, date, text,
  public.daily_order_payment_category, numeric, boolean, numeric, boolean,
  numeric, boolean, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_business_order_v5(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb, date, uuid, uuid, text, date, text,
  public.daily_order_payment_category, numeric, boolean, numeric, boolean,
  numeric, boolean, text, text
) to authenticated;

create or replace function public.update_business_order_v5(
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
  p_receivable_received_difference_reason text,
  p_payment_account text
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
  if char_length(coalesce(p_payment_account, '')) > 200 then
    raise exception 'Payment account cannot exceed 200 characters';
  end if;

  select * into v_updated
  from public.update_business_order_v2(
    p_order_id, p_expected_version, p_customer_id, p_order_date, p_fulfillment_type,
    p_currency, p_exchange_rate_to_cny, p_shipping_fee, p_tracking_number,
    p_sales_notes, p_items, p_payment_due_date, p_reason
  );

  perform public.apply_business_order_daily_entry_v2(
    v_updated.id, p_shop_id, p_salesperson_id, p_external_order_number,
    p_daily_shipping_date, p_daily_shipping_number, p_daily_payment_category,
    p_total_product_received_amount, p_total_product_received_overridden,
    p_total_shipping_received_amount, p_total_shipping_received_overridden,
    p_total_sales_amount, p_total_sales_overridden, p_items, v_uid, false, p_reason
  );

  select * into v_order
  from public.business_orders bo
  where bo.id = v_updated.id
  for update;

  update public.business_orders bo
  set payment_account = nullif(btrim(p_payment_account), '')
  where bo.id = v_order.id
  returning * into v_order;

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

  return query select v_order.id, v_order.order_number, v_order.version;
end;
$$;
revoke all on function public.update_business_order_v5(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text, uuid,
  uuid, text, date, text, public.daily_order_payment_category, numeric, boolean,
  numeric, boolean, numeric, boolean, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.update_business_order_v5(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text, uuid,
  uuid, text, date, text, public.daily_order_payment_category, numeric, boolean,
  numeric, boolean, numeric, boolean, text, text
) to authenticated;

commit;
