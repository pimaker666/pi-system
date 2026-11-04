-- 0139_permission_wiring.sql
-- 权限接线：新增 current_sensitive_fields()（模板按键合并账号例外，与 0100 解析口径一致），
-- 并补齐接线后模板默认值，保证线上既有能力不因接线回退。

-- 当前账号的敏感字段可见性：角色模板与账号例外按键合并（override 未设置的键继承模板）。
create or replace function public.current_sensitive_fields()
returns jsonb
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
  select * into v_profile
  from public.profiles
  where id = (select auth.uid());
  if not found or v_profile.status::text <> 'approved' then
    return '{}'::jsonb;
  end if;

  select * into v_template
  from public.permission_templates
  where system_role = v_profile.role;

  select * into v_override
  from public.profile_permission_overrides
  where profile_id = v_profile.id
    and (expires_at is null or expires_at > now());

  return coalesce(v_template.sensitive_fields, '{}'::jsonb)
    || coalesce(v_override.sensitive_fields, '{}'::jsonb);
end;
$$;

revoke all on function public.current_sensitive_fields() from public, anon, authenticated, service_role;
grant execute on function public.current_sensitive_fields() to authenticated;

-- 历史作废逻辑始终允许财务操作；将该既有权限写入可配置模板（沿用 0095 的做法）。
update public.permission_templates
set permissions = jsonb_set(permissions, '{orders,void}', 'true'::jsonb, true),
    updated_at = now()
where system_role = 'finance'
  and permissions #> '{orders,void}' = 'false'::jsonb;

-- 业务员/主管的登记转账动作此前对这两个角色开放；接线后权限点默认跟随现状，
-- 之后可在权限配置页按需收回。
update public.permission_templates
set permissions = jsonb_set(permissions, '{orders,record_transfer}', 'true'::jsonb, true),
    updated_at = now()
where system_role in ('sales', 'supervisor')
  and permissions #> '{orders,record_transfer}' = 'false'::jsonb;

-- 新权限点：考勤工资管理（考勤表/工资表/请假审批）。财务现状即可管理，先写入 true；
-- 公司设置与报销审批现状仅管理员，非管理员角色写 false。
-- 注意 jsonb_set 不会创建中间层键，这里先取顶层对象再按键合并。
update public.permission_templates
set permissions = jsonb_set(
      permissions,
      '{attendance}',
      coalesce(permissions -> 'attendance', '{}'::jsonb) || '{"manage": true}'::jsonb,
      true
    ),
    updated_at = now()
where system_role in ('admin', 'finance');

update public.permission_templates
set permissions = jsonb_set(
      permissions,
      '{attendance}',
      coalesce(permissions -> 'attendance', '{}'::jsonb) || '{"manage": false}'::jsonb,
      true
    ),
    updated_at = now()
where system_role in ('sales', 'supervisor');

update public.permission_templates
set permissions = jsonb_set(
      permissions,
      '{company}',
      coalesce(permissions -> 'company', '{}'::jsonb) || '{"settings": true}'::jsonb,
      true
    ),
    updated_at = now()
where system_role = 'admin';

update public.permission_templates
set permissions = jsonb_set(
      permissions,
      '{company}',
      coalesce(permissions -> 'company', '{}'::jsonb) || '{"settings": false}'::jsonb,
      true
    ),
    updated_at = now()
where system_role in ('finance', 'sales', 'supervisor');

update public.permission_templates
set permissions = jsonb_set(
      permissions,
      '{reimbursement}',
      coalesce(permissions -> 'reimbursement', '{}'::jsonb) || '{"review": true}'::jsonb,
      true
    ),
    updated_at = now()
where system_role = 'admin';

update public.permission_templates
set permissions = jsonb_set(
      permissions,
      '{reimbursement}',
      coalesce(permissions -> 'reimbursement', '{}'::jsonb) || '{"review": false}'::jsonb,
      true
    ),
    updated_at = now()
where system_role in ('finance', 'sales', 'supervisor');
