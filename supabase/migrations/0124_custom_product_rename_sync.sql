-- 定制产品库改名后同步订单行名称：
-- 1) 回填历史数据：订单行名称对齐所引用定制产品的最新版本名称
-- 2) add_business_custom_product_version 新增版本时自动把最新名称写入所有引用行，
--    之后所有读 name_snapshot 的页面（订单详情/台账/成本/提成/已结算）随库更新
-- 作废/完结订单的产品行受 protect_business_order_item_invariants 保护不可改，
-- 名称同步只覆盖仍在进行的订单；已完结/作废的归档行保持结算时名称
update public.business_order_items i
set name_snapshot = v.name
from (
  select custom_product_id, name
  from (
    select custom_product_id, name,
           row_number() over (partition by custom_product_id order by version_no desc) as rn
    from public.business_custom_product_versions
  ) ranked
  where rn = 1
) v
where i.custom_product_id = v.custom_product_id
  and i.name_snapshot is distinct from v.name
  and not exists (
    select 1 from public.business_orders o
    where o.id = i.order_id
      and (o.voided_at is not null or o.status::text = 'completed' or o.closed_at is not null)
  );

CREATE OR REPLACE FUNCTION public.add_business_custom_product_version(p_custom_product_id uuid, p_product_group_id uuid, p_code text, p_name text, p_description text, p_specification text, p_unit text, p_image_url text, p_default_unit_price numeric, p_default_currency currency_code, p_quantity numeric, p_received_amount numeric)
 RETURNS business_custom_product_versions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_product public.business_custom_products%rowtype;
  v_version public.business_custom_product_versions%rowtype;
  v_version_no int;
begin
  select * into v_actor from public.profiles where id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved business role required to create custom product versions';
  end if;

  select * into v_product
  from public.business_custom_products
  where id = p_custom_product_id
  for update;
  if not found then
    raise exception 'Custom product does not exist';
  end if;
  if v_product.is_archived then
    raise exception 'Archived custom product cannot receive a new version';
  end if;

  if p_product_group_id is null or not exists (
    select 1 from public.product_groups where id = p_product_group_id
  ) then
    raise exception 'Product group does not exist';
  end if;
  if char_length(btrim(coalesce(p_code, ''))) > 100 then
    raise exception 'Custom product code cannot exceed 100 characters';
  end if;
  if nullif(btrim(p_name), '') is null or char_length(btrim(p_name)) > 300 then
    raise exception 'Custom product name is required and cannot exceed 300 characters';
  end if;
  if char_length(btrim(coalesce(p_unit, ''))) > 100 then
    raise exception 'Custom product unit cannot exceed 100 characters';
  end if;
  if char_length(coalesce(p_description, '')) > 4000
     or char_length(coalesce(p_specification, '')) > 2000
     or char_length(coalesce(p_image_url, '')) > 2000 then
    raise exception 'Custom product version text exceeds maximum length';
  end if;
  if p_default_unit_price is null or p_default_unit_price < 0
     or p_default_unit_price > 999999999999 then
    raise exception 'Default unit price is invalid';
  end if;
  if p_default_currency is null then
    raise exception 'Default currency is required';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 999999999999 then
    raise exception 'Custom product quantity is invalid';
  end if;
  if round(round(p_quantity, 4) * round(p_default_unit_price, 4), 4)
     > 9999999999999999.99 then
    raise exception 'Custom product order amount is invalid';
  end if;
  if p_received_amount is not null and (
    p_received_amount < 0 or p_received_amount > 999999999999
  ) then
    raise exception 'Custom product received amount is invalid';
  end if;

  select coalesce(max(version_no), 0) + 1 into v_version_no
  from public.business_custom_product_versions
  where custom_product_id = v_product.id;

  insert into public.business_custom_product_versions (
    custom_product_id, version_no, product_group_id, code, name, description,
    specification, unit, image_url, default_unit_price, default_currency,
    quantity, received_amount, created_by
  ) values (
    v_product.id, v_version_no, p_product_group_id,
    btrim(coalesce(p_code, '')), btrim(p_name),
    nullif(btrim(p_description), ''), nullif(btrim(p_specification), ''),
    btrim(coalesce(p_unit, '')), nullif(btrim(p_image_url), ''), p_default_unit_price,
    p_default_currency, round(p_quantity, 4),
    case when p_received_amount is null then null else round(p_received_amount, 4) end,
    v_uid
  ) returning * into v_version;

  update public.business_custom_products set updated_by = v_uid where id = v_product.id;

  -- 同步最新名称到进行中的订单行；作废/完结订单行受触发器保护保持原样
  update public.business_order_items i
  set name_snapshot = v_version.name
  from public.business_orders o
  where o.id = i.order_id
    and i.custom_product_id = v_product.id
    and i.name_snapshot is distinct from v_version.name
    and o.voided_at is null and o.status::text <> 'completed' and o.closed_at is null;

  perform public.write_business_lifecycle_audit(
    null, null, 'custom_product_version', v_version.id,
    'version_create', null, to_jsonb(v_version), null, v_uid
  );

  return v_version;
end;
$function$;
