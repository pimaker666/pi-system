-- 0095_apply_order_ship_permission.sql
-- 将角色/账号的“登记发货”权限接入发货操作链路。

create or replace function public.has_current_permission(p_permission text)
returns boolean
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_profile public.profiles%rowtype;
  v_template public.permission_templates%rowtype;
  v_override public.profile_permission_overrides%rowtype;
begin
  if nullif(btrim(p_permission), '') is null then
    return false;
  end if;

  select * into v_profile
  from public.profiles
  where id = (select auth.uid());
  if not found or v_profile.status::text <> 'approved' then
    return false;
  end if;

  select * into v_template
  from public.permission_templates
  where system_role = v_profile.role;

  select * into v_override
  from public.profile_permission_overrides
  where profile_id = v_profile.id
    and (expires_at is null or expires_at > now());

  if found and v_override.denied_permissions ? p_permission then
    return false;
  end if;
  if found and v_override.allowed_permissions ? p_permission then
    return true;
  end if;

  return coalesce(
    v_template.permissions #> string_to_array(p_permission, '.'),
    'false'::jsonb
  ) = 'true'::jsonb;
end;
$$;

revoke all on function public.has_current_permission(text) from public, anon, authenticated, service_role;
grant execute on function public.has_current_permission(text) to authenticated;

-- 历史发货逻辑始终允许财务操作；将该既有权限写入可配置模板。
update public.permission_templates
set permissions = jsonb_set(permissions, '{orders,ship}', 'true'::jsonb, true),
    updated_at = now()
where system_role = 'finance'
  and permissions #> '{orders,ship}' = 'false'::jsonb;

create or replace function public.create_business_order_shipment(
  p_order_id uuid,
  p_shipped_at timestamptz,
  p_tracking_number text,
  p_notes text,
  p_items jsonb,
  p_idempotency_key text,
  p_allow_overship boolean,
  p_overship_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.has_current_permission('orders.ship') then
    raise exception 'Current account does not have shipment permission';
  end if;

  return public.create_business_order_shipment_internal_0057(
    p_order_id, p_shipped_at, p_tracking_number, p_notes, p_items,
    p_idempotency_key, p_allow_overship, p_overship_reason
  );
end;
$$;

create or replace function public.void_business_order_shipment(
  p_shipment_id uuid,
  p_reason text
)
returns public.business_order_shipments
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_current_permission('orders.ship') then
    raise exception 'Current account does not have shipment permission';
  end if;

  return public.void_business_order_shipment_internal_0057(p_shipment_id, p_reason);
end;
$$;
