-- ============================================================
-- 网页版产品库与 PI 自动生成系统 — 初始化迁移
-- 目标：业务员数据隔离 + 简单金额模式
-- 在 Supabase SQL Editor 整段执行，或 supabase db push
-- ============================================================

-- ------------------------------------------------------------
-- 0. 扩展与枚举
-- ------------------------------------------------------------
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";
create extension if not exists pg_trgm;

do $$ begin
  create type user_role as enum ('admin', 'sales');
exception when duplicate_object then null; end $$;

do $$ begin
  create type currency_code as enum ('USD', 'EUR', 'CNY', 'GBP', 'JPY');
exception when duplicate_object then null; end $$;

do $$ begin
  create type pi_status as enum ('active', 'void');
exception when duplicate_object then null; end $$;

-- ------------------------------------------------------------
-- 1. profiles：扩展 auth.users，存储角色和业务信息
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  role        user_role   not null default 'sales',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.profiles is '员工档案，扩展 auth.users';

-- 新用户注册时自动创建 profile
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- 2. company_settings：PI 抬头 / 银行 / Logo（单行）
-- ------------------------------------------------------------
create table if not exists public.company_settings (
  id            int primary key default 1,
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
  updated_at    timestamptz not null default now(),
  constraint single_row check (id = 1)
);
comment on table public.company_settings is 'PI 公司抬头与银行信息，全局单行配置';

-- ------------------------------------------------------------
-- 3. products：产品库
-- ------------------------------------------------------------
create table if not exists public.products (
  id            uuid primary key default uuid_generate_v4(),
  sku           text not null unique,
  name          text not null,
  description   text,
  unit          text not null default 'pcs',
  unit_price    numeric(12,2) not null default 0 check (unit_price >= 0),
  currency      currency_code not null default 'USD',
  image_url     text,
  is_active     boolean not null default true,
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.products is '产品库主表';

create index if not exists idx_products_sku       on public.products (sku);
create index if not exists idx_products_active    on public.products (is_active);
create index if not exists idx_products_name_trgm on public.products using gin (name gin_trgm_ops);

-- ------------------------------------------------------------
-- 4. customer_groups：客户分组
-- ------------------------------------------------------------
create table if not exists public.customer_groups (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  description text,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
comment on table public.customer_groups is '客户分组';

-- ------------------------------------------------------------
-- 5. customers：客户信息
-- ------------------------------------------------------------
create table if not exists public.customers (
  id             uuid primary key default uuid_generate_v4(),
  name           text not null,
  company        text,
  email          text,
  phone          text,
  address        text,
  country        text,
  contact_person text,
  group_id       uuid references public.customer_groups(id) on delete set null,
  created_by     uuid references public.profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
comment on table public.customers is '客户信息表';

create index if not exists idx_customers_group   on public.customers (group_id);
create index if not exists idx_customers_company on public.customers (company);
create index if not exists idx_customers_creator on public.customers (created_by);

-- ------------------------------------------------------------
-- 6. proforma_invoices：PI 主表
-- ------------------------------------------------------------
create table if not exists public.proforma_invoices (
  id                uuid primary key default uuid_generate_v4(),
  pi_number         text not null unique,
  status            pi_status not null default 'active',
  customer_id       uuid references public.customers(id) on delete set null,
  customer_snapshot jsonb not null,
  currency          currency_code not null default 'USD',
  subtotal          numeric(14,2) not null default 0,
  tax_rate          numeric(5,2)  not null default 0,
  tax_amount        numeric(14,2) not null default 0,
  shipping_fee      numeric(14,2) not null default 0,
  discount          numeric(14,2) not null default 0,
  total             numeric(14,2) not null default 0,
  notes             text,
  terms             text,
  pdf_path          text,
  created_by        uuid references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
comment on table public.proforma_invoices is '形式发票主表';
comment on column public.proforma_invoices.customer_snapshot is '生成时的客户信息快照(JSON)';

create index if not exists idx_pi_customer on public.proforma_invoices (customer_id);
create index if not exists idx_pi_number   on public.proforma_invoices (pi_number);
create index if not exists idx_pi_creator  on public.proforma_invoices (created_by);
create index if not exists idx_pi_created  on public.proforma_invoices (created_at);

-- ------------------------------------------------------------
-- 7. pi_items：PI 明细（产品价格快照）
-- ------------------------------------------------------------
create table if not exists public.pi_items (
  id              uuid primary key default uuid_generate_v4(),
  pi_id           uuid not null references public.proforma_invoices(id) on delete cascade,
  product_id      uuid references public.products(id) on delete set null,
  sku             text not null,
  name            text not null,
  description     text,
  unit            text not null default 'pcs',
  unit_price      numeric(12,2) not null,
  quantity        numeric(12,2) not null check (quantity > 0),
  line_total      numeric(14,2) not null,
  sort_order      int not null default 0
);
comment on table public.pi_items is 'PI 明细行，含产品价格快照';

create index if not exists idx_pi_items_pi on public.pi_items (pi_id);

-- ------------------------------------------------------------
-- 8. PI 编号生成器：按年份独立递增序列
-- ------------------------------------------------------------
create table if not exists public.pi_sequences (
  year      int primary key,
  last_seq  int not null default 0
);

create or replace function public.next_pi_number()
returns text
language plpgsql
security definer set search_path = public
as $$
declare
  cur_year int := extract(year from current_date)::int;
  new_seq  int;
begin
  insert into public.pi_sequences (year, last_seq)
  values (cur_year, 1)
  on conflict (year)
  do update set last_seq = pi_sequences.last_seq + 1
  returning last_seq into new_seq;

  return 'PI-' || cur_year || '-' || lpad(new_seq::text, 3, '0');
end;
$$;

create or replace function public.set_pi_number()
returns trigger
language plpgsql
as $$
begin
  if new.pi_number is null or new.pi_number = '' then
    new.pi_number := public.next_pi_number();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_pi_number on public.proforma_invoices;
create trigger trg_set_pi_number
  before insert on public.proforma_invoices
  for each row execute function public.set_pi_number();

-- ------------------------------------------------------------
-- 9. 通用 updated_at 自动更新
-- ------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_products_touch on public.products;
create trigger trg_products_touch  before update on public.products
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_customers_touch on public.customers;
create trigger trg_customers_touch before update on public.customers
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_pi_touch on public.proforma_invoices;
create trigger trg_pi_touch        before update on public.proforma_invoices
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_profiles_touch on public.profiles;
create trigger trg_profiles_touch  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- 10. 原子创建 PI（主表 + 明细）
-- ------------------------------------------------------------
create or replace function public.create_pi_with_items(
  p_customer_id       uuid,
  p_customer_snapshot jsonb,
  p_currency          currency_code,
  p_subtotal          numeric,
  p_tax_rate          numeric,
  p_tax_amount        numeric,
  p_shipping_fee      numeric,
  p_discount          numeric,
  p_total             numeric,
  p_notes             text,
  p_terms             text,
  p_items             jsonb
)
returns table (id uuid, pi_number text)
language plpgsql
security invoker
as $$
declare
  v_pi_id uuid;
  v_pi_no text;
  v_item  jsonb;
  v_idx   int := 0;
begin
  insert into public.proforma_invoices (
    customer_id, customer_snapshot, currency, subtotal, tax_rate,
    tax_amount, shipping_fee, discount, total, notes, terms,
    status, created_by
  ) values (
    p_customer_id, p_customer_snapshot, p_currency, p_subtotal, p_tax_rate,
    p_tax_amount, p_shipping_fee, p_discount, p_total, p_notes, p_terms,
    'active', auth.uid()
  )
  returning proforma_invoices.id, proforma_invoices.pi_number
    into v_pi_id, v_pi_no;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.pi_items (
      pi_id, product_id, sku, name, description,
      unit, unit_price, quantity, line_total, sort_order
    ) values (
      v_pi_id,
      nullif(v_item->>'product_id','')::uuid,
      v_item->>'sku',
      v_item->>'name',
      v_item->>'description',
      coalesce(v_item->>'unit','pcs'),
      (v_item->>'unit_price')::numeric,
      (v_item->>'quantity')::numeric,
      (v_item->>'line_total')::numeric,
      coalesce((v_item->>'sort_order')::int, v_idx)
    );
    v_idx := v_idx + 1;
  end loop;

  return query select v_pi_id, v_pi_no;
end;
$$;

-- ------------------------------------------------------------
-- 11. 启用 RLS + 策略（业务员数据隔离版）
-- ------------------------------------------------------------
alter table public.profiles          enable row level security;
alter table public.company_settings  enable row level security;
alter table public.products          enable row level security;
alter table public.customer_groups   enable row level security;
alter table public.customers         enable row level security;
alter table public.proforma_invoices enable row level security;
alter table public.pi_items          enable row level security;

-- 辅助函数：当前用户是否 admin
create or replace function public.is_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ---------- profiles ----------
drop policy if exists "profiles_select_all" on public.profiles;
create policy "profiles_select_all" on public.profiles
  for select using (auth.role() = 'authenticated');
drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
  for update using (id = auth.uid());
drop policy if exists "profiles_admin_all" on public.profiles;
create policy "profiles_admin_all" on public.profiles
  for all using (public.is_admin());

-- ---------- company_settings ----------
drop policy if exists "company_select_all" on public.company_settings;
create policy "company_select_all" on public.company_settings
  for select using (auth.role() = 'authenticated');
drop policy if exists "company_admin_write" on public.company_settings;
create policy "company_admin_write" on public.company_settings
  for all using (public.is_admin()) with check (public.is_admin());

-- ---------- products（共享，仅 admin 可写）----------
drop policy if exists "products_select_all" on public.products;
create policy "products_select_all" on public.products
  for select using (auth.role() = 'authenticated');
drop policy if exists "products_admin_write" on public.products;
create policy "products_admin_write" on public.products
  for all using (public.is_admin()) with check (public.is_admin());

-- ---------- customer_groups（共享字典）----------
drop policy if exists "groups_select_all" on public.customer_groups;
create policy "groups_select_all" on public.customer_groups
  for select using (auth.role() = 'authenticated');
drop policy if exists "groups_write" on public.customer_groups;
create policy "groups_write" on public.customer_groups
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- ---------- customers（数据隔离：创建者/admin 可见）----------
drop policy if exists "customers_select_own" on public.customers;
create policy "customers_select_own" on public.customers
  for select using (created_by = auth.uid() or public.is_admin());
drop policy if exists "customers_insert" on public.customers;
create policy "customers_insert" on public.customers
  for insert with check (auth.role() = 'authenticated');
drop policy if exists "customers_update" on public.customers;
create policy "customers_update" on public.customers
  for update using (created_by = auth.uid() or public.is_admin());
drop policy if exists "customers_delete" on public.customers;
create policy "customers_delete" on public.customers
  for delete using (created_by = auth.uid() or public.is_admin());

-- ---------- proforma_invoices（数据隔离）----------
drop policy if exists "pi_select_own" on public.proforma_invoices;
create policy "pi_select_own" on public.proforma_invoices
  for select using (created_by = auth.uid() or public.is_admin());
drop policy if exists "pi_insert" on public.proforma_invoices;
create policy "pi_insert" on public.proforma_invoices
  for insert with check (auth.role() = 'authenticated');
drop policy if exists "pi_update" on public.proforma_invoices;
create policy "pi_update" on public.proforma_invoices
  for update using (created_by = auth.uid() or public.is_admin());
drop policy if exists "pi_delete" on public.proforma_invoices;
create policy "pi_delete" on public.proforma_invoices
  for delete using (created_by = auth.uid() or public.is_admin());

-- ---------- pi_items（跟随所属 PI 的可见性）----------
drop policy if exists "pi_items_select_own" on public.pi_items;
create policy "pi_items_select_own" on public.pi_items
  for select using (
    exists (
      select 1 from public.proforma_invoices pi
      where pi.id = pi_items.pi_id
        and (pi.created_by = auth.uid() or public.is_admin())
    )
  );
drop policy if exists "pi_items_write" on public.pi_items;
create policy "pi_items_write" on public.pi_items
  for all using (
    exists (
      select 1 from public.proforma_invoices pi
      where pi.id = pi_items.pi_id
        and (pi.created_by = auth.uid() or public.is_admin())
    )
  )
  with check (
    exists (
      select 1 from public.proforma_invoices pi
      where pi.id = pi_items.pi_id
        and (pi.created_by = auth.uid() or public.is_admin())
    )
  );

-- ------------------------------------------------------------
-- 12. Storage buckets + 策略
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values
  ('product-images', 'product-images', true),
  ('pi-pdfs',        'pi-pdfs',        false),
  ('company-assets', 'company-assets', true)
on conflict (id) do nothing;

drop policy if exists "product_images_read" on storage.objects;
create policy "product_images_read" on storage.objects
  for select using (bucket_id = 'product-images');
drop policy if exists "product_images_write" on storage.objects;
create policy "product_images_write" on storage.objects
  for insert with check (bucket_id = 'product-images' and auth.role() = 'authenticated');

drop policy if exists "pi_pdfs_rw" on storage.objects;
create policy "pi_pdfs_rw" on storage.objects
  for all using (bucket_id = 'pi-pdfs' and auth.role() = 'authenticated')
  with check (bucket_id = 'pi-pdfs' and auth.role() = 'authenticated');

drop policy if exists "company_assets_read" on storage.objects;
create policy "company_assets_read" on storage.objects
  for select using (bucket_id = 'company-assets');
drop policy if exists "company_assets_write" on storage.objects;
create policy "company_assets_write" on storage.objects
  for insert with check (bucket_id = 'company-assets' and public.is_admin());

-- ------------------------------------------------------------
-- 13. 初始公司设置占位行（可在 /settings 页面修改）
-- ------------------------------------------------------------
insert into public.company_settings (id, company_name)
values (1, 'My Company Co., Ltd.')
on conflict (id) do nothing;
