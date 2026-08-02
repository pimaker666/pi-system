-- 0011_pi_specification.sql
-- 产品规格 SPECIFICATION：
--  1) products 增加 specification 文本列（产品库规格，如 "34g*4pcs/box"）；
--  2) pi_items 增加 specification 文本快照（开单时可逐行修改，不回写产品库）；
--  3) proforma_invoices 增加 show_specification 布尔列（该 PI 是否显示规格列，默认显示）；
--  4) 更新原子创建函数：新增 p_show_specification 入参，并逐行写入 specification 快照。
-- 幂等：可安全重复执行。

-- 1) products.specification（产品库规格，长期维护）
alter table public.products
  add column if not exists specification text;

comment on column public.products.specification is '产品规格（如 34g*4pcs/box），可在开单时逐行覆盖';

-- 2) pi_items.specification（开单时的规格快照，可逐行修改）
alter table public.pi_items
  add column if not exists specification text;

comment on column public.pi_items.specification is 'PI 行规格快照（开单时可修改，不影响产品库）';

-- 3) proforma_invoices.show_specification（该 PI 是否显示规格列）
alter table public.proforma_invoices
  add column if not exists show_specification boolean not null default true;

comment on column public.proforma_invoices.show_specification is '该 PI 是否显示 SPECIFICATION 列（开单时可关闭）';

-- 4) 更新原子创建函数：先删除旧的 13 参数重载，避免新增带默认值参数产生调用歧义。
drop function if exists public.create_pi_with_items(
  uuid, jsonb, currency_code, numeric, numeric, numeric,
  numeric, numeric, numeric, text, text, jsonb, text
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
  p_show_specification boolean default true
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
    show_specification, status, created_by
  ) values (
    p_customer_id, p_customer_snapshot, p_currency, p_subtotal, p_tax_rate,
    p_tax_amount, p_shipping_fee, p_discount, p_total, p_notes, p_terms, p_shipping_method,
    coalesce(p_show_specification, true), 'active', auth.uid()
  )
  returning proforma_invoices.id, proforma_invoices.pi_number
    into v_pi_id, v_pi_no;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.pi_items (
      pi_id, product_id, sku, name, description, image_url, remark_image_url,
      specification, unit, unit_price, quantity, line_total, sort_order
    ) values (
      v_pi_id,
      nullif(v_item->>'product_id','')::uuid,
      v_item->>'sku',
      v_item->>'name',
      v_item->>'description',
      nullif(v_item->>'image_url',''),
      nullif(v_item->>'remark_image_url',''),
      nullif(v_item->>'specification',''),
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
