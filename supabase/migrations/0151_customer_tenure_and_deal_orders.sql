-- 0151: 客户统计新增「客户年限」与「成交单数」
--   first_order_date：该客户最早一单（未作废、已审核/已完成）的下单日期，前端按满 6 个月记 0.5 年展示。
--   deal_order_count：成交单数。只要订单明细里有一条不是现货样品/定制打样就算成交；
--     只有现货样品或定制打样的订单不计入，没有明细的订单也不计入。
--     明细未填发货分类时按非样品处理（计入成交），避免历史数据被整体排除。

begin;

drop function if exists public.get_customer_order_stats(uuid[]);

create function public.get_customer_order_stats(p_customer_ids uuid[])
returns table (
  customer_id uuid,
  last_year_amount_cny numeric,
  last_year_amount_usd numeric,
  last_order_date date,
  custom_order_count integer,
  first_order_date date,
  deal_order_count integer
)
language sql
stable
security invoker
set search_path = public
as $$
  with valid_orders as (
    select
      o.id,
      o.customer_id,
      o.order_date,
      o.fulfillment_type,
      o.total_amount,
      o.total_cny,
      o.currency,
      o.exchange_rate_to_cny
    from public.business_orders o
    where o.customer_id = any(p_customer_ids)
      and o.voided_at is null
      and o.status in ('approved', 'completed')
  ),
  item_stats as (
    select
      i.order_id,
      count(*) as item_count,
      count(*) filter (
        where coalesce(i.daily_shipping_category::text, '') not in ('sample', 'custom_sample')
      ) as deal_item_count
    from public.business_order_items i
    where i.order_id in (select id from valid_orders)
    group by i.order_id
  )
  select
    o.customer_id,
    coalesce(
      sum(o.total_cny) filter (
        where o.order_date >= (current_date - interval '365 days')
          and o.exchange_rate_to_cny is not null
      ),
      0
    )::numeric as last_year_amount_cny,
    coalesce(
      sum(o.total_amount) filter (
        where o.order_date >= (current_date - interval '365 days')
          and o.currency = 'USD'
          and o.exchange_rate_to_cny is null
      ),
      0
    )::numeric as last_year_amount_usd,
    max(o.order_date) as last_order_date,
    (count(*) filter (where o.fulfillment_type = 'custom'))::integer as custom_order_count,
    min(o.order_date) as first_order_date,
    (count(*) filter (
      where coalesce(st.item_count, 0) > 0
        and coalesce(st.deal_item_count, 0) > 0
    ))::integer as deal_order_count
  from valid_orders o
  left join item_stats st on st.order_id = o.id
  group by o.customer_id
$$;

revoke all on function public.get_customer_order_stats(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.get_customer_order_stats(uuid[]) to authenticated;

commit;
