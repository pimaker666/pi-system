-- ============================================================
-- 0006 每账号多公司档案 + 生效切换 + PI 公司快照
-- 在 Supabase SQL Editor 整段执行，或 supabase db push
-- ============================================================

-- ------------------------------------------------------------
-- 1. company_profiles：每个账号可保存多份公司信息
-- ------------------------------------------------------------
create table if not exists public.company_profiles (
  id            uuid primary key default uuid_generate_v4(),
  created_by    uuid not null references public.profiles(id) on delete cascade,
  label         text not null,               -- 档案名（便于区分，如 主体公司 / 香港公司）
  company_name  text not null,
  address       text,
  phone         text,
  email         text,
  website       text,
  logo_url      text,
  bank_name     text,
  bank_account  text,
  bank_swift    text,
  bank_address  text,
  default_terms text,
  is_active     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.company_profiles is '每账号可保存的多份公司信息，其中一份为生效档案';

-- 每个账号最多只有一份生效档案
create unique index if not exists idx_company_profiles_one_active
  on public.company_profiles (created_by) where is_active;
create index if not exists idx_company_profiles_owner
  on public.company_profiles (created_by);

-- ------------------------------------------------------------
-- 2. RLS：owner 自管（只对自己账号生效，互相不可见）
-- ------------------------------------------------------------
alter table public.company_profiles enable row level security;

drop policy if exists "company_profiles_select_own" on public.company_profiles;
create policy "company_profiles_select_own" on public.company_profiles
  for select using (created_by = auth.uid());

drop policy if exists "company_profiles_insert_own" on public.company_profiles;
create policy "company_profiles_insert_own" on public.company_profiles
  for insert with check (created_by = auth.uid());

drop policy if exists "company_profiles_update_own" on public.company_profiles;
create policy "company_profiles_update_own" on public.company_profiles
  for update using (created_by = auth.uid()) with check (created_by = auth.uid());

drop policy if exists "company_profiles_delete_own" on public.company_profiles;
create policy "company_profiles_delete_own" on public.company_profiles
  for delete using (created_by = auth.uid());

-- ------------------------------------------------------------
-- 3. proforma_invoices 增加公司快照列（镜像 customer_snapshot）
-- ------------------------------------------------------------
alter table public.proforma_invoices
  add column if not exists company_snapshot jsonb;

-- ------------------------------------------------------------
-- 4. company-assets 桶写权限放开给所有登录用户（非管理员也能传 Logo）
-- ------------------------------------------------------------
drop policy if exists "company_assets_write" on storage.objects;
create policy "company_assets_write" on storage.objects
  for insert with check (
    bucket_id = 'company-assets' and auth.role() = 'authenticated'
  );

drop policy if exists "company_assets_update" on storage.objects;
create policy "company_assets_update" on storage.objects
  for update using (
    bucket_id = 'company-assets' and auth.role() = 'authenticated'
  ) with check (
    bucket_id = 'company-assets' and auth.role() = 'authenticated'
  );

-- company_settings 保持不变，作为全局默认回退。
