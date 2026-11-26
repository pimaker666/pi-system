-- 产品名称与财务编号对所有已登录角色可见：订单/台账/已结算等展示面统一按
-- 产品库名称优先、财务编号优先；成本等其余财务字段仍由 product_financials
-- 的财务/管理员 RLS 保护。视图以 owner 权限读取，绕过底层 RLS，只暴露两列。
create or replace view public.product_financial_labels as
select
  product_id,
  financial_number,
  product_name
from public.product_financials;

comment on view public.product_financial_labels is
  '产品展示字段（名称/财务编号）对所有登录角色可见；成本等敏感字段仍由 product_financials RLS 限制。';

-- 只读：显式收回所有角色的写权限，再单独授予登录角色 SELECT，
-- 避免默认权限让视图可被当成可更新视图写回 product_financials。
revoke all on public.product_financial_labels from public, anon, authenticated;
grant select on public.product_financial_labels to authenticated;
