-- 0013_user_delete_fk.sql
-- 允许安全删除注册用户：
-- 删除 auth.users -> 级联删除 public.profiles（0001 已设 on delete cascade），
-- 但 products / product_groups / customer_groups / customers / proforma_invoices
-- 的 created_by 外键指向 profiles(id) 且没有 on delete 规则（默认 NO ACTION），
-- 只要该用户创建过任意数据，删除其 profiles 行就会被外键阻塞，
-- 表现为 GoTrue 返回 "Database error deleting user"（前端弹出空错误）。
--
-- 策略：改为 on delete set null —— 删除用户时保留其创建的业务数据（产品/客户/PI 等），
-- 仅将 created_by 置空（归属清空），管理员后续可重新指派。绝不用 cascade，
-- 以免删一个用户连带删掉他名下所有产品与报价单。
-- 幂等：可安全重复执行（先 drop if exists 再重建约束）。

-- products.created_by
alter table public.products
  drop constraint if exists products_created_by_fkey;
alter table public.products
  add constraint products_created_by_fkey
  foreign key (created_by) references public.profiles(id) on delete set null;

-- product_groups.created_by
alter table public.product_groups
  drop constraint if exists product_groups_created_by_fkey;
alter table public.product_groups
  add constraint product_groups_created_by_fkey
  foreign key (created_by) references public.profiles(id) on delete set null;

-- customer_groups.created_by
alter table public.customer_groups
  drop constraint if exists customer_groups_created_by_fkey;
alter table public.customer_groups
  add constraint customer_groups_created_by_fkey
  foreign key (created_by) references public.profiles(id) on delete set null;

-- customers.created_by
alter table public.customers
  drop constraint if exists customers_created_by_fkey;
alter table public.customers
  add constraint customers_created_by_fkey
  foreign key (created_by) references public.profiles(id) on delete set null;

-- proforma_invoices.created_by
alter table public.proforma_invoices
  drop constraint if exists proforma_invoices_created_by_fkey;
alter table public.proforma_invoices
  add constraint proforma_invoices_created_by_fkey
  foreign key (created_by) references public.profiles(id) on delete set null;
