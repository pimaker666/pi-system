-- 0033_fix_pi_creation_returning_rls.sql
--
-- The hardened PI SELECT policy calls can_view_pi(id), which queries the PI row.
-- INSERT ... RETURNING evaluates that SELECT policy before the new row can be
-- found by the helper, so otherwise-valid PI creation is rejected by RLS.
-- Generate the id first, insert without RETURNING, then read the generated number
-- in a separate statement after the row is visible within the transaction.

create or replace function public.create_pi_with_items(
  p_customer_id uuid,
  p_customer_snapshot jsonb,
  p_currency public.currency_code,
  p_subtotal numeric,
  p_tax_rate numeric,
  p_tax_amount numeric,
  p_shipping_fee numeric,
  p_discount numeric,
  p_total numeric,
  p_notes text,
  p_terms text,
  p_items jsonb,
  p_shipping_method text default null,
  p_show_specification boolean default true,
  p_show_weight boolean default false
)
returns table (id uuid, pi_number text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_pi_id uuid := pg_catalog.gen_random_uuid();
  v_pi_no text;
  v_item jsonb;
  v_idx integer := 0;
begin
  insert into public.proforma_invoices (
    id,
    customer_id,
    customer_snapshot,
    currency,
    subtotal,
    tax_rate,
    tax_amount,
    shipping_fee,
    discount,
    total,
    notes,
    terms,
    shipping_method,
    show_specification,
    show_weight,
    status,
    created_by
  ) values (
    v_pi_id,
    p_customer_id,
    p_customer_snapshot,
    p_currency,
    p_subtotal,
    p_tax_rate,
    p_tax_amount,
    p_shipping_fee,
    p_discount,
    p_total,
    p_notes,
    p_terms,
    p_shipping_method,
    coalesce(p_show_specification, true),
    coalesce(p_show_weight, false),
    'active',
    (select auth.uid())
  );

  select pi.pi_number
    into strict v_pi_no
  from public.proforma_invoices as pi
  where pi.id = v_pi_id;

  for v_item in
    select value
    from pg_catalog.jsonb_array_elements(p_items)
  loop
    insert into public.pi_items (
      pi_id,
      product_id,
      sku,
      name,
      description,
      image_url,
      remark_image_url,
      specification,
      weight_g,
      unit,
      unit_price,
      quantity,
      line_total,
      sort_order
    ) values (
      v_pi_id,
      nullif(v_item->>'product_id', '')::uuid,
      v_item->>'sku',
      v_item->>'name',
      v_item->>'description',
      nullif(v_item->>'image_url', ''),
      nullif(v_item->>'remark_image_url', ''),
      nullif(v_item->>'specification', ''),
      nullif(v_item->>'weight_g', '')::numeric,
      coalesce(v_item->>'unit', 'pcs'),
      (v_item->>'unit_price')::numeric,
      (v_item->>'quantity')::numeric,
      (v_item->>'line_total')::numeric,
      coalesce((v_item->>'sort_order')::integer, v_idx)
    );
    v_idx := v_idx + 1;
  end loop;

  return query select v_pi_id, v_pi_no;
end;
$$;

revoke all on function public.create_pi_with_items(
  uuid,
  jsonb,
  public.currency_code,
  numeric,
  numeric,
  numeric,
  numeric,
  numeric,
  numeric,
  text,
  text,
  jsonb,
  text,
  boolean,
  boolean
) from public, anon, service_role;

grant execute on function public.create_pi_with_items(
  uuid,
  jsonb,
  public.currency_code,
  numeric,
  numeric,
  numeric,
  numeric,
  numeric,
  numeric,
  text,
  text,
  jsonb,
  text,
  boolean,
  boolean
) to authenticated;
