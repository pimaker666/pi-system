-- 0039 定制产品编码与单位改为非必填
--
-- 业务背景：定制产品往来常常只有客户口头名称，没有内部编码，也没有明确计量单位。
-- 强制填写会逼业务员编造占位值，污染后续的编码检索与对账。
--
-- 兼容策略：列仍为 NOT NULL，空值统一落库为空串，因此 business_order_items 的
-- NOT NULL 行快照（sku_snapshot / unit_snapshot）无需任何改动。

-- -----------------------------------------------------------------------------
-- 1. 放宽表级 CHECK：只保留长度上限，允许空串。
--    0028 用的是匿名列内联 check，名字由 Postgres 生成，这里按定义匹配后重建为具名约束。
-- -----------------------------------------------------------------------------
do $$
declare
  v_constraint record;
begin
  for v_constraint in
    select con.conname, pg_get_constraintdef(con.oid) as definition
    from pg_constraint con
    where con.conrelid = 'public.business_custom_product_versions'::regclass
      and con.contype = 'c'
  loop
    if v_constraint.definition ~ 'btrim\(code\)'
       or v_constraint.definition ~ 'btrim\(unit\)' then
      execute format(
        'alter table public.business_custom_product_versions drop constraint %I',
        v_constraint.conname
      );
    end if;
  end loop;
end;
$$;

alter table public.business_custom_product_versions
  drop constraint if exists business_custom_product_versions_code_length;
alter table public.business_custom_product_versions
  add constraint business_custom_product_versions_code_length
    check (char_length(btrim(code)) <= 100);

alter table public.business_custom_product_versions
  drop constraint if exists business_custom_product_versions_unit_length;
alter table public.business_custom_product_versions
  add constraint business_custom_product_versions_unit_length
    check (char_length(btrim(unit)) <= 100);

comment on column public.business_custom_product_versions.code is
  '定制产品编码，非必填；未填写时存空串以保持行快照 NOT NULL 契约';
comment on column public.business_custom_product_versions.unit is
  '定制产品单位，非必填；未填写时存空串以保持行快照 NOT NULL 契约';

-- -----------------------------------------------------------------------------
-- 2. 放宽 RPC 守卫：仅校验长度上限，空编码/空单位归一化为空串。
--    其余守卫（角色、归档、分组、金额、数量）保持 0038 的行为不变。
-- -----------------------------------------------------------------------------
create or replace function public.add_business_custom_product_version(
  p_custom_product_id uuid,
  p_product_group_id uuid,
  p_code text,
  p_name text,
  p_description text,
  p_specification text,
  p_unit text,
  p_image_url text,
  p_default_unit_price numeric,
  p_default_currency public.currency_code,
  p_quantity numeric,
  p_received_amount numeric
)
returns public.business_custom_product_versions
language plpgsql
security definer
set search_path = public
as $$
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
  if round(round(p_quantity, 4) * round(p_default_unit_price, 2), 2)
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
    case when p_received_amount is null then null else round(p_received_amount, 2) end,
    v_uid
  ) returning * into v_version;

  update public.business_custom_products set updated_by = v_uid where id = v_product.id;

  perform public.write_business_lifecycle_audit(
    null, null, 'custom_product_version', v_version.id,
    'version_create', null, to_jsonb(v_version), null, v_uid
  );

  return v_version;
end;
$$;
revoke all on function public.add_business_custom_product_version(
  uuid, uuid, text, text, text, text, text, text, numeric,
  public.currency_code, numeric, numeric
) from public, anon, authenticated, service_role;
grant execute on function public.add_business_custom_product_version(
  uuid, uuid, text, text, text, text, text, text, numeric,
  public.currency_code, numeric, numeric
) to authenticated;
