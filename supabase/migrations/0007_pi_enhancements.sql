-- 0007_pi_enhancements.sql
-- PI 系统增强：软删除(回收站) + 按账号收藏。
-- 幂等写法，可重复执行。用户提权无需迁移（profiles_admin_all 已允许管理员改任意 role）。

-- 1) 软删除：deleted_at 为 null 表示正常，非 null 表示已进回收站。
alter table public.proforma_invoices
  add column if not exists deleted_at timestamptz;

create index if not exists idx_pi_deleted_at
  on public.proforma_invoices (deleted_at);

-- 2) 按账号收藏（关联表，账号隔离）。
create table if not exists public.pi_favorites (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  pi_id      uuid not null references public.proforma_invoices(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, pi_id)
);

alter table public.pi_favorites enable row level security;

-- 每个账号只能看/加/删自己的收藏。
drop policy if exists pi_favorites_select_own on public.pi_favorites;
create policy pi_favorites_select_own on public.pi_favorites
  for select using (user_id = auth.uid());

drop policy if exists pi_favorites_insert_own on public.pi_favorites;
create policy pi_favorites_insert_own on public.pi_favorites
  for insert with check (user_id = auth.uid());

drop policy if exists pi_favorites_delete_own on public.pi_favorites;
create policy pi_favorites_delete_own on public.pi_favorites
  for delete using (user_id = auth.uid());

-- 注意：proforma_invoices 的 delete 策略 (created_by = auth.uid() or is_admin())
-- 已在 0003 存在，回收站彻底删除直接复用，无需新增。
