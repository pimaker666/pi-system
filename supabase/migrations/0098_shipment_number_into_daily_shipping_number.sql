-- 0098_shipment_number_into_daily_shipping_number.sql
-- 发货批次的发货单号（原运单号）在批次创建成功后回写到订单的发货单号字段：
-- 按「、」分隔追加，重复单号不重复写入；拼接后超过 200 字符时报错，
-- 与订单编辑路径对 daily_shipping_number 的既有长度校验保持同一文案。
-- 幂等键命中历史结果时直接返回，不重复追加。
-- 回写经 app.adjust_business_order_items_rpc 事务级 GUC 绕过每日字段保护触发器
--（与 0054 加单路径同一逃生口），仅限本函数内部使用。

create or replace function public.create_business_order_shipment_internal_0057(
  p_order_id uuid,
  p_shipped_at timestamptz,
  p_tracking_number text,
  p_notes text,
  p_items jsonb,
  p_idempotency_key text,
  p_allow_overship boolean,
  p_overship_reason text
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
  v_shipment public.business_order_shipments%rowtype;
  v_shipment_item public.business_order_shipment_items%rowtype;
  v_idempotency public.business_rpc_idempotency%rowtype;
  v_item jsonb;
  v_order_item public.business_order_items%rowtype;
  v_order_item_id uuid;
  v_quantity numeric;
  v_quantity_before numeric;
  v_net_shipped numeric;
  v_allow_overship boolean := coalesce(p_allow_overship, false);
  v_overship jsonb := '[]'::jsonb;
  v_subtotal_before numeric(18,2);
  v_total_before numeric(18,2);
  v_subtotal_after numeric(18,2);
  v_revision public.business_order_amount_revisions%rowtype;
  v_payload jsonb;
  v_hash text;
  v_created jsonb := '[]'::jsonb;
  v_result jsonb;
  v_shipping_number text;
  v_existing_numbers text[];
  v_updated_numbers text;
begin
  perform set_config('app.adjust_business_order_items_rpc', 'true', true);
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved' then raise exception 'Approved account required'; end if;
  select * into v_order from public.business_orders bo where bo.id = p_order_id for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if v_order.closed_at is not null then raise exception 'Closed business order cannot receive new shipments'; end if;
  if v_order.status::text = 'completed' then raise exception 'Completed business order is immutable'; end if;
  if v_actor.role::text in ('sales', 'supervisor') then
    if v_order.salesperson_id is distinct from v_uid then raise exception 'Sales user cannot ship another owner order'; end if;
  elsif v_actor.role::text not in ('admin', 'finance') then raise exception 'Role cannot create shipments'; end if;
  if v_order.status::text <> 'approved' or v_order.approval_status <> 'approved' then
    raise exception 'Only approved orders can be shipped';
  end if;
  if p_shipped_at is null then raise exception 'Shipped time is required'; end if;
  if p_shipped_at > now() then raise exception 'Shipped time cannot be in the future'; end if;
  if char_length(coalesce(p_tracking_number, '')) > 200
     or char_length(coalesce(p_notes, '')) > 1000 then raise exception 'Shipment text exceeds maximum length'; end if;
  if char_length(coalesce(p_overship_reason, '')) > 1000 then
    raise exception 'Over-shipment reason cannot exceed 1000 characters';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 500 then
    raise exception 'Shipment items count must be between 1 and 500';
  end if;
  if nullif(btrim(p_idempotency_key), '') is null
     or char_length(btrim(p_idempotency_key)) > 200 then raise exception 'Idempotency key is invalid'; end if;
  if exists (
    select 1 from jsonb_to_recordset(p_items) as x(order_item_id uuid, quantity numeric)
    group by x.order_item_id having x.order_item_id is null or count(*) > 1
  ) then raise exception 'Each shipment order_item_id must be unique'; end if;

  v_payload := jsonb_build_object(
    'order_id', p_order_id, 'shipped_at', p_shipped_at,
    'tracking_number', nullif(btrim(p_tracking_number), ''),
    'notes', nullif(btrim(p_notes), ''), 'items', p_items
  );
  if v_allow_overship then
    v_payload := v_payload || jsonb_build_object(
      'allow_overship', true,
      'overship_reason', nullif(btrim(p_overship_reason), '')
    );
  end if;
  v_hash := encode(digest(v_payload::text, 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    v_uid::text || ':create_business_order_shipment:' || btrim(p_idempotency_key), 0));
  select * into v_idempotency from public.business_rpc_idempotency
  where actor_id = v_uid and operation = 'create_business_order_shipment'
    and idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_idempotency.payload_hash <> v_hash then
      raise exception 'Idempotency key was already used with a different payload';
    end if;
    return v_idempotency.result;
  end if;

  perform i.id from public.business_order_items i
  join (select x.order_item_id from jsonb_to_recordset(p_items)
        as x(order_item_id uuid, quantity numeric)) r on r.order_item_id = i.id
  where i.order_id = p_order_id order by i.id for update of i;
  if (select count(*) from jsonb_to_recordset(p_items) as x(order_item_id uuid, quantity numeric))
     <> (select count(*) from public.business_order_items i
         join (select x.order_item_id from jsonb_to_recordset(p_items)
               as x(order_item_id uuid, quantity numeric)) r on r.order_item_id = i.id
         where i.order_id = p_order_id) then
    raise exception 'One or more shipment items do not belong to order';
  end if;

  v_subtotal_before := v_order.items_subtotal;
  v_total_before := v_order.total_amount;

  insert into public.business_order_shipments (
    order_id, shipped_at, tracking_number, notes, created_by
  ) values (
    p_order_id, p_shipped_at, nullif(btrim(p_tracking_number), ''),
    nullif(btrim(p_notes), ''), v_uid
  ) returning * into v_shipment;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_order_item_id := nullif(v_item->>'order_item_id', '')::uuid;
    v_quantity := round((v_item->>'quantity')::numeric, 4);
    if v_quantity is null or v_quantity <= 0 or v_quantity > 999999999999 then
      raise exception 'Shipment quantity is invalid';
    end if;
    select * into v_order_item from public.business_order_items
    where id = v_order_item_id and order_id = p_order_id;
    v_net_shipped := public.business_order_item_net_shipped(v_order_item.id);
    if v_net_shipped + v_quantity > v_order_item.quantity then
      if not v_allow_overship then
        raise exception 'Shipment quantity exceeds remaining net order item quantity';
      end if;
      -- 超发：同事务把下单量提到实发量，应收随之上调，并在台账留一行。
      v_quantity_before := v_order_item.quantity;
      update public.business_order_items set quantity = v_net_shipped + v_quantity
      where id = v_order_item.id
      returning * into v_order_item;
      v_overship := v_overship || jsonb_build_array(jsonb_build_object(
        'kind', 'over_shipped',
        'order_item_id', v_order_item.id,
        'name_snapshot', v_order_item.name_snapshot,
        'unit_snapshot', v_order_item.unit_snapshot,
        'unit_price', v_order_item.unit_price,
        'quantity_before', v_quantity_before,
        'quantity_after', v_order_item.quantity,
        'shipped_quantity', v_quantity
      ));
    end if;
    insert into public.business_order_shipment_items (shipment_id, order_item_id, quantity)
    values (v_shipment.id, v_order_item.id, v_quantity)
    returning * into v_shipment_item;
    v_created := v_created || jsonb_build_array(to_jsonb(v_shipment_item));
  end loop;

  if jsonb_array_length(v_overship) > 0 then
    select coalesce(sum(i.line_amount), 0) into v_subtotal_after
    from public.business_order_items i where i.order_id = p_order_id;
    update public.business_orders bo set
      items_subtotal = v_subtotal_after,
      total_amount = v_subtotal_after + bo.shipping_fee
    where bo.id = p_order_id;
  end if;

  perform public.business_refresh_order_fulfillment_status(p_order_id);
  v_shipping_number := nullif(btrim(coalesce(p_tracking_number, '')), '');
  if v_shipping_number is not null then
    select coalesce(array_agg(btrim(part) order by ord), array[]::text[])
      into v_existing_numbers
    from unnest(string_to_array(coalesce(v_order.daily_shipping_number, ''), '、'))
      with ordinality as t(part, ord)
    where btrim(part) <> '';
    if not (v_shipping_number = any(v_existing_numbers)) then
      v_updated_numbers := array_to_string(v_existing_numbers || v_shipping_number, '、');
      if char_length(v_updated_numbers) > 200 then
        raise exception 'Daily shipping number cannot exceed 200 characters';
      end if;
      update public.business_orders bo
      set daily_shipping_number = v_updated_numbers
      where bo.id = p_order_id;
    end if;
  end if;
  update public.business_orders set version = version + 1 where id = p_order_id;
  select * into v_order from public.business_orders where id = p_order_id;

  if jsonb_array_length(v_overship) > 0 then
    v_revision := public.business_write_order_amount_revision(
      p_order_id, 'over_shipment',
      v_subtotal_before, v_order.items_subtotal,
      v_total_before, v_order.total_amount,
      jsonb_build_object('lines', v_overship, 'shipment_id', v_shipment.id),
      p_overship_reason, v_uid
    );
  end if;

  v_result := jsonb_build_object(
    'shipment', to_jsonb(v_shipment),
    'items', v_created,
    'items_subtotal', v_order.items_subtotal,
    'total_amount', v_order.total_amount,
    'version', v_order.version,
    'revision', case when v_revision.id is null then null else to_jsonb(v_revision) end
  );
  perform public.write_business_lifecycle_audit(
    p_order_id, v_order.customer_id, 'shipment', v_shipment.id,
    'create', null, v_result, nullif(btrim(p_overship_reason), ''), v_uid
  );
  insert into public.business_rpc_idempotency (
    actor_id, operation, idempotency_key, payload_hash, result
  ) values (v_uid, 'create_business_order_shipment', btrim(p_idempotency_key), v_hash, v_result);
  return v_result;
end;
$$;

revoke all on function public.create_business_order_shipment_internal_0057(
  uuid, timestamptz, text, text, jsonb, text, boolean, text
) from public, anon, authenticated, service_role;
