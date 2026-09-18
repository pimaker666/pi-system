-- 0058 放宽订单行成本覆盖的写入门禁
-- 订单成本页改为逐产品行（已收款并发货的合并行）编辑成本，不再要求整单发完；
-- 但 0046 的 insert/update 策略仍要求 orders.fulfillment_status = 'fully_shipped'，
-- 导致同单存在未发完产品时，已发完产品行保存成本被 RLS 拒绝。
-- 这里去掉整单发货条件，保留 财务/管理员 + updated_by 自校验 + 订单已审核/已完成。

begin;

drop policy if exists "business_order_item_cost_overrides_insert"
  on public.finance_business_order_item_cost_overrides;
create policy "business_order_item_cost_overrides_insert"
  on public.finance_business_order_item_cost_overrides
  for insert to authenticated
  with check (
    public.is_finance_or_admin()
    and updated_by = (select auth.uid())
    and exists (
      select 1
      from public.business_order_items as items
      join public.business_orders as orders on orders.id = items.order_id
      where items.id = business_order_item_id
        and orders.status in ('approved', 'completed')
    )
  );

drop policy if exists "business_order_item_cost_overrides_update"
  on public.finance_business_order_item_cost_overrides;
create policy "business_order_item_cost_overrides_update"
  on public.finance_business_order_item_cost_overrides
  for update to authenticated
  using (public.is_finance_or_admin())
  with check (
    public.is_finance_or_admin()
    and updated_by = (select auth.uid())
    and exists (
      select 1
      from public.business_order_items as items
      join public.business_orders as orders on orders.id = items.order_id
      where items.id = business_order_item_id
        and orders.status in ('approved', 'completed')
    )
  );

commit;
