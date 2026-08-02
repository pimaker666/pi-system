-- 0009_pi_item_remark_image.sql
-- PI 明细备注支持图片：新增 remark_image_url（开单时可上传的备注图片快照），
-- 并让原子创建函数写入该字段。
-- 幂等：可安全重复执行。

-- 1) pi_items 增加备注图片快照列
alter table public.pi_items
  add column if not exists remark_image_url text;

comment on column public.pi_items.remark_image_url is 'PI 该行备注图片的 URL 快照';

-- 2) 更新原子创建函数：插入明细时带上 remark_image_url（函数签名不变，仍通过 p_items jsonb 传值）
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
