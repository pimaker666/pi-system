-- 0010_pi_shipping_method.sql
-- PI 运输方式/时间：新增 shipping_method 文本列（如 "Sea Transportation, 22~40 Days"，
-- 开单时下拉预设或自由编辑，未选则为空），并让原子创建函数写入该字段。
-- 幂等：可安全重复执行。

-- 1) proforma_invoices 增加运输方式列
alter table public.proforma_invoices
  add column if not exists shipping_method text;

comment on column public.proforma_invoices.shipping_method is 'PI 运输方式与时间文本快照（如 Sea Transportation, 22~40 Days）';

-- 2) 更新原子创建函数：新增 p_shipping_method 入参并写入 proforma_invoices
-- 先删除旧的 12 参数重载，避免新增带默认值参数后产生两个重载导致调用歧义。
drop function if exists public.create_pi_with_items(
  uuid, jsonb, currency_code, numeric, numeric, numeric,
  numeric, numeric, numeric, text, text, jsonb
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
  p_shipping_method   text default null
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
    status, created_by
  ) values (
    p_customer_id, p_customer_snapshot, p_currency, p_subtotal, p_tax_rate,
    p_tax_amount, p_shipping_fee, p_discount, p_total, p_notes, p_terms, p_shipping_method,
    'active', auth.uid()
  )
  returning proforma_invoices.id, proforma_invoices.pi_number
    into v_pi_id, v_pi_no;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.pi_items (
      pi_id, product_id, sku, name, description, image_url, remark_image_url,
      unit, unit_price, quantity, line_total, sort_order
    ) values (
      v_pi_id,
      nullif(v_item->>'product_id','')::uuid,
      v_item->>'sku',
      v_item->>'name',
      v_item->>'description',
      nullif(v_item->>'image_url',''),
      nullif(v_item->>'remark_image_url',''),
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
