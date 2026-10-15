-- 0104 未完结的已发货/已收款订单支持编辑（管理员与财务）
-- 放宽三处：
-- 1) business_order_accepts_entry_edits：approved 订单对 admin/finance 不再要求
--    “无有效收款分摊且无有效发货”，详情页/编辑页准入随之放开。
-- 2) update_business_order：同一门禁放宽（业务员/主管仍仅限草稿与已驳回）。
-- 3) update_business_order_v5：与 adjust_business_order_items 一致，将整条更新链
--    标记为可信日字段写入路径，使完整编辑器在有收款/发货事实的订单上可以
--    连贯地重写明细与日字段（两处均有完整 before/after 审计）。
-- 4) protect_business_order_item_daily_fields：补上 0048 已给订单级触发器加过的
--    同一可信路径旁路。0048 只修了订单级；编辑器链路对新明细行做“空→值”的
--    UPDATE 时会命中明细级触发器（追加 RPC 内联写日字段所以从未触发）。
--    该标志只在可信 RPC 内设置，直接表更新不受影响。
-- 保持不变：已完成、已关闭、已作废订单仍锁定；protect_business_order_item_invariants
-- （有分摊不可删行/换产品/改价、已发货行不可删/换产品、数量不低于净发货）、
-- protect_business_order_allocation_invariants（有收款不可换客户/币种、总额不低于分摊）
-- 均继续生效。

begin;

create or replace function public.business_order_accepts_entry_edits(p_order_id uuid, p_role text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select bo.voided_at is null
    and bo.closed_at is null
    and (
      bo.status::text in ('draft', 'rejected')
      or (
        coalesce(p_role, '') in ('admin', 'finance')
        and bo.status::text = 'approved'
      )
    )
  from public.business_orders bo
  where bo.id = p_order_id;
$function$;

create or replace function public.protect_business_order_item_daily_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_setting('app.adjust_business_order_items_rpc', true) = 'true' then
    return new;
  end if;
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

create or replace function public.update_business_order(p_order_id uuid, p_expected_version integer, p_customer_id uuid, p_order_date date, p_fulfillment_type business_fulfillment_type, p_currency currency_code, p_exchange_rate_to_cny numeric, p_shipping_fee numeric, p_tracking_number text, p_sales_notes text, p_items jsonb, p_reason text)
 RETURNS TABLE(id uuid, order_number text, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

create or replace function public.update_business_order_v5(p_order_id uuid, p_expected_version integer, p_customer_id uuid, p_order_date date, p_fulfillment_type business_fulfillment_type, p_currency currency_code, p_exchange_rate_to_cny numeric, p_shipping_fee numeric, p_tracking_number text, p_sales_notes text, p_items jsonb, p_payment_due_date date, p_reason text, p_shop_id uuid, p_salesperson_id uuid, p_external_order_number text, p_daily_shipping_date date, p_daily_shipping_number text, p_daily_payment_category daily_order_payment_category, p_total_product_received_amount numeric, p_total_product_received_overridden boolean, p_total_shipping_received_amount numeric, p_total_shipping_received_overridden boolean, p_total_sales_amount numeric, p_total_sales_overridden boolean, p_receivable_received_difference_reason text, p_payment_account text)
 RETURNS TABLE(id uuid, order_number text, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  perform set_config('app.adjust_business_order_items_rpc', 'true', true);

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
$function$;

commit;
