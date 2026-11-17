-- 0149_row_scoped_allocation_lock.sql
-- 分摊锁改为按行，解决“同单其他产品有有效分摊，导致本行取消发货并作废转账后仍不能删除/换产品/改单价”。
--   1. protect_business_order_item_invariants：只有指向本行的有效分摊（分摊未作废且转账未作废）才锁删除/换产品。
--   2. get_business_order_edit_constraints：逐行返回 has_active_allocation / active_allocated_amount，
--      can_delete / can_replace_product / can_change_unit_price 改按行判断；根级 has_active_allocation 保留整单口径。
--   3. replace_business_order_items：删除明细行前，清理指向该行的失效分摊（转账已作废或分摊已作废），
--      否则 order_item_id 外键 RESTRICT 会拦住删除；清理写入订单审计。
--   4. update_business_order：调整后订单总额不得低于当前整单有效分摊合计，拦截删除/减价造成的超收。
--   5. adjust_business_order_items_internal_0141：追加行的删除同样只被本行有效分摊拦截，失效分摊自动清理并写审计。

begin;

create or replace function public.protect_business_order_item_invariants()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_order public.business_orders%rowtype;
  v_has_allocation boolean;
  v_has_shipment boolean;
  v_net_shipped numeric;
begin
  select * into v_order
  from public.business_orders
  where id = case when tg_op = 'INSERT' then new.order_id else old.order_id end;

  if not found then
    raise exception 'Business order does not exist';
  end if;
  if v_order.voided_at is not null then
    raise exception 'Voided business order items are immutable';
  end if;
  if v_order.status::text = 'completed' or v_order.closed_at is not null then
    raise exception 'Completed or closed order items are immutable';
  end if;

  if tg_op = 'INSERT' then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.order_id is distinct from old.order_id then
    raise exception 'Order item cannot be moved to another order';
  end if;

  select exists (
    select 1
    from public.business_order_payment_allocations a
    join public.business_customer_transfers t on t.id = a.transfer_id
    where a.order_item_id = old.id
      and a.allocation_target = 'item'
      and a.voided_at is null
      and t.voided_at is null
  ) into v_has_allocation;
  select exists (
    select 1
    from public.business_order_shipment_items si
    join public.business_order_shipments s on s.id = si.shipment_id
    where si.order_item_id = old.id and s.voided_at is null
  ) into v_has_shipment;

  v_net_shipped := public.business_order_item_net_shipped(old.id);

  if tg_op = 'DELETE' then
    if v_has_allocation then
      raise exception 'Order items cannot be deleted after an active payment allocation';
    end if;
    if v_has_shipment then
      raise exception 'Shipped order items cannot be deleted';
    end if;
    return old;
  end if;

  if v_has_allocation and (
    new.source_type is distinct from old.source_type
    or new.product_id is distinct from old.product_id
    or new.custom_product_id is distinct from old.custom_product_id
  ) then
    raise exception 'Order item product cannot be replaced after an active payment allocation';
  end if;
  if v_has_shipment and (
    new.source_type is distinct from old.source_type
    or new.product_id is distinct from old.product_id
    or new.custom_product_id is distinct from old.custom_product_id
    or new.custom_product_version_id is distinct from old.custom_product_version_id
  ) then
    raise exception 'Shipped order item product cannot be replaced';
  end if;
  if new.quantity < v_net_shipped then
    raise exception 'Order item quantity cannot be less than net shipped quantity';
  end if;

  return new;
end;
$function$;

create or replace function public.get_business_order_edit_constraints(p_order_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_order public.business_orders%rowtype;
  v_actor public.profiles%rowtype;
  v_allocated numeric;
  v_shipped_value numeric;
  v_can_adjust boolean;
  v_items jsonb;
begin
  if not public.can_view_business_order(p_order_id) then
    raise exception 'Business order is not accessible';
  end if;
  select * into v_order from public.business_orders bo where bo.id = p_order_id;
  if not found then raise exception 'Business order does not exist'; end if;
  select * into v_actor from public.profiles p where p.id = (select auth.uid());

  select coalesce(sum(a.amount), 0) into v_allocated
  from public.business_order_payment_allocations a
  join public.business_customer_transfers t on t.id = a.transfer_id
  where a.order_id = p_order_id and a.voided_at is null and t.voided_at is null;

  select coalesce(sum(round(public.business_order_item_net_shipped(i.id) * i.unit_price, 4)), 0)
    into v_shipped_value
  from public.business_order_items i
  where i.order_id = p_order_id;

  v_can_adjust := v_order.voided_at is null
    and v_order.status::text = 'approved'
    and v_order.approval_status = 'approved'
    and v_order.closed_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
    'order_item_id', i.id,
    'source_type', i.source_type,
    'product_id', i.product_id,
    'custom_product_id', i.custom_product_id,
    'custom_product_version_id', i.custom_product_version_id,
    'ordered_quantity', i.quantity,
    'unit_price', i.unit_price,
    'gross_shipped_quantity', coalesce(q.gross_shipped, 0),
    'returned_quantity', coalesce(q.returned, 0),
    'net_shipped_quantity', coalesce(q.gross_shipped, 0) - coalesce(q.returned, 0),
    'minimum_quantity', coalesce(q.gross_shipped, 0) - coalesce(q.returned, 0),
    'has_active_allocation', coalesce(qa.allocated, 0) > 0,
    'active_allocated_amount', coalesce(qa.allocated, 0),
    'can_delete', v_order.voided_at is null and v_order.status::text <> 'completed'
                  and v_order.closed_at is null and coalesce(qa.allocated, 0) = 0
                  and coalesce(q.gross_shipped, 0) = 0,
    'can_replace_product', v_order.voided_at is null and v_order.status::text <> 'completed'
                           and v_order.closed_at is null and coalesce(qa.allocated, 0) = 0
                           and coalesce(q.gross_shipped, 0) = 0,
    'can_change_unit_price', v_order.voided_at is null and v_order.status::text <> 'completed'
                             and v_order.closed_at is null and coalesce(qa.allocated, 0) = 0,
    'can_increase_quantity', v_can_adjust
  ) order by i.sort_order, i.id), '[]'::jsonb) into v_items
  from public.business_order_items i
  left join lateral (
    select coalesce(sum(a.amount), 0) as allocated
    from public.business_order_payment_allocations a
    join public.business_customer_transfers t on t.id = a.transfer_id
    where a.order_item_id = i.id
      and a.allocation_target = 'item'
      and a.voided_at is null
      and t.voided_at is null
  ) qa on true
  left join lateral (
    select
      coalesce(sum(si.quantity) filter (where s.voided_at is null), 0) as gross_shipped,
      coalesce((select sum(ri.quantity)
                from public.business_order_return_items ri
                join public.business_order_returns r on r.id = ri.return_id
                join public.business_order_shipment_items source_si on source_si.id = ri.shipment_item_id
                join public.business_order_shipments source_s on source_s.id = source_si.shipment_id
                where ri.order_item_id = i.id and r.voided_at is null
                  and source_s.voided_at is null), 0) as returned
    from public.business_order_shipment_items si
    join public.business_order_shipments s on s.id = si.shipment_id
    where si.order_item_id = i.id
  ) q on true
  where i.order_id = p_order_id;

  return jsonb_build_object(
    'order_id', v_order.id,
    'version', v_order.version,
    'status', v_order.status::text,
    'is_closed', v_order.closed_at is not null,
    'is_completed', v_order.status::text = 'completed',
    'is_voided', v_order.voided_at is not null,
    'voided_at', v_order.voided_at,
    'voided_by', v_order.voided_by,
    'void_reason', v_order.void_reason,
    'has_active_allocation', v_allocated > 0,
    'active_allocated_amount', v_allocated,
    'daily_received_amount', v_order.total_sales_amount,
    'items_subtotal', v_order.items_subtotal,
    'shipping_fee', v_order.shipping_fee,
    'total_amount', v_order.total_amount,
    'shipped_value', v_shipped_value,
    'available_balance', round(v_allocated - v_shipped_value, 4),
    'can_edit_order', public.business_order_accepts_entry_edits(
      v_order.id, coalesce(v_actor.role::text, '')
    ),
    'can_adjust_items', v_can_adjust,
    'can_overship', v_can_adjust,
    'can_add_allocation', v_order.voided_at is null
                          and v_order.status::text <> 'completed'
                          and v_order.closed_at is null,
    'can_add_shipment', v_order.voided_at is null
                        and v_order.status::text = 'approved'
                        and v_order.approval_status = 'approved'
                        and v_order.closed_at is null,
    'items', v_items
  );
end;
$function$;

create or replace function public.replace_business_order_items(p_order_id uuid, p_items jsonb)
 returns numeric
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_item jsonb;
  v_order public.business_orders%rowtype;
  v_existing public.business_order_items%rowtype;
  v_dead public.business_order_payment_allocations%rowtype;
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
  v_subtotal numeric(18,4) := 0;
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
    v_unit_price := round((v_item->>'unit_price')::numeric, 4);
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
      if not found then
        raise exception 'Product does not exist';
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
    v_subtotal := v_subtotal + round(v_quantity * v_unit_price, 4);
    v_sort_order := v_sort_order + 1;
  end loop;

  if exists (
    select 1
    from public.business_order_shipment_items si
    join public.business_order_shipments s on s.id = si.shipment_id
    where s.order_id = p_order_id
      and s.voided_at is null
      and not (si.order_item_id = any(v_matched_ids))
  ) then
    raise exception 'Shipped items cannot be removed; void the shipment batch first';
  end if;

  -- 清理指向被删除行的失效分摊（转账已作废或分摊已作废），否则外键 RESTRICT 会拦住删除。
  -- 仍有效（转账未作废且分摊未作废）的分摊保留，由明细守卫拦截删除。
  for v_dead in
    select a.*
    from public.business_order_payment_allocations a
    join public.business_customer_transfers t on t.id = a.transfer_id
    where a.order_id = p_order_id
      and a.order_item_id is not null
      and not (a.order_item_id = any(v_matched_ids))
      and (a.voided_at is not null or t.voided_at is not null)
  loop
    if v_uid is not null then
      perform public.write_business_order_audit(
        p_order_id, 'payment', v_dead.id, 'payment_void',
        v_order.status, v_order.status,
        to_jsonb(v_dead),
        jsonb_build_object('reason', 'Order item removed; inactive allocation cleaned'),
        'Order item removed', v_uid
      );
    end if;
    delete from public.business_order_payment_allocations a where a.id = v_dead.id;
  end loop;

  delete from public.business_order_items
  where order_id = p_order_id and not (id = any(v_matched_ids));
  return v_subtotal;
end;
$function$;

create or replace function public.update_business_order(p_order_id uuid, p_expected_version integer, p_customer_id uuid, p_order_date date, p_fulfillment_type business_fulfillment_type, p_currency currency_code, p_exchange_rate_to_cny numeric, p_shipping_fee numeric, p_tracking_number text, p_sales_notes text, p_items jsonb, p_reason text)
 returns table(id uuid, order_number text, version integer)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_customer public.customers%rowtype;
  v_customer_snapshot jsonb := '{}'::jsonb;
  v_old jsonb;
  v_subtotal numeric(18,4);
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved sales, supervisor, admin, or finance account required';
  end if;
  select * into v_order from public.business_orders bo where bo.id = p_order_id for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if v_order.version <> p_expected_version then raise exception 'Business order version conflict'; end if;
  if v_order.status::text = 'completed' or v_order.closed_at is not null then
    raise exception 'Completed or closed business order cannot be edited';
  end if;
  if v_order.status::text not in ('draft', 'rejected') then
    if v_actor.role::text not in ('admin', 'finance')
       or v_order.status::text <> 'approved' then
      raise exception 'Business order cannot be edited in current status';
    end if;
  end if;
  if v_actor.role::text in ('sales', 'supervisor') and v_order.salesperson_id is distinct from v_uid then
    raise exception 'Sales user cannot edit another owner business order';
  end if;
  if p_customer_id is null and v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Business order customer is required';
  end if;
  if p_order_date is null then raise exception 'Order date is required'; end if;
  if p_exchange_rate_to_cny is not null
     and (p_exchange_rate_to_cny <= 0 or p_exchange_rate_to_cny > 1000000) then
    raise exception 'Exchange rate is invalid';
  end if;
  if p_currency::text = 'CNY' and p_exchange_rate_to_cny is not null
     and p_exchange_rate_to_cny <> 1 then
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
      'country', v_customer.country, 'contact_person', v_customer.contact_person,
      'tag_color', v_customer.tag_color
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

  if round(v_subtotal + p_shipping_fee, 4) < (
    select coalesce(round(sum(a.amount), 4), 0)
    from public.business_order_payment_allocations a
    join public.business_customer_transfers t on t.id = a.transfer_id
    where a.order_id = v_order.id
      and a.voided_at is null
      and t.voided_at is null
  ) then
    raise exception 'Order total cannot be lower than active allocated payments; void allocations first';
  end if;

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
$function$;

CREATE OR REPLACE FUNCTION public.adjust_business_order_items_internal_0141(p_order_id uuid, p_expected_version integer, p_items jsonb, p_reason_type text, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_idempotency public.business_rpc_idempotency%rowtype;
  v_item jsonb;
  v_existing public.business_order_items%rowtype;
  v_dead public.business_order_payment_allocations%rowtype;
  v_next public.business_order_items%rowtype;
  v_product public.products%rowtype;
  v_custom_product public.business_custom_products%rowtype;
  v_custom_version public.business_custom_product_versions%rowtype;
  v_requested_id uuid;
  v_action text;
  v_source_type text;
  v_product_id uuid;
  v_custom_product_id uuid;
  v_custom_version_id uuid;
  v_quantity numeric;
  v_unit_price numeric;
  v_line_amount numeric;
  v_net_shipped numeric;
  v_daily_active boolean;
  v_daily_category text;
  v_product_received numeric;
  v_product_received_overridden boolean;
  v_logistics_fee numeric;
  v_sales_total numeric;
  v_sales_total_overridden boolean;
  v_sort_order int;
  v_changes jsonb := '[]'::jsonb;
  v_subtotal_before numeric(18,4);
  v_total_before numeric(18,4);
  v_subtotal_after numeric(18,4);
  v_product_sum numeric;
  v_shipping_sum numeric;
  v_total_product numeric;
  v_total_shipping numeric;
  v_total_sales numeric;
  v_revision public.business_order_amount_revisions%rowtype;
  v_hash text;
  v_old jsonb;
  v_new jsonb;
  v_result jsonb;
  v_needs_resubmit boolean;
begin
  perform set_config('app.adjust_business_order_items_rpc', 'true', true);

  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Approved account required';
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
  v_needs_resubmit := v_actor.role::text in ('sales', 'supervisor');
  if v_needs_resubmit then
    if v_order.status::text <> 'approved' or v_order.approval_status <> 'approved' then
      raise exception 'Only approved orders can be adjusted by sales; edit the draft instead';
    end if;
    if v_order.salesperson_id is distinct from v_uid then
      raise exception 'Sales user cannot adjust another owner business order';
    end if;
  end if;

  -- 订单是否已启用日字段（实收）口径；未启用的订单追加行不写日字段，
  -- 否则 total_*_received 单独置值会违反 daily_fields_complete_check。
  v_daily_active := v_order.total_product_received_amount is not null;

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

    if v_requested_id is not null then
      select * into v_existing from public.business_order_items
      where id = v_requested_id and order_id = p_order_id for update;
      if not found then raise exception 'Order item id does not belong to order'; end if;

      v_action := coalesce(nullif(v_item->>'action', ''), 'upsert');
      if v_action = 'delete' then
        if v_existing.origin <> 'append' then
          raise exception 'Only appended order items can be deleted';
        end if;
        if exists (select 1 from public.business_order_shipment_items si
                   where si.order_item_id = v_existing.id)
           or exists (select 1 from public.business_order_return_items ri
                      where ri.order_item_id = v_existing.id) then
          raise exception 'Order item with shipment or return activity cannot be deleted';
        end if;
        if exists (select 1 from public.business_order_payment_allocations pa
                   join public.business_customer_transfers t on t.id = pa.transfer_id
                   where pa.order_item_id = v_existing.id
                     and pa.allocation_target = 'item'
                     and pa.voided_at is null and t.voided_at is null) then
          raise exception 'Order item with payment allocations cannot be deleted';
        end if;
        -- 清理指向该追加行的失效分摊（转账已作废或分摊已作废），否则外键 RESTRICT 会拦住删行。
        for v_dead in
          select pa.*
          from public.business_order_payment_allocations pa
          join public.business_customer_transfers t on t.id = pa.transfer_id
          where pa.order_item_id = v_existing.id
            and (pa.voided_at is not null or t.voided_at is not null)
        loop
          if v_uid is not null then
            perform public.write_business_order_audit(
              p_order_id, 'payment', v_dead.id, 'payment_void',
              v_order.status, v_order.status,
              to_jsonb(v_dead),
              jsonb_build_object('reason', 'Order item removed; inactive allocation cleaned'),
              'Order item removed', v_uid
            );
          end if;
          delete from public.business_order_payment_allocations pa where pa.id = v_dead.id;
        end loop;
        delete from public.business_order_items where id = v_existing.id;
        v_changes := v_changes || jsonb_build_array(jsonb_build_object(
          'kind', 'deleted',
          'order_item_id', v_existing.id,
          'name_snapshot', v_existing.name_snapshot,
          'unit_snapshot', v_existing.unit_snapshot,
          'unit_price', v_existing.unit_price,
          'quantity_before', v_existing.quantity,
          'quantity_after', 0,
          'product_received_amount', v_existing.product_received_amount,
          'logistics_fee_amount', v_existing.logistics_fee_amount,
          'sales_total_amount', v_existing.sales_total_amount
        ));
      elsif v_action = 'upsert' then
        if v_existing.origin <> 'append' then
          raise exception 'Only appended order items can be modified';
        end if;
        v_quantity := round((v_item->>'quantity')::numeric, 4);
        if v_quantity is null or v_quantity <= 0 or v_quantity > 999999999999 then
          raise exception 'Quantity is invalid';
        end if;
        select public.business_order_item_net_shipped(v_existing.id) into v_net_shipped;
        if v_quantity < v_net_shipped then
          raise exception 'Quantity cannot be below net shipped quantity %', v_net_shipped;
        end if;
        if v_item ? 'unit_price' then
          v_unit_price := round((v_item->>'unit_price')::numeric, 4);
          if v_unit_price is null or v_unit_price < 0 or v_unit_price > 999999999999 then
            raise exception 'Unit price is invalid';
          end if;
        else
          v_unit_price := v_existing.unit_price;
        end if;
        if (v_product_id is not null and v_product_id is distinct from v_existing.product_id)
           or (v_custom_product_id is not null
               and v_custom_product_id is distinct from v_existing.custom_product_id)
           or (v_custom_version_id is not null
               and v_custom_version_id is distinct from v_existing.custom_product_version_id) then
          raise exception 'Order item product cannot be replaced by an adjustment';
        end if;

        v_line_amount := round(v_quantity * v_unit_price, 4);
        v_daily_category := v_existing.daily_shipping_category;
        v_product_received := v_existing.product_received_amount;
        v_product_received_overridden := v_existing.product_received_overridden;
        v_logistics_fee := v_existing.logistics_fee_amount;
        v_sales_total := v_existing.sales_total_amount;
        v_sales_total_overridden := v_existing.sales_total_overridden;
        if v_daily_active and v_item ? 'daily_shipping_category' then
          v_daily_category := nullif(v_item->>'daily_shipping_category', '');
        end if;
        if v_daily_category is not null
           and v_daily_category not in ('stock', 'sample', 'custom_sample', 'custom', 'purchase') then
          raise exception 'Daily shipping category is invalid';
        end if;
        if v_daily_active and v_item ? 'product_received_amount' then
          v_product_received := round((v_item->>'product_received_amount')::numeric, 4);
          if v_product_received is null or v_product_received < 0
             or v_product_received > 999999999999 then
            raise exception 'Product received amount is invalid';
          end if;
          v_product_received_overridden := case when v_item ? 'product_received_overridden'
            then (v_item->>'product_received_overridden')::boolean
            else round(v_product_received, 4) is distinct from v_line_amount end;
          if not v_product_received_overridden then
            v_product_received := v_line_amount;
          end if;
        end if;
        if v_daily_active and v_item ? 'logistics_fee_amount' then
          v_logistics_fee := round((v_item->>'logistics_fee_amount')::numeric, 4);
          if v_logistics_fee is null or v_logistics_fee < 0
             or v_logistics_fee > 999999999999 then
            raise exception 'Logistics fee amount is invalid';
          end if;
        end if;
        if v_daily_active and v_item ? 'sales_total_amount' then
          v_sales_total := round((v_item->>'sales_total_amount')::numeric, 4);
          if v_sales_total is null or v_sales_total < 0 or v_sales_total > 999999999999 then
            raise exception 'Sales total amount is invalid';
          end if;
          v_sales_total_overridden := case when v_item ? 'sales_total_overridden'
            then (v_item->>'sales_total_overridden')::boolean
            else round(v_sales_total, 4)
                 is distinct from round(coalesce(v_product_received, 0)
                                       + coalesce(v_logistics_fee, 0), 4) end;
          if not v_sales_total_overridden then
            v_sales_total := round(coalesce(v_product_received, 0)
                                 + coalesce(v_logistics_fee, 0), 4);
          end if;
        end if;

        if v_quantity is distinct from v_existing.quantity
           or v_unit_price is distinct from v_existing.unit_price
           or v_daily_category is distinct from v_existing.daily_shipping_category::text
           or v_product_received is distinct from v_existing.product_received_amount
           or v_product_received_overridden
              is distinct from v_existing.product_received_overridden
           or v_logistics_fee is distinct from v_existing.logistics_fee_amount
           or v_sales_total is distinct from v_existing.sales_total_amount
           or v_sales_total_overridden is distinct from v_existing.sales_total_overridden then
          update public.business_order_items set
            quantity = v_quantity,
            unit_price = v_unit_price,
            daily_shipping_category = v_daily_category::public.daily_order_shipping_category,
            product_received_amount = v_product_received,
            product_received_overridden = v_product_received_overridden,
            logistics_fee_amount = v_logistics_fee,
            sales_total_amount = v_sales_total,
            sales_total_overridden = v_sales_total_overridden,
            updated_at = now()
          where id = v_existing.id
          returning * into v_next;
          v_changes := v_changes || jsonb_build_array(jsonb_build_object(
            'kind', 'updated',
            'order_item_id', v_next.id,
            'name_snapshot', v_next.name_snapshot,
            'unit_snapshot', v_next.unit_snapshot,
            'quantity_before', v_existing.quantity,
            'quantity_after', v_next.quantity,
            'unit_price_before', v_existing.unit_price,
            'unit_price_after', v_next.unit_price,
            'daily_before', jsonb_build_object(
              'daily_shipping_category', v_existing.daily_shipping_category,
              'product_received_amount', v_existing.product_received_amount,
              'product_received_overridden', v_existing.product_received_overridden,
              'logistics_fee_amount', v_existing.logistics_fee_amount,
              'sales_total_amount', v_existing.sales_total_amount,
              'sales_total_overridden', v_existing.sales_total_overridden
            ),
            'daily_after', jsonb_build_object(
              'daily_shipping_category', v_next.daily_shipping_category,
              'product_received_amount', v_next.product_received_amount,
              'product_received_overridden', v_next.product_received_overridden,
              'logistics_fee_amount', v_next.logistics_fee_amount,
              'sales_total_amount', v_next.sales_total_amount,
              'sales_total_overridden', v_next.sales_total_overridden
            )
          ));
        end if;
      else
        raise exception 'Invalid adjustment action';
      end if;
    else
      v_quantity := round((v_item->>'quantity')::numeric, 4);
      if v_quantity is null or v_quantity <= 0 or v_quantity > 999999999999 then
        raise exception 'Quantity is invalid';
      end if;
      v_unit_price := round((v_item->>'unit_price')::numeric, 4);
      if v_unit_price is null or v_unit_price < 0 or v_unit_price > 999999999999 then
        raise exception 'Unit price is invalid';
      end if;
      v_line_amount := round(v_quantity * v_unit_price, 4);

      -- 日字段：与建单同口径。订单未启用日字段时追加行不写，保持全 NULL。
      v_daily_category := null;
      v_product_received := null;
      v_product_received_overridden := false;
      v_logistics_fee := null;
      v_sales_total := null;
      v_sales_total_overridden := false;
      if v_daily_active then
        v_daily_category := nullif(v_item->>'daily_shipping_category', '');
        if v_daily_category is not null
           and v_daily_category not in ('stock', 'sample', 'custom_sample', 'custom', 'purchase') then
          raise exception 'Daily shipping category is invalid';
        end if;
        if v_item ? 'product_received_amount' then
          v_product_received := round((v_item->>'product_received_amount')::numeric, 4);
          if v_product_received is null or v_product_received < 0
             or v_product_received > 999999999999 then
            raise exception 'Product received amount is invalid';
          end if;
          v_product_received_overridden := case when v_item ? 'product_received_overridden'
            then (v_item->>'product_received_overridden')::boolean
            else round(v_product_received, 4) is distinct from v_line_amount end;
          if not v_product_received_overridden then
            v_product_received := v_line_amount;
          end if;
        else
          v_product_received := v_line_amount;
          v_product_received_overridden := false;
        end if;
        if v_item ? 'logistics_fee_amount' then
          v_logistics_fee := round((v_item->>'logistics_fee_amount')::numeric, 4);
          if v_logistics_fee is null or v_logistics_fee < 0
             or v_logistics_fee > 999999999999 then
            raise exception 'Logistics fee amount is invalid';
          end if;
        else
          v_logistics_fee := 0;
        end if;
        if v_item ? 'sales_total_amount' then
          v_sales_total := round((v_item->>'sales_total_amount')::numeric, 4);
          if v_sales_total is null or v_sales_total < 0 or v_sales_total > 999999999999 then
            raise exception 'Sales total amount is invalid';
          end if;
          v_sales_total_overridden := case when v_item ? 'sales_total_overridden'
            then (v_item->>'sales_total_overridden')::boolean
            else round(v_sales_total, 4)
                 is distinct from round(v_product_received + v_logistics_fee, 4) end;
          if not v_sales_total_overridden then
            v_sales_total := round(v_product_received + v_logistics_fee, 4);
          end if;
        else
          v_sales_total := round(v_product_received + v_logistics_fee, 4);
          v_sales_total_overridden := false;
        end if;
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
        if not found then
          raise exception 'Product does not exist';
        end if;
        insert into public.business_order_items (
          order_id, source_type, product_id, sku_snapshot, name_snapshot,
          description_snapshot, specification_snapshot, unit_snapshot,
          image_url_snapshot, quantity, unit_price, sort_order, origin,
          daily_shipping_category, product_received_amount, product_received_overridden,
          logistics_fee_amount, sales_total_amount, sales_total_overridden
        ) values (
          p_order_id, 'catalog', v_product.id, v_product.sku, v_product.name,
          v_product.description, v_product.specification, v_product.unit,
          v_product.image_url, v_quantity, v_unit_price, v_sort_order, 'append',
          v_daily_category::public.daily_order_shipping_category,
          v_product_received, v_product_received_overridden,
          v_logistics_fee, v_sales_total, v_sales_total_overridden
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
          unit_snapshot, image_url_snapshot, quantity, unit_price, sort_order, origin,
          daily_shipping_category, product_received_amount, product_received_overridden,
          logistics_fee_amount, sales_total_amount, sales_total_overridden
        ) values (
          p_order_id, 'custom', v_custom_product.id, v_custom_version.id,
          v_custom_version.code, v_custom_version.name, v_custom_version.description,
          v_custom_version.specification, v_custom_version.unit, v_custom_version.image_url,
          v_quantity, v_unit_price, v_sort_order, 'append',
          v_daily_category::public.daily_order_shipping_category,
          v_product_received, v_product_received_overridden,
          v_logistics_fee, v_sales_total, v_sales_total_overridden
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
        'quantity_after', v_existing.quantity,
        'daily_shipping_category', v_existing.daily_shipping_category,
        'product_received_amount', v_existing.product_received_amount,
        'product_received_overridden', v_existing.product_received_overridden,
        'logistics_fee_amount', v_existing.logistics_fee_amount,
        'sales_total_amount', v_existing.sales_total_amount,
        'sales_total_overridden', v_existing.sales_total_overridden
      ));
      v_sort_order := v_sort_order + 1;
    end if;
  end loop;

  if jsonb_array_length(v_changes) = 0 then
    raise exception 'Adjustment does not change the order';
  end if;

  select coalesce(sum(i.line_amount), 0) into v_subtotal_after
  from public.business_order_items i where i.order_id = p_order_id;

  -- 实收口径重算：覆盖标记为真的合计保持手工值，其余按行求和；
  -- 实收总额始终=产品实收+运费实收。
  if v_daily_active then
    select coalesce(sum(i.product_received_amount), 0),
           coalesce(sum(i.logistics_fee_amount), 0)
      into v_product_sum, v_shipping_sum
    from public.business_order_items i where i.order_id = p_order_id;
    v_total_product := case when v_order.total_product_received_overridden
      then v_order.total_product_received_amount else v_product_sum end;
    v_total_shipping := case when v_order.total_shipping_received_overridden
      then v_order.total_shipping_received_amount else v_shipping_sum end;
    v_total_sales := case when v_order.total_sales_overridden
      then v_order.total_sales_amount
      else round(v_total_product + v_total_shipping, 4) end;
  end if;

  if v_needs_resubmit then
    update public.business_orders bo set
      items_subtotal = v_subtotal_after,
      total_amount = v_subtotal_after + bo.shipping_fee,
      total_product_received_amount = case when v_daily_active
        then v_total_product else bo.total_product_received_amount end,
      total_shipping_received_amount = case when v_daily_active
        then v_total_shipping else bo.total_shipping_received_amount end,
      total_sales_amount = case when v_daily_active
        then v_total_sales else bo.total_sales_amount end,
      status = 'submitted',
      approval_status = 'submitted',
      submitted_by = v_uid,
      submitted_at = now(),
      version = bo.version + 1
    where bo.id = p_order_id;
  else
    update public.business_orders bo set
      items_subtotal = v_subtotal_after,
      total_amount = v_subtotal_after + bo.shipping_fee,
      total_product_received_amount = case when v_daily_active
        then v_total_product else bo.total_product_received_amount end,
      total_shipping_received_amount = case when v_daily_active
        then v_total_shipping else bo.total_shipping_received_amount end,
      total_sales_amount = case when v_daily_active
        then v_total_sales else bo.total_sales_amount end,
      version = bo.version + 1
    where bo.id = p_order_id;
  end if;

  perform public.business_refresh_order_fulfillment_status(p_order_id);
  perform public.business_refresh_order_payment_status(p_order_id);
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
    v_order.id, 'order', v_order.id, 'update',
    (v_old->>'status')::public.business_order_status,
    v_order.status,
    v_old, v_new, p_reason, v_uid
  );
  if v_needs_resubmit then
    perform public.write_business_order_audit(
      v_order.id, 'order', v_order.id, 'submit',
      'approved', 'submitted',
      v_old, v_new, '加单后自动重新提交审核', v_uid
    );
  end if;

  v_result := jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'version', v_order.version,
    'items_subtotal', v_order.items_subtotal,
    'total_amount', v_order.total_amount,
    'total_product_received_amount', v_order.total_product_received_amount,
    'total_shipping_received_amount', v_order.total_shipping_received_amount,
    'total_sales_amount', v_order.total_sales_amount,
    'payment_status', v_order.payment_status,
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
$function$;

commit;
