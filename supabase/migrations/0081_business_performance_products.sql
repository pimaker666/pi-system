-- 0081 业务业绩按产品汇总
-- 销售数据按订单明细原币汇总；成本与利润只使用结算归档的成本快照。
-- USD 已结算产品行按订单提成结算时锁定的汇率换算为 CNY。

begin;

create or replace function public.get_business_performance_by_product(
  p_source_type text,
  p_date_from date default null,
  p_date_to date default null,
  p_salesperson_ids uuid[] default null,
  p_shop_ids uuid[] default null,
  p_product_group_ids uuid[] default null,
  p_shipping_categories text[] default null
)
returns table (
  product_key text,
  product_name text,
  product_sku text,
  sales_quantity numeric,
  sales_amount_cny numeric,
  sales_amount_usd numeric,
  settled_sales_amount_cny numeric,
  settled_quantity numeric,
  settled_product_cost_cny numeric,
  settled_product_profit_cny numeric,
  unsettled_line_count bigint,
  missing_exchange_rate_line_count bigint
)
language sql
security definer
set search_path = public
stable
as $$
  with filtered_items as (
    select
      i.id,
      i.product_id,
      i.custom_product_id,
      i.name_snapshot,
      i.sku_snapshot,
      i.quantity,
      i.line_amount,
      bo.currency,
      fc.settlement_exchange_rate_to_cny,
      s.quantity as settled_quantity,
      s.unit_cost
    from public.business_order_items i
    join public.business_orders bo on bo.id = i.order_id
    left join public.products p on p.id = i.product_id
    left join public.business_custom_product_versions cv on cv.id = i.custom_product_version_id
    left join public.finance_business_order_item_settlements s on s.business_order_item_id = i.id
    left join public.finance_business_order_commissions fc on fc.business_order_id = bo.id
    where bo.voided_at is null
      and i.source_type::text = p_source_type
      and (p_date_from is null or bo.order_date >= p_date_from)
      and (p_date_to is null or bo.order_date <= p_date_to)
      and (p_salesperson_ids is null or array_length(p_salesperson_ids, 1) is null
        or bo.salesperson_id = any (p_salesperson_ids))
      and (p_shop_ids is null or array_length(p_shop_ids, 1) is null
        or bo.shop_id = any (p_shop_ids))
      and (p_product_group_ids is null or array_length(p_product_group_ids, 1) is null
        or coalesce(p.group_id, cv.product_group_id) = any (p_product_group_ids))
      and (p_shipping_categories is null or array_length(p_shipping_categories, 1) is null
        or i.daily_shipping_category::text = any (p_shipping_categories))
      and public.can_view_business_order(bo.id)
      and public.is_finance_or_admin()
  ), normalized_items as (
    select
      case
        when p_source_type = 'catalog' and product_id is not null then 'catalog:' || product_id::text
        when p_source_type = 'custom' and custom_product_id is not null then 'custom:' || custom_product_id::text
        else p_source_type || ':snapshot:' || name_snapshot || ':' || sku_snapshot
      end as product_key,
      name_snapshot as product_name,
      sku_snapshot as product_sku,
      quantity,
      line_amount,
      currency,
      settlement_exchange_rate_to_cny,
      settled_quantity,
      unit_cost
    from filtered_items
  )
  select
    product_key,
    max(product_name) as product_name,
    max(product_sku) as product_sku,
    coalesce(sum(quantity), 0) as sales_quantity,
    coalesce(sum(line_amount) filter (where currency = 'CNY'), 0) as sales_amount_cny,
    coalesce(sum(line_amount) filter (where currency = 'USD'), 0) as sales_amount_usd,
    coalesce(sum(
      line_amount * case when currency = 'USD' then settlement_exchange_rate_to_cny else 1 end
    ) filter (
      where settled_quantity is not null
        and (currency <> 'USD' or settlement_exchange_rate_to_cny is not null)
    ), 0) as settled_sales_amount_cny,
    coalesce(sum(settled_quantity) filter (
      where currency <> 'USD' or settlement_exchange_rate_to_cny is not null
    ), 0) as settled_quantity,
    coalesce(sum(unit_cost * settled_quantity) filter (
      where currency <> 'USD' or settlement_exchange_rate_to_cny is not null
    ), 0) as settled_product_cost_cny,
    coalesce(sum(
      line_amount * case when currency = 'USD' then settlement_exchange_rate_to_cny else 1 end
      - coalesce(unit_cost, 0) * settled_quantity
    ) filter (
      where settled_quantity is not null
        and (currency <> 'USD' or settlement_exchange_rate_to_cny is not null)
    ), 0) as settled_product_profit_cny,
    count(*) filter (where settled_quantity is null) as unsettled_line_count,
    count(*) filter (
      where settled_quantity is not null
        and currency = 'USD'
        and settlement_exchange_rate_to_cny is null
    ) as missing_exchange_rate_line_count
  from normalized_items
  group by product_key
  order by sales_amount_cny + sales_amount_usd desc, product_name, product_sku;
$$;

revoke all on function public.get_business_performance_by_product(
  text, date, date, uuid[], uuid[], uuid[], text[]
) from public, anon, authenticated, service_role;
grant execute on function public.get_business_performance_by_product(
  text, date, date, uuid[], uuid[], uuid[], text[]
) to authenticated, service_role;

commit;
