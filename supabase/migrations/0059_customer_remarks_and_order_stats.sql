-- 0059: 客户备注字段 + 客户订单聚合统计
--
-- 1) customers.remarks：客户级备注（新增客户表单填写，不进入订单快照）。
-- 2) get_customer_order_stats：按客户聚合业务订单，供客户列表展示
--    「近一年下单金额 / 上次下单时间 / 定制订单数」。
--    口径：仅统计未作废且 status in ('approved','completed') 的 business_orders。
--    security invoker，聚合结果受 business_orders 现有 RLS 约束（管理员/财务见全量，
--    业务员见其可见订单）。
--
-- 幂等：add column if not exists、约束按 catalog 匹配后再加、create or replace。

begin;

alter table public.customers
  add column if not exists remarks text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'customers_remarks_len'
      and conrelid = 'public.customers'::regclass
  ) then
    alter table public.customers
      add constraint customers_remarks_len
      check (remarks is null or char_length(remarks) <= 2000);
  end if;
end $$;

create or replace function public.get_customer_order_stats(p_customer_ids uuid[])
returns table (
  customer_id uuid,
  last_year_amount_cny numeric,
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
      ),
      0
    )::numeric as last_year_amount_cny,
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
