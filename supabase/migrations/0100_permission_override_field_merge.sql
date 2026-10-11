-- 0100: 账号例外的敏感字段改为「按键合并」。
-- 旧逻辑 coalesce(override, template) 是整对象替换：例外只要设置了一个字段，
-- 模板里其余可见字段会被一起隐藏。改为 template || override 后，
-- 例外未设置的键自动继承角色模板，「继承」语义才成立。
create or replace function public.get_profile_permission_resolution(p_profile_id uuid)
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
  if not exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and status::text = 'approved'
      and (id = p_profile_id or role::text = 'admin')
  ) then
    raise exception 'Not allowed to view this permission resolution';
  end if;
  select * into v_profile from public.profiles where id = p_profile_id;
  if not found then raise exception 'Profile does not exist'; end if;
  select * into v_template from public.permission_templates where system_role = v_profile.role;
  select * into v_override from public.profile_permission_overrides where profile_id = p_profile_id and (expires_at is null or expires_at > now());
  return jsonb_build_object(
    'profile_id', v_profile.id,
    'role', v_profile.role::text,
    'template_permissions', coalesce(v_template.permissions, '{}'::jsonb),
    'allowed_permissions', coalesce(v_override.allowed_permissions, '[]'::jsonb),
    'denied_permissions', coalesce(v_override.denied_permissions, '[]'::jsonb),
    'data_scope', coalesce(v_override.data_scope, v_template.data_scope),
    'sensitive_fields', coalesce(v_template.sensitive_fields, '{}'::jsonb) || coalesce(v_override.sensitive_fields, '{}'::jsonb),
    'override_expires_at', v_override.expires_at
  );
end;
$$;
