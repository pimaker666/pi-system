-- ============================================================
-- 0002 产品分组：品类字段(category) + 自定义分组(product_groups)
-- 在 Supabase SQL Editor 整段执行，或 supabase db push
-- ============================================================

-- ------------------------------------------------------------
-- 1. product_groups：产品自定义分组（结构同 customer_groups）
-- ------------------------------------------------------------
create table if not exists public.product_groups (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  description text,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
comment on table public.product_groups is '产品自定义分组';

-- ------------------------------------------------------------
-- 2. products 增加 category（品类）与 group_id（自定义分组）
-- ------------------------------------------------------------
alter table public.products add column if not exists category text;
alter table public.products add column if not exists group_id uuid
  references public.product_groups(id) on delete set null;

create index if not exists idx_products_category on public.products (category);
create index if not exists idx_products_group    on public.products (group_id);

-- ------------------------------------------------------------
-- 3. 按 SKU 前缀回填品类（确定性映射，无重叠）
-- ------------------------------------------------------------
update public.products set category='Facial Mask'   where sku like 'MASK-%';
update public.products set category='Eye Mask'       where sku like 'EYEMASK-%';
update public.products set category='Wrapping Mask'  where sku like 'WRAPMASK-%';
update public.products set category='Toner Pads'     where sku like 'PAD-%';
update public.products set category='FACIAL SERUM'   where sku like 'SERUM-%';
update public.products set category='FACIAL CREAM'   where sku like 'CREAM-%';
update public.products set category='EYE CREAM'      where sku like 'EYECREAM-%';
update public.products set category='FACIAL TONER'   where sku like 'TONER-%';
update public.products set category='CLEANSER'       where sku like 'CLEANSER-%';
update public.products set category='HAIR CARE'      where sku like 'HAIR-%';
update public.products set category='BODY CARE'      where sku like 'BODY-%';
update public.products set category='SUNSCREEN'      where sku like 'SUN-%';
update public.products set category='EXFOLIATING'    where sku like 'EXFOL-%';
update public.products set category='BALM'           where sku like 'BALM-%';
update public.products set category='Skincare'       where sku like 'SUIT-%';

-- ------------------------------------------------------------
-- 4. RLS：product_groups 已认证可读，仅 admin 可写
-- ------------------------------------------------------------
alter table public.product_groups enable row level security;

drop policy if exists "product_groups_select_all" on public.product_groups;
create policy "product_groups_select_all" on public.product_groups
  for select using (auth.role() = 'authenticated');

drop policy if exists "product_groups_admin_write" on public.product_groups;
create policy "product_groups_admin_write" on public.product_groups
  for all using (public.is_admin()) with check (public.is_admin());
