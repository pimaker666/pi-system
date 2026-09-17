-- 0054: 允许下架（is_active = false）普通产品用于业务订单建单与追加。
--
-- 下架只表示该产品不再用于开具 PI，不应阻止业务订单登记与补充；订单行本身
-- 保存产品快照，因此下架或后续删除产品都不会改变历史订单。
-- 与 0038 / 0048 的唯一差异：目录行不再因 products.is_active = false 报错。

begin;

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
  v_subtotal_before numeric(18,2);
  v_total_before numeric(18,2);
  v_subtotal_after numeric(18,2);
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
                   where pa.order_item_id = v_existing.id) then
          raise exception 'Order item with payment allocations cannot be deleted';
        end if;
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
          v_unit_price := round((v_item->>'unit_price')::numeric, 2);
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

        v_line_amount := round(v_quantity * v_unit_price, 2);
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
           and v_daily_category not in ('stock', 'sample', 'custom', 'purchase') then
          raise exception 'Daily shipping category is invalid';
        end if;
        if v_daily_active and v_item ? 'product_received_amount' then
          v_product_received := round((v_item->>'product_received_amount')::numeric, 2);
          if v_product_received is null or v_product_received < 0
             or v_product_received > 999999999999 then
            raise exception 'Product received amount is invalid';
          end if;
          v_product_received_overridden := case when v_item ? 'product_received_overridden'
            then (v_item->>'product_received_overridden')::boolean
            else round(v_product_received, 2) is distinct from v_line_amount end;
          if not v_product_received_overridden then
            v_product_received := v_line_amount;
          end if;
        end if;
        if v_daily_active and v_item ? 'logistics_fee_amount' then
          v_logistics_fee := round((v_item->>'logistics_fee_amount')::numeric, 2);
          if v_logistics_fee is null or v_logistics_fee < 0
             or v_logistics_fee > 999999999999 then
            raise exception 'Logistics fee amount is invalid';
          end if;
        end if;
        if v_daily_active and v_item ? 'sales_total_amount' then
          v_sales_total := round((v_item->>'sales_total_amount')::numeric, 2);
          if v_sales_total is null or v_sales_total < 0 or v_sales_total > 999999999999 then
            raise exception 'Sales total amount is invalid';
          end if;
          v_sales_total_overridden := case when v_item ? 'sales_total_overridden'
            then (v_item->>'sales_total_overridden')::boolean
            else round(v_sales_total, 2)
                 is distinct from round(coalesce(v_product_received, 0)
                                       + coalesce(v_logistics_fee, 0), 2) end;
          if not v_sales_total_overridden then
            v_sales_total := round(coalesce(v_product_received, 0)
                                 + coalesce(v_logistics_fee, 0), 2);
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
      v_unit_price := round((v_item->>'unit_price')::numeric, 2);
      if v_unit_price is null or v_unit_price < 0 or v_unit_price > 999999999999 then
        raise exception 'Unit price is invalid';
      end if;
      v_line_amount := round(v_quantity * v_unit_price, 2);

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
           and v_daily_category not in ('stock', 'sample', 'custom', 'purchase') then
          raise exception 'Daily shipping category is invalid';
        end if;
        if v_item ? 'product_received_amount' then
          v_product_received := round((v_item->>'product_received_amount')::numeric, 2);
          if v_product_received is null or v_product_received < 0
             or v_product_received > 999999999999 then
            raise exception 'Product received amount is invalid';
          end if;
          v_product_received_overridden := case when v_item ? 'product_received_overridden'
            then (v_item->>'product_received_overridden')::boolean
            else round(v_product_received, 2) is distinct from v_line_amount end;
          if not v_product_received_overridden then
            v_product_received := v_line_amount;
          end if;
        else
          v_product_received := v_line_amount;
          v_product_received_overridden := false;
        end if;
        if v_item ? 'logistics_fee_amount' then
          v_logistics_fee := round((v_item->>'logistics_fee_amount')::numeric, 2);
          if v_logistics_fee is null or v_logistics_fee < 0
             or v_logistics_fee > 999999999999 then
            raise exception 'Logistics fee amount is invalid';
          end if;
        else
          v_logistics_fee := 0;
        end if;
        if v_item ? 'sales_total_amount' then
          v_sales_total := round((v_item->>'sales_total_amount')::numeric, 2);
          if v_sales_total is null or v_sales_total < 0 or v_sales_total > 999999999999 then
            raise exception 'Sales total amount is invalid';
          end if;
          v_sales_total_overridden := case when v_item ? 'sales_total_overridden'
            then (v_item->>'sales_total_overridden')::boolean
            else round(v_sales_total, 2)
                 is distinct from round(v_product_received + v_logistics_fee, 2) end;
          if not v_sales_total_overridden then
            v_sales_total := round(v_product_received + v_logistics_fee, 2);
          end if;
        else
          v_sales_total := round(v_product_received + v_logistics_fee, 2);
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
      else round(v_total_product + v_total_shipping, 2) end;
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
$$;
revoke all on function public.adjust_business_order_items(uuid, int, jsonb, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.adjust_business_order_items(uuid, int, jsonb, text, text, text)
  to authenticated;

commit;
