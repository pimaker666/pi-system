-- ============================================================
-- 0005 产品分组排序：product_groups 增加 sort_order 列
-- 在 Supabase SQL Editor 整段执行，或 supabase db push
-- ============================================================

-- 1. 新增排序列（默认 0；数值越小越靠前）
alter table public.product_groups
  add column if not exists sort_order integer not null default 0;

-- 2. 对现有分组按名称回填一个初始序号，避免全部并列为 0
with ordered as (
  select id, row_number() over (order by name) - 1 as rn
  from public.product_groups
)
update public.product_groups g
set sort_order = ordered.rn
from ordered
where g.id = ordered.id
  and g.sort_order = 0;

-- 3. 便于按排序查询
create index if not exists idx_product_groups_sort
  on public.product_groups (sort_order, name);
