-- ============================================================
-- 0003 子账号产品权限 + 分组管理开放
-- 目标：
--   1) 产品库为共享表：子账号（sales）可新增/编辑产品，删除仅管理员
--   2) 产品分组管理对全体登录用户开放（增/改/删）
-- 说明：客户/PI 的可见性 RLS 在 0001 已满足「admin 全见 + 本人可写」，
--       且 admin 修改 created_by（转移归属）也被现有 update 策略放行，故此处不改。
-- 在 Supabase SQL Editor 整段执行。
-- 前置：需已执行 0001_init.sql 与 0002_product_groups.sql。
-- ============================================================

-- ------------------------------------------------------------
-- 1. products：拆分写权限
--    读：全体登录用户（0001 已建 products_select_all，此处保持）
--    增/改：全体登录用户；删：仅管理员
-- ------------------------------------------------------------
drop policy if exists "products_admin_write" on public.products;

drop policy if exists "products_insert" on public.products;
create policy "products_insert" on public.products
  for insert with check (auth.role() = 'authenticated');

drop policy if exists "products_update" on public.products;
create policy "products_update" on public.products
  for update using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "products_delete" on public.products;
create policy "products_delete" on public.products
  for delete using (public.is_admin());

-- ------------------------------------------------------------
-- 2. product_groups：由 admin-only 放开为全体登录用户可增改删
-- ------------------------------------------------------------
drop policy if exists "product_groups_admin_write" on public.product_groups;

drop policy if exists "product_groups_write" on public.product_groups;
create policy "product_groups_write" on public.product_groups
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');
