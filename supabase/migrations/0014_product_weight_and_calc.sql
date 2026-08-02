-- 0014_product_weight_and_calc.sql
-- 产品克重 + 计算重量模块：
--  1) products 增加 weight_g（克重，单位 g），并从"纯克重"规格自动回填；
--  2) pi_items 增加 weight_g 快照；proforma_invoices 增加 show_weight（默认 false）；
--  3) 更新原子创建函数 create_pi_with_items：新增 p_show_weight 入参并逐行写入 weight_g；
--  4) 新增 weight_calculations / weight_calc_items 表（重量计算单，带历史）+ RLS + 编号序列 + 创建函数。
-- 幂等：可安全重复执行。

-- ============================================================
-- 1) products.weight_g（克重，单位 g）
-- ============================================================
alter table public.products
  add column if not exists weight_g numeric(12,3);

comment on column public.products.weight_g is '产品克重（单位 g），可在开单/计算时使用；默认不出现在 PI';

-- 从"纯克重"规格自动回填：仅当 specification 整体是一个克重数值时（如 500g / 500克 / 12.5 g），
-- 复制其数值到 weight_g；像 34g*4pcs/box、50ml 这类复合/非克重规格保持为空。
update public.products
set weight_g = substring(specification from '([0-9]+(?:\.[0-9]+)?)')::numeric
where weight_g is null
  and specification is not null
  and specification ~* '^\s*[0-9]+(\.[0-9]+)?\s*(g|克|gram|grams)\s*$';

-- ============================================================
-- 2) pi_items.weight_g（开单克重快照）+ proforma_invoices.show_weight
-- ============================================================
alter table public.pi_items
  add column if not exists weight_g numeric(12,3);

comment on column public.pi_items.weight_g is 'PI 行克重快照（单位 g）';

alter table public.proforma_invoices
  add column if not exists show_weight boolean not null default false;

comment on column public.proforma_invoices.show_weight is '该 PI 是否显示克重列（默认不显示）';

-- ============================================================
-- 3) 更新 create_pi_with_items：新增 p_show_weight 入参 + 写入 weight_g
-- ============================================================
-- 先删除 0011 引入的 14 参数重载，避免调用歧义。
drop function if exists public.create_pi_with_items(
  uuid, jsonb, currency_code, numeric, numeric, numeric,
  numeric, numeric, numeric, text, text, jsonb, text, boolean
);

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
  p_items             jsonb,
  p_shipping_method   text default null,
  p_show_specification boolean default true,
  p_show_weight        boolean default false
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
    tax_amount, shipping_fee, discount, total, notes, terms, shipping_method,
    show_specification, show_weight, status, created_by
  ) values (
    p_customer_id, p_customer_snapshot, p_currency, p_subtotal, p_tax_rate,
    p_tax_amount, p_shipping_fee, p_discount, p_total, p_notes, p_terms, p_shipping_method,
    coalesce(p_show_specification, true), coalesce(p_show_weight, false), 'active', auth.uid()
  )
  returning proforma_invoices.id, proforma_invoices.pi_number
    into v_pi_id, v_pi_no;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.pi_items (
      pi_id, product_id, sku, name, description, image_url, remark_image_url,
      specification, weight_g, unit, unit_price, quantity, line_total, sort_order
    ) values (
      v_pi_id,
      nullif(v_item->>'product_id','')::uuid,
      v_item->>'sku',
      v_item->>'name',
      v_item->>'description',
      nullif(v_item->>'image_url',''),
      nullif(v_item->>'remark_image_url',''),
      nullif(v_item->>'specification',''),
      nullif(v_item->>'weight_g','')::numeric,
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

-- ============================================================
-- 4) 计算重量模块：主表 + 明细表 + 编号序列 + RLS + 创建函数
-- ============================================================
create table if not exists public.weight_calculations (
  id             uuid primary key default uuid_generate_v4(),
  calc_number    text not null unique,
  title          text,
  source_pi_id   uuid references public.proforma_invoices(id) on delete set null,
  total_quantity numeric(14,2) not null default 0,
  total_weight_g numeric(16,3) not null default 0,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now()
);
comment on table public.weight_calculations is '重量计算单主表';

create index if not exists idx_wc_creator on public.weight_calculations (created_by);
create index if not exists idx_wc_created on public.weight_calculations (created_at);

create table if not exists public.weight_calc_items (
  id            uuid primary key default uuid_generate_v4(),
  calc_id       uuid not null references public.weight_calculations(id) on delete cascade,
  product_id    uuid references public.products(id) on delete set null,
  sku           text,
  name          text not null,
  image_url     text,
  weight_g      numeric(12,3) not null default 0,
  quantity      numeric(12,2) not null default 0,
  line_weight_g numeric(16,3) not null default 0,
  sort_order    int not null default 0
);
comment on table public.weight_calc_items is '重量计算单明细行';

create index if not exists idx_wc_items_calc on public.weight_calc_items (calc_id);

-- 编号序列：WC-YYYY-NNN，按年独立递增
create table if not exists public.weight_calc_sequences (
  year     int primary key,
  last_seq int not null default 0
);

create or replace function public.next_weight_calc_number()
returns text
language plpgsql
security definer set search_path = public
as $$
declare
  cur_year int := extract(year from current_date)::int;
  new_seq  int;
begin
  insert into public.weight_calc_sequences (year, last_seq)
  values (cur_year, 1)
  on conflict (year)
  do update set last_seq = weight_calc_sequences.last_seq + 1
  returning last_seq into new_seq;

  return 'WC-' || cur_year || '-' || lpad(new_seq::text, 3, '0');
end;
$$;

create or replace function public.set_weight_calc_number()
returns trigger
language plpgsql
as $$
begin
  if new.calc_number is null or new.calc_number = '' then
    new.calc_number := public.next_weight_calc_number();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_weight_calc_number on public.weight_calculations;
create trigger trg_set_weight_calc_number
  before insert on public.weight_calculations
  for each row execute function public.set_weight_calc_number();

-- RLS
alter table public.weight_calculations enable row level security;
alter table public.weight_calc_items   enable row level security;

drop policy if exists "wc_select_own" on public.weight_calculations;
create policy "wc_select_own" on public.weight_calculations
  for select using (created_by = auth.uid() or public.is_admin());
drop policy if exists "wc_insert" on public.weight_calculations;
create policy "wc_insert" on public.weight_calculations
  for insert with check (auth.role() = 'authenticated');
drop policy if exists "wc_update" on public.weight_calculations;
create policy "wc_update" on public.weight_calculations
  for update using (created_by = auth.uid() or public.is_admin());
drop policy if exists "wc_delete" on public.weight_calculations;
create policy "wc_delete" on public.weight_calculations
  for delete using (created_by = auth.uid() or public.is_admin());

drop policy if exists "wc_items_select_own" on public.weight_calc_items;
create policy "wc_items_select_own" on public.weight_calc_items
  for select using (
    exists (
      select 1 from public.weight_calculations wc
      where wc.id = weight_calc_items.calc_id
        and (wc.created_by = auth.uid() or public.is_admin())
    )
  );
drop policy if exists "wc_items_write" on public.weight_calc_items;
create policy "wc_items_write" on public.weight_calc_items
  for all using (
    exists (
      select 1 from public.weight_calculations wc
      where wc.id = weight_calc_items.calc_id
        and (wc.created_by = auth.uid() or public.is_admin())
    )
  )
  with check (
    exists (
      select 1 from public.weight_calculations wc
      where wc.id = weight_calc_items.calc_id
        and (wc.created_by = auth.uid() or public.is_admin())
    )
  );

-- 原子创建函数：创建重量计算单 + 明细行
create or replace function public.create_weight_calc_with_items(
  p_title          text,
  p_source_pi_id   uuid,
  p_total_quantity numeric,
  p_total_weight_g numeric,
  p_items          jsonb
)
returns table (id uuid, calc_number text)
language plpgsql
security invoker
as $$
declare
  v_id   uuid;
  v_no   text;
  v_item jsonb;
  v_idx  int := 0;
begin
  insert into public.weight_calculations (
    title, source_pi_id, total_quantity, total_weight_g, created_by
  ) values (
    nullif(p_title,''),
    p_source_pi_id,
    coalesce(p_total_quantity, 0),
    coalesce(p_total_weight_g, 0),
    auth.uid()
  )
  returning weight_calculations.id, weight_calculations.calc_number
    into v_id, v_no;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.weight_calc_items (
      calc_id, product_id, sku, name, image_url,
      weight_g, quantity, line_weight_g, sort_order
    ) values (
      v_id,
      nullif(v_item->>'product_id','')::uuid,
      v_item->>'sku',
      v_item->>'name',
      nullif(v_item->>'image_url',''),
      coalesce((v_item->>'weight_g')::numeric, 0),
      coalesce((v_item->>'quantity')::numeric, 0),
      coalesce((v_item->>'line_weight_g')::numeric, 0),
      coalesce((v_item->>'sort_order')::int, v_idx)
    );
    v_idx := v_idx + 1;
  end loop;

  return query select v_id, v_no;
end;
$$;
