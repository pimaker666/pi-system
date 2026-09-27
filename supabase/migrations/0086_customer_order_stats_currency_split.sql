-- 0086: 客户近一年下单金额按汇率状态分列
--
-- 已填写汇率的订单统一折算并汇总为 CNY；未填写汇率的 USD 订单保留原币展示，
-- 避免 NULL 汇率令业务员客户列表误显示为无订单金额。

begin;

drop function if exists public.get_customer_order_stats(uuid[]);

create function public.get_customer_order_stats(p_customer_ids uuid[])
returns table (
  customer_id uuid,
  last_year_amount_cny numeric,
  last_year_amount_usd numeric,
  last_order_date date,
  custom_order_count integer
)
language sql
stable
security invoker
set search_path = public
as $$
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
    (count(*) filter (where o.fulfillment_type = 'custom'))::integer as custom_order_count
  from public.business_orders o
  where o.customer_id = any(p_customer_ids)
    and o.voided_at is null
    and o.status in ('approved', 'completed')
  group by o.customer_id
$$;

revoke all on function public.get_customer_order_stats(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.get_customer_order_stats(uuid[]) to authenticated;

commit;
