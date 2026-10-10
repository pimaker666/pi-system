-- update_business_order_v6 的 else 分支（手续费未变化）使用了裸列名 id，
-- 与 returns table (id ...) 出参变量冲突，PostgreSQL 默认 variable_conflict=error
-- 导致所有不修改手续费的编辑保存抛 'column reference "id" is ambiguous'。
-- 改为别名限定 bo.id，其余与 0075 定义完全一致。
create or replace function public.update_business_order_v6(
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
  p_payment_account text,
  p_order_fee numeric
)
returns table (id uuid, order_number text, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated record;
  v_order public.business_orders%rowtype;
  v_before_fee numeric(18, 4);
  v_fee numeric(18, 4);
  v_uid uuid := (select auth.uid());
begin
  v_fee := case when p_order_fee is null then null else round(p_order_fee, 4) end;
  if v_fee is not null and (v_fee < 0 or v_fee > 999999999999) then
    raise exception 'Order fee must be between zero and 999999999999';
  end if;

  select * into v_updated
  from public.update_business_order_v5(
    p_order_id, p_expected_version, p_customer_id, p_order_date,
    p_fulfillment_type, p_currency, p_exchange_rate_to_cny, p_shipping_fee,
    p_tracking_number, p_sales_notes, p_items, p_payment_due_date, p_reason,
    p_shop_id, p_salesperson_id, p_external_order_number, p_daily_shipping_date,
    p_daily_shipping_number, p_daily_payment_category,
    p_total_product_received_amount, p_total_product_received_overridden,
    p_total_shipping_received_amount, p_total_shipping_received_overridden,
    p_total_sales_amount, p_total_sales_overridden,
    p_receivable_received_difference_reason, p_payment_account
  );

  select bo.order_fee into v_before_fee
  from public.business_orders bo
  where bo.id = v_updated.id
  for update;

  if p_order_fee is not null and v_before_fee is distinct from v_fee then
    update public.business_orders bo
    set order_fee = v_fee,
        version = bo.version + 1
    where bo.id = v_updated.id
    returning * into v_order;

    perform public.write_business_order_audit(
      v_order.id, 'order', v_order.id, 'update', v_order.status, v_order.status,
      jsonb_build_object('order_fee', v_before_fee), jsonb_build_object('order_fee', v_fee),
      p_reason, v_uid
    );
  else
    select bo.* into v_order from public.business_orders bo where bo.id = v_updated.id;
  end if;

  return query select v_order.id, v_order.order_number, v_order.version;
end;
$$;

revoke all on function public.update_business_order_v6(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text, uuid,
  uuid, text, date, text, public.daily_order_payment_category, numeric, boolean,
  numeric, boolean, numeric, boolean, text, text, numeric
) from public, anon, authenticated, service_role;
grant execute on function public.update_business_order_v6(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text, uuid,
  uuid, text, date, text, public.daily_order_payment_category, numeric, boolean,
  numeric, boolean, numeric, boolean, text, text, numeric
) to authenticated;
