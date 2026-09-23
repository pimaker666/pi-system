-- 0075 业务订单建单手续费
-- 订单手续费仅供利润核算扣减，不参与订单应收、实收或收款状态计算。

begin;

alter table public.business_orders
  add column if not exists order_fee numeric(18, 4);

alter table public.business_orders
  drop constraint if exists business_orders_order_fee_check;
alter table public.business_orders
  add constraint business_orders_order_fee_check
  check (order_fee is null or (order_fee >= 0 and order_fee <= 999999999999));

comment on column public.business_orders.order_fee is
  '建单时记录的订单手续费；仅用于利润核算扣减，不参与订单应收或实收计算。NULL 表示沿用历史利润手续费记录。';

create or replace function public.create_business_order_v6(
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
  p_payment_account text,
  p_order_fee numeric
)
returns table (id uuid, order_number text, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created record;
  v_order public.business_orders%rowtype;
  v_fee numeric(18, 4);
  v_uid uuid := (select auth.uid());
begin
  v_fee := case when p_order_fee is null then null else round(p_order_fee, 4) end;
  if v_fee is not null and (v_fee < 0 or v_fee > 999999999999) then
    raise exception 'Order fee must be between zero and 999999999999';
  end if;

  select * into v_created
  from public.create_business_order_v5(
    p_customer_id, p_order_date, p_fulfillment_type, p_currency,
    p_exchange_rate_to_cny, p_shipping_fee, p_tracking_number, p_sales_notes,
    p_items, p_payment_due_date, p_shop_id, p_salesperson_id,
    p_external_order_number, p_daily_shipping_date, p_daily_shipping_number,
    p_daily_payment_category, p_total_product_received_amount,
    p_total_product_received_overridden, p_total_shipping_received_amount,
    p_total_shipping_received_overridden, p_total_sales_amount,
    p_total_sales_overridden, p_receivable_received_difference_reason,
    p_payment_account
  );

  update public.business_orders bo
  set order_fee = v_fee
  where bo.id = v_created.id
  returning * into v_order;

  perform public.write_business_order_audit(
    v_order.id, 'order', v_order.id, 'update', v_order.status, v_order.status,
    jsonb_build_object('order_fee', null), jsonb_build_object('order_fee', v_fee),
    'Set order fee during creation', v_uid
  );

  return query select v_order.id, v_order.order_number, v_order.version;
end;
$$;

revoke all on function public.create_business_order_v6(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb, date, uuid, uuid, text, date, text,
  public.daily_order_payment_category, numeric, boolean, numeric, boolean,
  numeric, boolean, text, text, numeric
) from public, anon, authenticated, service_role;
grant execute on function public.create_business_order_v6(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb, date, uuid, uuid, text, date, text,
  public.daily_order_payment_category, numeric, boolean, numeric, boolean,
  numeric, boolean, text, text, numeric
) to authenticated;

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
    select * into v_order from public.business_orders where id = v_updated.id;
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

create or replace function public.get_business_order_profit_rows(
  p_period date default null,
  p_salesperson_ids uuid[] default null,
  p_shop_ids uuid[] default null
)
returns table (
  order_id uuid,
  profit_period date,
  order_date date,
  order_number text,
  external_order_number text,
  shop_name text,
  salesperson_name text,
  currency public.currency_code,
  received_amount numeric,
  product_cost numeric,
  freight_cost numeric,
  commission_amount numeric,
  fee_amount numeric,
  profit_amount numeric
)
language sql
security definer
set search_path = public
stable
as $$
  with eligible_orders as (
    select bo.id, greatest(max(s.period), max(c.period)) as profit_period
    from public.business_orders bo
    join public.business_order_items i on i.order_id = bo.id
    join public.finance_business_order_item_settlements s on s.business_order_item_id = i.id
    join public.finance_business_order_item_commission_clearances c
      on c.business_order_item_id = i.id and c.status = 'confirmed'
    where bo.voided_at is null and public.is_finance_or_admin()
      and (p_salesperson_ids is null or array_length(p_salesperson_ids, 1) is null or bo.salesperson_id = any (p_salesperson_ids))
      and (p_shop_ids is null or array_length(p_shop_ids, 1) is null or bo.shop_id = any (p_shop_ids))
    group by bo.id
    having count(*) = (select count(*) from public.business_order_items all_items where all_items.order_id = bo.id)
  ), allocations as (
    select a.order_id,
      coalesce(sum(a.amount) filter (where a.voided_at is null and t.voided_at is null), 0) as received_allocations,
      coalesce(sum(a.amount) filter (where a.voided_at is null and t.voided_at is null and a.allocation_target = 'shipping'), 0) as shipping_allocations
    from public.business_order_payment_allocations a
    join eligible_orders eo on eo.id = a.order_id
    left join public.business_customer_transfers t on t.id = a.transfer_id
    group by a.order_id
  ), product_totals as (
    select i.order_id,
      coalesce(sum(s.unit_cost * s.quantity), 0) as product_cost,
      coalesce(sum(coalesce(i.product_received_amount, 0) * coalesce(ic.commission_rate, tag.product_commission_rate, cr.product_commission_rate, 0) / 100), 0) as product_commission
    from public.business_order_items i
    join public.finance_business_order_item_settlements s on s.business_order_item_id = i.id
    join eligible_orders eo on eo.id = i.order_id
    left join public.finance_business_order_item_commissions ic on ic.business_order_item_id = i.id
    left join public.business_orders bo on bo.id = i.order_id
    left join public.customers customer on customer.id = bo.customer_id
    left join public.finance_customer_commission_tags tag on lower(tag.tag_color) = lower(customer.tag_color)
    left join public.finance_commission_category_rates cr on cr.category = i.daily_shipping_category
    group by i.order_id
  )
  select bo.id, eo.profit_period, bo.order_date, bo.order_number, bo.external_order_number,
    bo.shop_name_snapshot, coalesce(nullif(bo.salesperson_display_name_snapshot, ''), bo.salesperson_name_snapshot, ''),
    bo.currency,
    coalesce(bo.total_sales_amount, 0) + coalesce(a.received_allocations, 0),
    pt.product_cost, coalesce(fc.freight_cost, 0),
    pt.product_commission + ((coalesce(bo.total_shipping_received_amount, 0) + coalesce(a.shipping_allocations, 0) - coalesce(fc.freight_cost, 0)) * coalesce(fc.freight_commission_rate, 0) / 100),
    coalesce(bo.order_fee, fee.fee_amount, 0),
    (coalesce(bo.total_sales_amount, 0) + coalesce(a.received_allocations, 0))
      - pt.product_cost - coalesce(fc.freight_cost, 0) - pt.product_commission
      - ((coalesce(bo.total_shipping_received_amount, 0) + coalesce(a.shipping_allocations, 0) - coalesce(fc.freight_cost, 0)) * coalesce(fc.freight_commission_rate, 0) / 100)
      - coalesce(bo.order_fee, fee.fee_amount, 0)
  from eligible_orders eo
  join public.business_orders bo on bo.id = eo.id
  join product_totals pt on pt.order_id = bo.id
  left join allocations a on a.order_id = bo.id
  left join public.finance_business_order_commissions fc on fc.business_order_id = bo.id
  left join public.finance_business_order_profit_fees fee on fee.business_order_id = bo.id
  where p_period is null or eo.profit_period = p_period
  order by eo.profit_period desc, bo.order_date desc, bo.id desc;
$$;

create or replace function public.get_business_order_profit_rows_filtered(
  p_period_from date default null,
  p_period_to date default null,
  p_salesperson_ids uuid[] default null,
  p_shop_ids uuid[] default null,
  p_product_group_ids uuid[] default null,
  p_shipping_categories text[] default null
)
returns table (
  order_id uuid,
  profit_period date,
  order_date date,
  order_number text,
  external_order_number text,
  shop_name text,
  salesperson_name text,
  currency public.currency_code,
  received_amount numeric,
  product_cost numeric,
  freight_cost numeric,
  commission_amount numeric,
  fee_amount numeric,
  profit_amount numeric
)
language sql
security definer
set search_path = public
stable
as $$
  select r.*
  from public.get_business_order_profit_rows(null, p_salesperson_ids, p_shop_ids) r
  where (p_period_from is null or r.profit_period >= p_period_from)
    and (p_period_to is null or r.profit_period <= p_period_to)
    and (
      p_product_group_ids is null
      or array_length(p_product_group_ids, 1) is null
      or exists (
        select 1
        from public.business_order_items i
        join public.business_custom_product_versions v on v.id = i.custom_product_version_id
        where i.order_id = r.order_id
          and v.product_group_id = any (p_product_group_ids)
      )
    )
    and (
      p_shipping_categories is null
      or array_length(p_shipping_categories, 1) is null
      or exists (
        select 1
        from public.business_order_items i
        where i.order_id = r.order_id
          and i.daily_shipping_category::text = any (p_shipping_categories)
      )
    )
  order by r.profit_period desc, r.order_date desc, r.order_id desc;
$$;

revoke all on function public.get_business_order_profit_rows_filtered(
  date, date, uuid[], uuid[], uuid[], text[]
) from public, anon, authenticated, service_role;
grant execute on function public.get_business_order_profit_rows_filtered(
  date, date, uuid[], uuid[], uuid[], text[]
) to authenticated;

commit;
