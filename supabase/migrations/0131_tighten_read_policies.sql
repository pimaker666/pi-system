-- 0131 收紧两处过宽的读策略
-- 1) 结算归档表含 unit_cost（公司成本），原策略对所有登录账号开放 select，
--    业务员可直接从 PostgREST 读到全公司成本；台账需要的「是否已结算」改走只暴露明细行 id 的视图。
-- 2) 收款账户原来对所有登录账号开放，未审批账号也能读到账号信息。

begin;

-- 视图默认以 owner（supabase_admin）权限执行，绕过基表 RLS，只暴露非敏感列。
create or replace view public.business_order_item_settlement_flags as
  select business_order_item_id
  from public.finance_business_order_item_settlements;

comment on view public.business_order_item_settlement_flags is
  '已结算明细行 id 的只读视图，供业务员台账判断结算状态；不含单位成本。';

revoke all on public.business_order_item_settlement_flags from public, anon, authenticated;
grant select on public.business_order_item_settlement_flags to authenticated;

drop policy if exists "business_order_item_settlements_select"
  on public.finance_business_order_item_settlements;
create policy "business_order_item_settlements_select"
  on public.finance_business_order_item_settlements
  for select to authenticated
  using (public.is_finance_or_admin() or settled_by = (select auth.uid()));

drop policy if exists "payment_accounts_select" on public.payment_accounts;
create policy "payment_accounts_select"
  on public.payment_accounts for select to authenticated
  using (public.is_approved_user());

commit;

notify pgrst, 'reload schema';
