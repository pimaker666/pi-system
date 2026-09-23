-- 0077 定制产品库订单明细
-- 按定制产品汇总其真实订单行，保留编码、图片和下单快照，供产品库展示。

begin;

drop function if exists public.list_business_custom_products_library(text, uuid, text);

create function public.list_business_custom_products_library(
  p_search text,
  p_product_group_id uuid,
  p_status text
)
returns table (
  custom_product_id uuid,
  is_archived boolean,
  created_by uuid,
  created_at timestamptz,
  updated_by uuid,
  updated_at timestamptz,
  latest_version_id uuid,
  latest_version_no int,
  version_count bigint,
  product_group_id uuid,
  product_group_name text,
  code text,
  name text,
  description text,
  specification text,
  unit text,
  image_url text,
  quantity numeric,
  default_unit_price numeric,
  default_currency public.currency_code,
  order_amount numeric,
  received_amount numeric,
  outstanding_amount numeric,
  order_history jsonb,
  total_order_quantity numeric,
  total_order_amounts jsonb
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_status text := coalesce(nullif(lower(btrim(p_status)), ''), 'active');
  v_search text := nullif(btrim(p_search), '');
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved business role required';
  end if;
  if v_status not in ('active', 'archived', 'all') then
    raise exception 'Invalid custom product library status';
  end if;

  return query
  select cp.id, cp.is_archived, cp.created_by, cp.created_at, cp.updated_by, cp.updated_at,
         latest.id, latest.version_no, counts.version_count,
         latest.product_group_id, pg.name,
         latest.code, latest.name, latest.description, latest.specification,
         latest.unit, latest.image_url, latest.quantity, latest.default_unit_price,
         latest.default_currency, latest.order_amount, latest.received_amount,
         latest.outstanding_amount,
         coalesce(history.rows, '[]'::jsonb),
         coalesce(history.total_quantity, 0),
         coalesce(amounts.rows, '[]'::jsonb)
  from public.business_custom_products cp
  left join lateral (
    select v.*
    from public.business_custom_product_versions v
    where v.custom_product_id = cp.id
    order by v.version_no desc
    limit 1
  ) latest on true
  left join public.product_groups pg on pg.id = latest.product_group_id
  cross join lateral (
    select count(*) as version_count
    from public.business_custom_product_versions v
    where v.custom_product_id = cp.id
  ) counts
  left join lateral (
    select
      jsonb_agg(
        jsonb_build_object(
          'code', i.sku_snapshot,
          'name', i.name_snapshot,
          'unit', i.unit_snapshot,
          'image_url', i.image_url_snapshot,
          'quantity', i.quantity,
          'order_date', bo.order_date,
          'order_number', bo.order_number,
          'external_order_number', bo.external_order_number,
          'currency', bo.currency,
          'order_amount', i.line_amount
        )
        order by bo.order_date desc, i.created_at desc, i.id desc
      ) as rows,
      sum(i.quantity) as total_quantity
    from public.business_order_items i
    join public.business_orders bo on bo.id = i.order_id
    where i.source_type = 'custom'
      and i.custom_product_id = cp.id
      and bo.voided_at is null
  ) history on true
  left join lateral (
    select jsonb_agg(
      jsonb_build_object('currency', grouped.currency, 'amount', grouped.amount)
      order by grouped.currency
    ) as rows
    from (
      select bo.currency, sum(i.line_amount) as amount
      from public.business_order_items i
      join public.business_orders bo on bo.id = i.order_id
      where i.source_type = 'custom'
        and i.custom_product_id = cp.id
        and bo.voided_at is null
      group by bo.currency
    ) grouped
  ) amounts on true
  where (p_product_group_id is null or latest.product_group_id = p_product_group_id)
    and (v_status = 'all'
         or (v_status = 'active' and not cp.is_archived)
         or (v_status = 'archived' and cp.is_archived))
    and (v_search is null or concat_ws(
      ' ', latest.code, latest.name, latest.description, latest.specification, pg.name
    ) ilike '%' || v_search || '%')
  order by cp.updated_at desc, cp.id;
end;
$$;

revoke all on function public.list_business_custom_products_library(text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_business_custom_products_library(text, uuid, text)
  to authenticated;

commit;
