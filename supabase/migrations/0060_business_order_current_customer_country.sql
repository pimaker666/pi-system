-- 0060: 订单侧国旗改读客户表当前国家
--
-- 背景：business_orders.customer_snapshot 是下单/换客户时冻结的快照。若客户在下单后
-- 才补填或修改国家，订单快照里的 country 不会回填，导致订单台账/详情/业绩的国旗与客户
-- 列表（读实时 customers.country）不一致。
--
-- 方案：get_business_orders_customer_country 按订单 id 批量返回其关联客户的“当前”国家。
--   - security definer：绕过 customers 表 RLS（财务读不到别人名下客户），但用
--     can_view_business_order(bo.id) 把可见范围收敛回订单级权限（管理员/财务全量，
--     业务员仅本人及下属）。
--   - 只返回有关联客户且客户仍存在的订单；未关联客户的订单不返回行，前端回退快照。
--
-- 幂等：create or replace + 固定的 revoke/grant。

begin;

create or replace function public.get_business_orders_customer_country(p_order_ids uuid[])
returns table (order_id uuid, country text)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if coalesce(array_length(p_order_ids, 1), 0) > 1000 then
    raise exception 'Too many orders requested';
  end if;
  return query
  select bo.id, c.country
  from public.business_orders bo
  join public.customers c on c.id = bo.customer_id
  where bo.id = any (coalesce(p_order_ids, array[]::uuid[]))
    and public.can_view_business_order(bo.id);
end;
$$;

revoke all on function public.get_business_orders_customer_country(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.get_business_orders_customer_country(uuid[])
  to authenticated;

commit;
