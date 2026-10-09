-- 0090 权限模板、账号例外授权与订单编辑审批规则
-- 本迁移只持久化和决议配置，不改变既有订单状态机或 RPC 行为。

begin;

create table if not exists public.permission_templates (
  id uuid primary key default uuid_generate_v4(),
  system_role public.user_role not null unique,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text not null default '' check (char_length(description) <= 500),
  permissions jsonb not null default '{}'::jsonb check (jsonb_typeof(permissions) = 'object'),
  data_scope text not null default 'self' check (data_scope in ('self', 'self_and_subordinates', 'team', 'all')),
  sensitive_fields jsonb not null default '{}'::jsonb check (jsonb_typeof(sensitive_fields) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

create table if not exists public.profile_permission_overrides (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  allowed_permissions jsonb not null default '[]'::jsonb check (jsonb_typeof(allowed_permissions) = 'array'),
  denied_permissions jsonb not null default '[]'::jsonb check (jsonb_typeof(denied_permissions) = 'array'),
  data_scope text check (data_scope is null or data_scope in ('self', 'self_and_subordinates', 'team', 'all')),
  sensitive_fields jsonb not null default '{}'::jsonb check (jsonb_typeof(sensitive_fields) = 'object'),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  check (expires_at is null or expires_at > created_at)
);

create table if not exists public.order_edit_approval_rules (
  id uuid primary key default uuid_generate_v4(),
  name text not null unique check (char_length(btrim(name)) between 1 and 120),
  enabled boolean not null default true,
  target text not null default 'business_order' check (target in ('business_order', 'daily_order')),
  trigger_actions text[] not null default array['order_edit']::text[] check (
    cardinality(trigger_actions) > 0
    and trigger_actions <@ array['order_edit', 'amount_or_rate_change', 'shipment_change', 'void_order']::text[]
  ),
  conditions jsonb not null default '{}'::jsonb check (jsonb_typeof(conditions) = 'object'),
  reviewer_roles public.user_role[] not null default '{}'::public.user_role[],
  reviewer_ids uuid[] not null default '{}'::uuid[],
  approval_mode text not null default 'any' check (approval_mode in ('any', 'sequential')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  check (not enabled or cardinality(reviewer_roles) > 0 or cardinality(reviewer_ids) > 0)
);

create table if not exists public.permission_audit_logs (
  id bigint generated always as identity primary key,
  entity_type text not null check (entity_type in ('permission_template', 'profile_permission_override', 'order_edit_approval_rule')),
  entity_id uuid not null,
  action text not null check (action in ('create', 'update', 'delete')),
  old_data jsonb,
  new_data jsonb,
  actor_id uuid references public.profiles(id) on delete set null,
  actor_snapshot jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_permission_audit_logs_entity_created
  on public.permission_audit_logs (entity_type, entity_id, created_at desc);
create index if not exists idx_permission_audit_logs_actor_created
  on public.permission_audit_logs (actor_id, created_at desc);
create index if not exists idx_order_edit_approval_rules_target_enabled
  on public.order_edit_approval_rules (target, enabled, updated_at desc);

insert into public.permission_templates (
  system_role, name, description, permissions, data_scope, sensitive_fields
) values
  ('admin', '管理员', '管理全部系统设置、账号、权限与订单。',
    '{"orders":{"view":true,"create":true,"edit":true,"void":true,"approve":true,"ship":true,"export":true,"record_transfer":true},"finance":{"view":true,"financial_number":true,"cost":true,"profit":true,"exchange_rate":true},"products":{"view":true,"edit":true},"customers":{"view":true,"edit":true},"pi":{"view":true,"create":true,"edit":true,"void":true},"system":{"manage_users":true,"manage_permissions":true,"view_audit":true}}'::jsonb,
    'all',
    '{"financial_number":true,"product_name":true,"cost":true,"profit":true,"exchange_rate":true}'::jsonb),
  ('finance', '财务', '查看财务数据、登记收款并处理财务订单。',
    '{"orders":{"view":true,"create":false,"edit":false,"void":false,"approve":false,"ship":false,"export":true,"record_transfer":true},"finance":{"view":true,"financial_number":true,"cost":true,"profit":true,"exchange_rate":true},"products":{"view":true,"edit":false},"customers":{"view":true,"edit":false},"pi":{"view":true,"create":false,"edit":false,"void":false},"system":{"manage_users":false,"manage_permissions":false,"view_audit":true}}'::jsonb,
    'all',
    '{"financial_number":true,"product_name":true,"cost":true,"profit":true,"exchange_rate":true}'::jsonb),
  ('supervisor', '业务主管', '管理本人和下级的业务订单与客户。',
    '{"orders":{"view":true,"create":true,"edit":true,"void":false,"approve":false,"ship":true,"export":true,"record_transfer":false},"finance":{"view":false,"financial_number":false,"cost":false,"profit":false,"exchange_rate":false},"products":{"view":true,"edit":true},"customers":{"view":true,"edit":true},"pi":{"view":true,"create":true,"edit":true,"void":true},"system":{"manage_users":false,"manage_permissions":false,"view_audit":false}}'::jsonb,
    'self_and_subordinates',
    '{"financial_number":false,"product_name":true,"cost":false,"profit":false,"exchange_rate":false}'::jsonb),
  ('sales', '业务员', '管理本人名下的客户、PI 和业务订单。',
    '{"orders":{"view":true,"create":true,"edit":true,"void":false,"approve":false,"ship":true,"export":true,"record_transfer":false},"finance":{"view":false,"financial_number":false,"cost":false,"profit":false,"exchange_rate":false},"products":{"view":true,"edit":true},"customers":{"view":true,"edit":true},"pi":{"view":true,"create":true,"edit":true,"void":true},"system":{"manage_users":false,"manage_permissions":false,"view_audit":false}}'::jsonb,
    'self',
    '{"financial_number":false,"product_name":true,"cost":false,"profit":false,"exchange_rate":false}'::jsonb)
on conflict (system_role) do nothing;

create or replace function public.permission_require_admin()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles
    where id = (select auth.uid())
      and role::text = 'admin'
      and status::text = 'approved'
  ) then
    raise exception 'Only approved administrators can manage permissions';
  end if;
end;
$$;

create or replace function public.write_permission_audit(
  p_entity_type text,
  p_entity_id uuid,
  p_action text,
  p_old_data jsonb,
  p_new_data jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
begin
  select * into v_actor from public.profiles where id = (select auth.uid());
  if not found then
    raise exception 'Audit actor does not exist';
  end if;
  insert into public.permission_audit_logs (
    entity_type, entity_id, action, old_data, new_data, actor_id, actor_snapshot
  ) values (
    p_entity_type, p_entity_id, p_action, p_old_data, p_new_data, v_actor.id,
    jsonb_build_object('id', v_actor.id, 'email', v_actor.email, 'full_name', v_actor.full_name, 'role', v_actor.role::text)
  );
end;
$$;

create or replace function public.admin_save_permission_template(
  p_system_role public.user_role,
  p_name text,
  p_description text,
  p_permissions jsonb,
  p_data_scope text,
  p_sensitive_fields jsonb
)
returns public.permission_templates
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_row public.permission_templates%rowtype;
begin
  perform public.permission_require_admin();
  if jsonb_typeof(p_permissions) <> 'object' or jsonb_typeof(p_sensitive_fields) <> 'object' then
    raise exception 'Permissions and sensitive fields must be JSON objects';
  end if;
  if p_data_scope not in ('self', 'self_and_subordinates', 'team', 'all') then
    raise exception 'Invalid data scope';
  end if;
  select to_jsonb(pt) into v_old from public.permission_templates pt where pt.system_role = p_system_role;
  insert into public.permission_templates (system_role, name, description, permissions, data_scope, sensitive_fields, updated_by)
  values (p_system_role, nullif(btrim(p_name), ''), coalesce(p_description, ''), p_permissions, p_data_scope, p_sensitive_fields, (select auth.uid()))
  on conflict (system_role) do update set
    name = excluded.name, description = excluded.description, permissions = excluded.permissions,
    data_scope = excluded.data_scope, sensitive_fields = excluded.sensitive_fields,
    updated_at = now(), updated_by = excluded.updated_by
  returning * into v_row;
  perform public.write_permission_audit('permission_template', v_row.id, case when v_old is null then 'create' else 'update' end, v_old, to_jsonb(v_row));
  return v_row;
end;
$$;

create or replace function public.admin_save_profile_permission_override(
  p_profile_id uuid,
  p_allowed_permissions jsonb,
  p_denied_permissions jsonb,
  p_data_scope text,
  p_sensitive_fields jsonb,
  p_expires_at timestamptz
)
returns public.profile_permission_overrides
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_row public.profile_permission_overrides%rowtype;
begin
  perform public.permission_require_admin();
  if not exists (select 1 from public.profiles where id = p_profile_id) then
    raise exception 'Profile does not exist';
  end if;
  if jsonb_typeof(p_allowed_permissions) <> 'array' or jsonb_typeof(p_denied_permissions) <> 'array' or jsonb_typeof(p_sensitive_fields) <> 'object' then
    raise exception 'Invalid permission override payload';
  end if;
  if p_data_scope is not null and p_data_scope not in ('self', 'self_and_subordinates', 'team', 'all') then
    raise exception 'Invalid data scope';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'Expiry must be in the future';
  end if;
  select to_jsonb(po) into v_old from public.profile_permission_overrides po where po.profile_id = p_profile_id;
  insert into public.profile_permission_overrides (profile_id, allowed_permissions, denied_permissions, data_scope, sensitive_fields, expires_at, updated_by)
  values (p_profile_id, p_allowed_permissions, p_denied_permissions, p_data_scope, p_sensitive_fields, p_expires_at, (select auth.uid()))
  on conflict (profile_id) do update set
    allowed_permissions = excluded.allowed_permissions, denied_permissions = excluded.denied_permissions,
    data_scope = excluded.data_scope, sensitive_fields = excluded.sensitive_fields, expires_at = excluded.expires_at,
    updated_at = now(), updated_by = excluded.updated_by
  returning * into v_row;
  perform public.write_permission_audit('profile_permission_override', v_row.profile_id, case when v_old is null then 'create' else 'update' end, v_old, to_jsonb(v_row));
  return v_row;
end;
$$;

create or replace function public.admin_save_order_edit_approval_rule(
  p_id uuid,
  p_name text,
  p_enabled boolean,
  p_target text,
  p_trigger_actions text[],
  p_conditions jsonb,
  p_reviewer_roles public.user_role[],
  p_reviewer_ids uuid[],
  p_approval_mode text
)
returns public.order_edit_approval_rules
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_row public.order_edit_approval_rules%rowtype;
  v_id uuid := coalesce(p_id, pg_catalog.gen_random_uuid());
begin
  perform public.permission_require_admin();
  if p_target not in ('business_order', 'daily_order') or p_approval_mode not in ('any', 'sequential') then
    raise exception 'Invalid approval rule configuration';
  end if;
  if jsonb_typeof(p_conditions) <> 'object' or coalesce(cardinality(p_trigger_actions), 0) = 0
     or not (p_trigger_actions <@ array['order_edit', 'amount_or_rate_change', 'shipment_change', 'void_order']::text[])
  then
    raise exception 'Invalid approval rule conditions';
  end if;
  if p_enabled and coalesce(cardinality(p_reviewer_roles), 0) = 0 and coalesce(cardinality(p_reviewer_ids), 0) = 0 then
    raise exception 'Enabled rule requires at least one reviewer';
  end if;
  if exists (select 1 from unnest(coalesce(p_reviewer_ids, '{}'::uuid[])) reviewer_id where not exists (select 1 from public.profiles where id = reviewer_id and status::text = 'approved')) then
    raise exception 'Reviewers must be approved accounts';
  end if;
  select to_jsonb(ar) into v_old from public.order_edit_approval_rules ar where ar.id = v_id;
  insert into public.order_edit_approval_rules (id, name, enabled, target, trigger_actions, conditions, reviewer_roles, reviewer_ids, approval_mode, updated_by)
  values (v_id, nullif(btrim(p_name), ''), p_enabled, p_target, p_trigger_actions, p_conditions, coalesce(p_reviewer_roles, '{}'::public.user_role[]), coalesce(p_reviewer_ids, '{}'::uuid[]), p_approval_mode, (select auth.uid()))
  on conflict (id) do update set
    name = excluded.name, enabled = excluded.enabled, target = excluded.target, trigger_actions = excluded.trigger_actions,
    conditions = excluded.conditions, reviewer_roles = excluded.reviewer_roles, reviewer_ids = excluded.reviewer_ids,
    approval_mode = excluded.approval_mode, updated_at = now(), updated_by = excluded.updated_by
  returning * into v_row;
  perform public.write_permission_audit('order_edit_approval_rule', v_row.id, case when v_old is null then 'create' else 'update' end, v_old, to_jsonb(v_row));
  return v_row;
end;
$$;

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
    'sensitive_fields', coalesce(v_override.sensitive_fields, v_template.sensitive_fields, '{}'::jsonb),
    'override_expires_at', v_override.expires_at
  );
end;
$$;

alter table public.permission_templates enable row level security;
alter table public.profile_permission_overrides enable row level security;
alter table public.order_edit_approval_rules enable row level security;
alter table public.permission_audit_logs enable row level security;

grant select on public.permission_templates, public.profile_permission_overrides,
  public.order_edit_approval_rules, public.permission_audit_logs to authenticated;

drop policy if exists permission_templates_admin_select on public.permission_templates;
create policy permission_templates_admin_select on public.permission_templates
  for select to authenticated using (public.is_admin());
drop policy if exists permission_overrides_admin_or_self_select on public.profile_permission_overrides;
create policy permission_overrides_admin_or_self_select on public.profile_permission_overrides
  for select to authenticated using (public.is_admin() or profile_id = (select auth.uid()));
drop policy if exists order_edit_approval_rules_admin_select on public.order_edit_approval_rules;
create policy order_edit_approval_rules_admin_select on public.order_edit_approval_rules
  for select to authenticated using (public.is_admin());
drop policy if exists permission_audit_logs_admin_select on public.permission_audit_logs;
create policy permission_audit_logs_admin_select on public.permission_audit_logs
  for select to authenticated using (public.is_admin());

revoke all on function public.permission_require_admin() from public, anon, authenticated, service_role;
revoke all on function public.write_permission_audit(text, uuid, text, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.admin_save_permission_template(public.user_role, text, text, jsonb, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.admin_save_profile_permission_override(uuid, jsonb, jsonb, text, jsonb, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.admin_save_order_edit_approval_rule(uuid, text, boolean, text, text[], jsonb, public.user_role[], uuid[], text) from public, anon, authenticated, service_role;
revoke all on function public.get_profile_permission_resolution(uuid) from public, anon, authenticated, service_role;
grant execute on function public.admin_save_permission_template(public.user_role, text, text, jsonb, text, jsonb) to authenticated;
grant execute on function public.admin_save_profile_permission_override(uuid, jsonb, jsonb, text, jsonb, timestamptz) to authenticated;
grant execute on function public.admin_save_order_edit_approval_rule(uuid, text, boolean, text, text[], jsonb, public.user_role[], uuid[], text) to authenticated;
grant execute on function public.get_profile_permission_resolution(uuid) to authenticated;

commit;
