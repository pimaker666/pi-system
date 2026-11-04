-- 0137_rls_dedupe_commission_item_visibility.sql
-- 提点/结清两张表的 SELECT 策略原来在行内子查询 business_order_items，
-- 该子查询又会触发 business_order_items 自己的 RLS（同样调用
-- can_view_business_order），导致每条记录算两次可见性。
-- 改为 security definer 帮助函数一次解析「明细行 → 订单可见性」，
-- 内层查询绕过明细行 RLS，每条记录只调用一次 can_view_business_order。
-- 可见范围与原来完全一致：仍是 items.id 命中且 can_view_business_order(order_id) 为真。

begin;

create or replace function public.can_view_business_order_item(p_item_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.business_order_items as items
    where items.id = p_item_id
      and public.can_view_business_order(items.order_id)
  );
$$;

comment on function public.can_view_business_order_item(uuid) is
  '明细行可见性（按所属订单判定）；security definer 绕过明细行 RLS，避免可见性重复求值。';

revoke all on function public.can_view_business_order_item(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.can_view_business_order_item(uuid) to authenticated;

drop policy if exists "business_order_item_commissions_select"
  on public.finance_business_order_item_commissions;
create policy "business_order_item_commissions_select"
  on public.finance_business_order_item_commissions
  for select to authenticated
  using (public.can_view_business_order_item(business_order_item_id));

drop policy if exists "business_order_item_commission_clearances_select"
  on public.finance_business_order_item_commission_clearances;
create policy "business_order_item_commission_clearances_select"
  on public.finance_business_order_item_commission_clearances
  for select to authenticated
  using (public.can_view_business_order_item(business_order_item_id));

commit;

notify pgrst, 'reload schema';
