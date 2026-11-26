-- 0166: 客户统计新增「近一年下单单数」「平均下单间隔」（客户列表复购频率列）
--   last_year_order_count 口径与近一年金额一致：未作废、状态 approved/completed，
--     下单日期在近 365 天内；含首单，样品/打样单也计入（只看下单频次，不按成交口径过滤）。
--   avg_order_interval_days = (末单日期 - 首单日期) / (有效单数 - 1)，按全部有效订单（不限 365 天）算，
--     至少 2 单才有值，四舍五入到整天。

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
  deal_order_count integer,
  last_year_order_count integer,
  avg_order_interval_days integer
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
    ))::integer as deal_order_count,
    (count(*) filter (
      where o.order_date >= (current_date - interval '365 days')
    ))::integer as last_year_order_count,
    case
      when count(*) > 1 then
        round(((max(o.order_date) - min(o.order_date))::numeric) / (count(*) - 1))::integer
      else null
    end as avg_order_interval_days
  from valid_orders o
  left join item_stats st on st.order_id = o.id
  group by o.customer_id
$$;

revoke all on function public.get_customer_order_stats(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.get_customer_order_stats(uuid[]) to authenticated;

commit;
