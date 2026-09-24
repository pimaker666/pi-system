-- 0083 利润核算优先使用订单录入手续费

begin;

do $$
begin
  if to_regprocedure('public.get_business_order_profit_rows_base_0083(date,uuid[],uuid[])') is null then
    alter function public.get_business_order_profit_rows(date, uuid[], uuid[])
      rename to get_business_order_profit_rows_base_0083;
  end if;

  if to_regprocedure('public.get_business_order_profit_rows_filtered_base_0083(date,date,uuid[],uuid[],uuid[],text[])') is null then
    alter function public.get_business_order_profit_rows_filtered(date, date, uuid[], uuid[], uuid[], text[])
      rename to get_business_order_profit_rows_filtered_base_0083;
  end if;
end;
$$;

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
  with base_rows as (
    select *
    from public.get_business_order_profit_rows_base_0083(
      p_period,
      p_salesperson_ids,
      p_shop_ids
    )
  ), rows_with_fee as (
    select
      r.*,
      coalesce(bo.order_fee, r.fee_amount, 0)
        * case
            when bo.currency = 'USD' then fc.settlement_exchange_rate_to_cny
            else 1
          end as effective_fee_amount
    from base_rows r
    join public.business_orders bo on bo.id = r.order_id
    left join public.finance_business_order_commissions fc on fc.business_order_id = bo.id
  )
  select
    order_id,
    profit_period,
    order_date,
    order_number,
    external_order_number,
    shop_name,
    salesperson_name,
    currency,
    received_amount,
    product_cost,
    freight_cost,
    commission_amount,
    effective_fee_amount,
    profit_amount + fee_amount - effective_fee_amount
  from rows_with_fee
  order by profit_period desc, order_date desc, order_id desc;
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
  with base_rows as (
    select *
    from public.get_business_order_profit_rows_filtered_base_0083(
      p_period_from,
      p_period_to,
      p_salesperson_ids,
      p_shop_ids,
      p_product_group_ids,
      p_shipping_categories
    )
  ), rows_with_fee as (
    select
      r.*,
      coalesce(bo.order_fee, r.fee_amount, 0)
        * case
            when bo.currency = 'USD' then fc.settlement_exchange_rate_to_cny
            else 1
          end as effective_fee_amount
    from base_rows r
    join public.business_orders bo on bo.id = r.order_id
    left join public.finance_business_order_commissions fc on fc.business_order_id = bo.id
  )
  select
    order_id,
    profit_period,
    order_date,
    order_number,
    external_order_number,
    shop_name,
    salesperson_name,
    currency,
    received_amount,
    product_cost,
    freight_cost,
    commission_amount,
    effective_fee_amount,
    profit_amount + fee_amount - effective_fee_amount
  from rows_with_fee
  order by profit_period desc, order_date desc, order_id desc;
$$;

revoke all on function public.get_business_order_profit_rows_base_0083(date, uuid[], uuid[])
  from public, anon, authenticated, service_role;
revoke all on function public.get_business_order_profit_rows_filtered_base_0083(date, date, uuid[], uuid[], uuid[], text[])
  from public, anon, authenticated, service_role;
revoke all on function public.get_business_order_profit_rows(date, uuid[], uuid[])
  from public, anon, authenticated, service_role;
revoke all on function public.get_business_order_profit_rows_filtered(date, date, uuid[], uuid[], uuid[], text[])
  from public, anon, authenticated, service_role;
grant execute on function public.get_business_order_profit_rows(date, uuid[], uuid[])
  to authenticated, service_role;
grant execute on function public.get_business_order_profit_rows_filtered(date, date, uuid[], uuid[], uuid[], text[])
  to authenticated, service_role;

commit;
