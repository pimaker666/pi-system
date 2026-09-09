-- 0033_account_handover_and_name_snapshots.sql
-- 账号继承与离职交接：
-- 1) 当前账号名称与历史业务展示彻底分离；
-- 2) 有业务数据的账号只停用，不删除；
-- 3) 客户及未完成订单由管理员事务化交接；
-- 4) 已完成/已审核历史归属与姓名快照保持不变。

-- -----------------------------------------------------------------------------
-- 1. 账号停用元数据与追加式生命周期审计
-- -----------------------------------------------------------------------------

-- SECURITY DEFINER 函数均使用 public search_path；普通登录角色不得在该 schema 建对象。
revoke create on schema public from public, anon, authenticated;

alter table public.profiles
  add column if not exists disabled_at timestamptz,
  add column if not exists disabled_by uuid references public.profiles(id) on delete set null;

-- 停用原因只保存在管理员可读的追加式生命周期审计表中，避免通过 profiles
-- 的全员可读策略泄露人事信息。

create table if not exists public.account_lifecycle_audit_logs (
  id                    bigint generated always as identity primary key,
  action                text not null check (
    action in ('name_change', 'disable', 'restore', 'handover', 'customer_transfer', 'customer_copy')
  ),
  source_user_id        uuid references public.profiles(id) on delete set null,
  target_user_id        uuid references public.profiles(id) on delete set null,
  source_name_snapshot  text,
  target_name_snapshot  text,
  actor_id              uuid references public.profiles(id) on delete set null,
  actor_name_snapshot   text not null,
  reason                text check (reason is null or char_length(reason) <= 1000),
  detail                jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now()
);

create index if not exists idx_account_lifecycle_source
  on public.account_lifecycle_audit_logs (source_user_id, created_at desc);
create index if not exists idx_account_lifecycle_target
  on public.account_lifecycle_audit_logs (target_user_id, created_at desc);
create index if not exists idx_account_lifecycle_actor
  on public.account_lifecycle_audit_logs (actor_id, created_at desc);

alter table public.account_lifecycle_audit_logs enable row level security;
revoke all on table public.account_lifecycle_audit_logs from public, anon, authenticated, service_role;
grant select on table public.account_lifecycle_audit_logs to authenticated;
drop policy if exists "account_lifecycle_admin_select" on public.account_lifecycle_audit_logs;
create policy "account_lifecycle_admin_select" on public.account_lifecycle_audit_logs
  for select to authenticated using (public.is_admin());

create or replace function public.reject_account_lifecycle_audit_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Account lifecycle audit logs are append-only';
end;
$$;
revoke all on function public.reject_account_lifecycle_audit_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_account_lifecycle_audit_immutable on public.account_lifecycle_audit_logs;
create trigger trg_account_lifecycle_audit_immutable
  before update or delete on public.account_lifecycle_audit_logs
  for each statement execute function public.reject_account_lifecycle_audit_mutation();

drop trigger if exists trg_account_lifecycle_audit_no_truncate on public.account_lifecycle_audit_logs;
create trigger trg_account_lifecycle_audit_no_truncate
  before truncate on public.account_lifecycle_audit_logs
  for each statement execute function public.reject_account_lifecycle_audit_mutation();

create or replace function public.profile_display_name(p_profile_id uuid)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    nullif(btrim(p.chinese_name), ''),
    nullif(btrim(p.full_name), ''),
    nullif(btrim(p.email), '')
  )
  from public.profiles p
  where p.id = p_profile_id;
$$;
revoke all on function public.profile_display_name(uuid)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. 独立的历史展示名快照。保留既有 salesperson_name_snapshot 原值，
--    避免用本次迁移覆盖原始历史字段。
-- -----------------------------------------------------------------------------

alter table public.business_orders
  add column if not exists salesperson_display_name_snapshot text;
alter table public.finance_orders
  add column if not exists salesperson_display_name_snapshot text;
alter table public.finance_transactions
  add column if not exists salesperson_display_name_snapshot text;
alter table public.proforma_invoices
  add column if not exists creator_display_name_snapshot text;
alter table public.weight_calculations
  add column if not exists creator_display_name_snapshot text;
alter table public.business_order_audit_logs
  add column if not exists actor_display_name_snapshot text;
alter table public.business_lifecycle_audit_logs
  add column if not exists actor_display_name_snapshot text;

-- 建立上线时显示基线：已有历史快照优先，实时账号名称只作为旧记录缺失快照时的兜底。
-- 仅补快照，不应污染原记录 updated_at；迁移事务失败会连同触发器状态一起回滚。
alter table public.business_orders disable trigger trg_business_orders_touch;
alter table public.finance_orders disable trigger trg_finance_orders_touch;
alter table public.finance_transactions disable trigger trg_finance_transactions_touch;
alter table public.proforma_invoices disable trigger trg_pi_touch;

update public.business_orders r
set salesperson_display_name_snapshot = coalesce(
  nullif(btrim(r.salesperson_name_snapshot), ''),
  public.profile_display_name(r.salesperson_id)
)
where r.salesperson_display_name_snapshot is null
  and r.status::text <> 'completed'
  and r.closed_at is null;
update public.finance_orders r
set salesperson_display_name_snapshot = coalesce(
  nullif(btrim(r.salesperson_name_snapshot), ''),
  public.profile_display_name(r.salesperson_id)
)
where r.salesperson_display_name_snapshot is null;
update public.finance_transactions r
set salesperson_display_name_snapshot = coalesce(
  nullif(btrim(r.salesperson_name_snapshot), ''),
  public.profile_display_name(r.salesperson_id)
)
where r.salesperson_display_name_snapshot is null;
update public.proforma_invoices r
set creator_display_name_snapshot = public.profile_display_name(r.created_by)
where r.creator_display_name_snapshot is null;
update public.weight_calculations r
set creator_display_name_snapshot = public.profile_display_name(r.created_by)
where r.creator_display_name_snapshot is null;
update public.business_order_audit_logs r
set actor_display_name_snapshot = coalesce(
  nullif(btrim(r.actor_snapshot ->> 'chinese_name'), ''),
  nullif(btrim(r.actor_snapshot ->> 'full_name'), ''),
  nullif(btrim(r.actor_snapshot ->> 'email'), ''),
  public.profile_display_name(r.actor_id)
)
where r.actor_display_name_snapshot is null;
update public.business_lifecycle_audit_logs r
set actor_display_name_snapshot = coalesce(
  nullif(btrim(r.actor_snapshot ->> 'chinese_name'), ''),
  nullif(btrim(r.actor_snapshot ->> 'full_name'), ''),
  nullif(btrim(r.actor_snapshot ->> 'email'), ''),
  public.profile_display_name(r.actor_id)
)
where r.actor_display_name_snapshot is null;

alter table public.business_orders enable trigger trg_business_orders_touch;
alter table public.finance_orders enable trigger trg_finance_orders_touch;
alter table public.finance_transactions enable trigger trg_finance_transactions_touch;
alter table public.proforma_invoices enable trigger trg_pi_touch;

create or replace function public.freeze_salesperson_display_name_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  if tg_op = 'INSERT' or new.salesperson_id is distinct from old.salesperson_id then
    v_name := public.profile_display_name(new.salesperson_id);
    new.salesperson_display_name_snapshot := coalesce(v_name, new.salesperson_display_name_snapshot);
  elsif new.salesperson_display_name_snapshot is distinct from old.salesperson_display_name_snapshot then
    new.salesperson_display_name_snapshot := old.salesperson_display_name_snapshot;
  end if;
  return new;
end;
$$;
revoke all on function public.freeze_salesperson_display_name_snapshot()
  from public, anon, authenticated, service_role;

create or replace function public.freeze_creator_display_name_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.creator_display_name_snapshot := coalesce(
      public.profile_display_name(new.created_by),
      new.creator_display_name_snapshot
    );
  elsif new.creator_display_name_snapshot is distinct from old.creator_display_name_snapshot then
    new.creator_display_name_snapshot := old.creator_display_name_snapshot;
  end if;
  return new;
end;
$$;
revoke all on function public.freeze_creator_display_name_snapshot()
  from public, anon, authenticated, service_role;

create or replace function public.freeze_actor_display_name_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.actor_display_name_snapshot := coalesce(
    public.profile_display_name(new.actor_id),
    new.actor_display_name_snapshot,
    '系统'
  );
  return new;
end;
$$;
revoke all on function public.freeze_actor_display_name_snapshot()
  from public, anon, authenticated, service_role;

-- 名称以 zz 排在既有 BEFORE 触发器之后，确保覆盖旧函数写入的 full_name。
drop trigger if exists trg_zz_business_orders_display_name on public.business_orders;
create trigger trg_zz_business_orders_display_name
  before insert or update of salesperson_id, salesperson_display_name_snapshot
  on public.business_orders for each row
  execute function public.freeze_salesperson_display_name_snapshot();

drop trigger if exists trg_zz_finance_orders_display_name on public.finance_orders;
create trigger trg_zz_finance_orders_display_name
  before insert or update of salesperson_id, salesperson_display_name_snapshot
  on public.finance_orders for each row
  execute function public.freeze_salesperson_display_name_snapshot();

drop trigger if exists trg_zz_finance_transactions_display_name on public.finance_transactions;
create trigger trg_zz_finance_transactions_display_name
  before insert or update of salesperson_id, salesperson_display_name_snapshot
  on public.finance_transactions for each row
  execute function public.freeze_salesperson_display_name_snapshot();

drop trigger if exists trg_zz_pi_creator_display_name on public.proforma_invoices;
create trigger trg_zz_pi_creator_display_name
  before insert or update of creator_display_name_snapshot
  on public.proforma_invoices for each row
  execute function public.freeze_creator_display_name_snapshot();

drop trigger if exists trg_zz_weight_creator_display_name on public.weight_calculations;
create trigger trg_zz_weight_creator_display_name
  before insert or update of creator_display_name_snapshot
  on public.weight_calculations for each row
  execute function public.freeze_creator_display_name_snapshot();

-- PI 创建人属于历史事实，任何普通 UPDATE（包括管理员）都不得改写。
create or replace function public.protect_pi_creator()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.created_by is distinct from old.created_by then
    raise exception 'PI creator is immutable';
  end if;
  return new;
end;
$$;
revoke all on function public.protect_pi_creator()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_pi_protect_creator on public.proforma_invoices;
create trigger trg_pi_protect_creator
  before update of created_by on public.proforma_invoices for each row
  execute function public.protect_pi_creator();

-- 新建当前业务资产时先与账号停用/交接串行，再复核 JWT 对应账号仍为 approved。
-- 这样已开始但尚未落库的请求，不能在账号停用后继续提交新客户、PI 或订单。
create or replace function public.guard_approved_actor_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
begin
  if v_actor_id is null then
    return new;
  end if;

  if not pg_try_advisory_xact_lock_shared(hashtext('account_handover')::bigint) then
    raise exception 'Account transition is in progress; retry the request';
  end if;
  select * into v_actor
  from public.profiles
  where id = v_actor_id
  for update;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Only approved users can create business records';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_approved_actor_insert()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_customers_guard_approved_insert on public.customers;
create trigger trg_customers_guard_approved_insert
  before insert on public.customers for each row
  execute function public.guard_approved_actor_insert();

drop trigger if exists trg_pi_guard_approved_insert on public.proforma_invoices;
create trigger trg_pi_guard_approved_insert
  before insert on public.proforma_invoices for each row
  execute function public.guard_approved_actor_insert();

drop trigger if exists trg_business_orders_guard_approved_insert on public.business_orders;
create trigger trg_business_orders_guard_approved_insert
  before insert on public.business_orders for each row
  execute function public.guard_approved_actor_insert();

drop trigger if exists trg_zz_business_audit_display_name on public.business_order_audit_logs;
create trigger trg_zz_business_audit_display_name
  before insert on public.business_order_audit_logs for each row
  execute function public.freeze_actor_display_name_snapshot();

drop trigger if exists trg_zz_lifecycle_audit_display_name on public.business_lifecycle_audit_logs;
create trigger trg_zz_lifecycle_audit_display_name
  before insert on public.business_lifecycle_audit_logs for each row
  execute function public.freeze_actor_display_name_snapshot();

-- 管理员仍可直接审批 pending 账号；生命周期和中文名必须由受控 SECURITY DEFINER RPC 改写。
-- 自定义 GUC 只能作为模式标记，必须同时确认当前执行身份确实是受信 RPC 的 owner，避免调用者伪造 GUC 绕过。
create or replace function public.protect_profile_privileged_fields()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_node uuid;
  v_depth int := 0;
  v_target_ok boolean;
  v_rpc_mode text;
  v_trusted_rpc_owner boolean := false;
  v_lifecycle_write boolean := false;
  v_name_write boolean := false;
  v_role_write boolean := false;
  v_hierarchy_cleanup boolean := false;
begin
  v_rpc_mode := current_setting('app.profile_mutation_rpc', true);
  select exists (
    select 1
    from pg_catalog.pg_proc proc
    join pg_catalog.pg_roles owner_role on owner_role.oid = proc.proowner
    where proc.oid in (
      to_regprocedure('public.admin_set_user_role(uuid,text)'),
      to_regprocedure('public.update_profile_chinese_name(uuid,text)'),
      to_regprocedure('public.admin_set_user_disabled(uuid,boolean,text)'),
      to_regprocedure('public.admin_handover_user(uuid,uuid,uuid[],boolean,boolean,text)')
    )
      and owner_role.rolname = current_user
  ) into v_trusted_rpc_owner;
  v_lifecycle_write := v_trusted_rpc_owner and v_rpc_mode = 'lifecycle';
  v_name_write := v_trusted_rpc_owner and v_rpc_mode = 'name';
  v_role_write := v_trusted_rpc_owner and v_rpc_mode = 'role';
  v_hierarchy_cleanup := v_trusted_rpc_owner and v_rpc_mode in ('lifecycle', 'role');

  if new.status is distinct from old.status then
    if v_lifecycle_write then
      null;
    elsif old.status::text = 'pending'
          and new.status::text = 'approved'
          and public.is_admin() then
      null;
    else
      raise exception 'Account status changes must use the lifecycle RPC';
    end if;
  end if;

  if (
    new.disabled_at is distinct from old.disabled_at
    or new.disabled_by is distinct from old.disabled_by
  ) and not v_lifecycle_write then
    raise exception 'Disabled account metadata can only be changed by the lifecycle RPC';
  end if;

  if new.role is distinct from old.role then
    if old.status::text = 'disabled' then
      raise exception 'Disabled accounts must be restored before changing roles';
    end if;
    if not v_role_write then
      raise exception 'Roles must be changed through the protected administrator RPC';
    end if;
  end if;

  if new.chinese_name is distinct from old.chinese_name and not v_name_write then
    raise exception 'Chinese names must be changed through the audited RPC';
  end if;

  if new.supervisor_id is distinct from old.supervisor_id then
    if old.status::text = 'disabled'
       and not (v_hierarchy_cleanup and new.supervisor_id is null) then
      raise exception 'Disabled accounts must be restored before changing the reporting manager';
    end if;
    if (select auth.uid()) is not null and not public.is_admin() then
      raise exception 'Only administrators can change the reporting manager';
    end if;

    if new.supervisor_id is not null then
      if new.supervisor_id = new.id then
        raise exception 'A user cannot be their own manager';
      end if;

      select (p.status::text = 'approved' and p.role::text in ('supervisor', 'admin'))
        into v_target_ok
      from public.profiles p
      where p.id = new.supervisor_id;

      if not coalesce(v_target_ok, false) then
        raise exception 'Manager must be an approved supervisor or administrator';
      end if;

      v_node := new.supervisor_id;
      while v_node is not null and v_depth < 100 loop
        if v_node = new.id then
          raise exception 'Reporting hierarchy cannot contain a cycle';
        end if;
        select supervisor_id into v_node from public.profiles where id = v_node;
        v_depth := v_depth + 1;
      end loop;
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.profile_has_any_reference(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
volatile
as $$
declare
  v_ref record;
  v_has_reference boolean;
begin
  for v_ref in
    select ns.nspname as schema_name, cls.relname as table_name, att.attname as column_name
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class cls on cls.oid = con.conrelid
    join pg_catalog.pg_namespace ns on ns.oid = cls.relnamespace
    join pg_catalog.pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
    join pg_catalog.pg_attribute referenced_att
      on referenced_att.attrelid = con.confrelid and referenced_att.attnum = con.confkey[1]
    where con.contype = 'f'
      and con.confrelid = 'public.profiles'::regclass
      and cardinality(con.conkey) = 1
      and cardinality(con.confkey) = 1
      and referenced_att.attname = 'id'
  loop
    execute format(
      'select exists (select 1 from %I.%I where %I = $1)',
      v_ref.schema_name, v_ref.table_name, v_ref.column_name
    ) into v_has_reference using p_user_id;
    if v_has_reference then return true; end if;
  end loop;
  return false;
end;
$$;
revoke all on function public.profile_has_any_reference(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.protect_profile_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status::text <> 'pending' or public.profile_has_any_reference(old.id) then
    raise exception 'Only an unreferenced pending account can be permanently deleted';
  end if;
  return old;
end;
$$;
revoke all on function public.protect_profile_delete()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_profiles_protect_delete on public.profiles;
create trigger trg_profiles_protect_delete
  before delete on public.profiles for each row
  execute function public.protect_profile_delete();

-- -----------------------------------------------------------------------------
-- 3. 姓名修改、角色/上级、停用/恢复及离职交接 RPC
-- -----------------------------------------------------------------------------

-- 角色修改改走原子 RPC：锁定管理员权限，保护最后一名管理员，并在角色不再可管理下属时清理层级引用。
create or replace function public.admin_set_user_role(
  p_user_id uuid,
  p_role text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_role text := nullif(btrim(p_role), '');
begin
  if p_user_id is null then raise exception 'User ID is required'; end if;
  if v_role is null or v_role not in ('admin', 'finance', 'sales', 'supervisor') then
    raise exception 'Invalid user role';
  end if;
  if p_user_id = (select auth.uid()) then raise exception 'You cannot change your own role'; end if;

  perform pg_advisory_xact_lock(hashtext('account_handover')::bigint);
  perform pg_advisory_xact_lock(hashtext('admin_account_status')::bigint);
  perform pg_advisory_xact_lock(hashtext('profiles_supervisor_hierarchy')::bigint);
  select * into v_actor
  from public.profiles
  where id = (select auth.uid())
  for update;
  if not found or v_actor.status::text <> 'approved' or v_actor.role::text <> 'admin' then
    raise exception 'Only approved administrators can change roles';
  end if;

  select * into v_target from public.profiles where id = p_user_id for update;
  if not found then raise exception 'User does not exist'; end if;
  if v_target.status::text = 'disabled' then
    raise exception 'Disabled accounts must be restored before changing roles';
  end if;
  if v_target.role::text = v_role then return v_target.id; end if;

  if v_target.role::text = 'admin' and v_target.status::text = 'approved'
     and v_role <> 'admin' and not exists (
       select 1 from public.profiles p
       where p.id <> v_target.id
         and p.role::text = 'admin'
         and p.status::text = 'approved'
     ) then
    raise exception 'At least one approved administrator must remain';
  end if;

  perform set_config('app.profile_mutation_rpc', 'role', true);
  if v_target.role::text in ('admin', 'supervisor')
     and v_role not in ('admin', 'supervisor') then
    update public.profiles set supervisor_id = null where supervisor_id = v_target.id;
  end if;

  update public.profiles
  set role = v_role::public.user_role,
      supervisor_id = case
        when v_role in ('admin', 'supervisor', 'sales') then supervisor_id
        else null
      end
  where id = v_target.id;
  return v_target.id;
end;
$$;
revoke all on function public.admin_set_user_role(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_set_user_role(uuid, text) to authenticated;

-- 上级修改同样锁定并复核管理员与目标账号，停用账号必须先恢复。
create or replace function public.set_user_manager(
  p_user_id uuid,
  p_manager_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_user public.profiles%rowtype;
  v_updated uuid;
begin
  if p_user_id is null then raise exception 'User ID is required'; end if;
  if p_manager_id is not null and p_manager_id = p_user_id then
    raise exception 'A user cannot be their own manager';
  end if;

  perform pg_advisory_xact_lock(hashtext('profiles_supervisor_hierarchy')::bigint);
  select * into v_actor
  from public.profiles
  where id = (select auth.uid())
  for update;
  if not found or v_actor.status::text <> 'approved' or v_actor.role::text <> 'admin' then
    raise exception 'Only approved administrators can change the reporting manager';
  end if;

  select * into v_user from public.profiles where id = p_user_id for update;
  if not found then raise exception 'User does not exist'; end if;
  if v_user.status::text = 'disabled' then
    raise exception 'Disabled accounts must be restored before changing the reporting manager';
  end if;
  if v_user.role::text not in ('sales', 'supervisor', 'admin') then
    raise exception 'Only sales, supervisor, or admin users can have a manager';
  end if;

  update public.profiles
  set supervisor_id = p_manager_id
  where id = p_user_id
  returning id into v_updated;
  return v_updated;
end;
$$;
revoke all on function public.set_user_manager(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.set_user_manager(uuid, uuid) to authenticated;

create or replace function public.update_profile_chinese_name(
  p_user_id uuid,
  p_chinese_name text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_chinese_name text := nullif(btrim(p_chinese_name), '');
  v_old_display text;
  v_new_display text;
begin
  if p_user_id is null then raise exception 'User ID is required'; end if;
  if v_chinese_name is not null and char_length(v_chinese_name) > 50 then
    raise exception 'Chinese name cannot exceed 50 characters';
  end if;

  -- 与角色、上级、停用及交接共用层级锁，确保所有多 profile 写入都在锁行前串行化。
  perform pg_advisory_xact_lock(hashtext('profiles_supervisor_hierarchy')::bigint);
  select * into v_actor
  from public.profiles
  where id = (select auth.uid())
  for update;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Only approved finance users or administrators can change Chinese names';
  end if;

  select * into v_target from public.profiles where id = p_user_id for update;
  if not found then raise exception 'User does not exist'; end if;

  v_old_display := coalesce(
    nullif(btrim(v_target.chinese_name), ''),
    nullif(btrim(v_target.full_name), ''),
    nullif(btrim(v_target.email), '')
  );

  if v_target.chinese_name is not distinct from v_chinese_name then return v_target.id; end if;

  perform set_config('app.profile_mutation_rpc', 'name', true);
  update public.profiles set chinese_name = v_chinese_name where id = p_user_id;
  v_new_display := coalesce(
    v_chinese_name,
    nullif(btrim(v_target.full_name), ''),
    nullif(btrim(v_target.email), '')
  );

  insert into public.account_lifecycle_audit_logs(
    action, source_user_id, source_name_snapshot, actor_id, actor_name_snapshot,
    detail
  ) values (
    'name_change', v_target.id, v_old_display, v_actor.id,
    coalesce(public.profile_display_name(v_actor.id), '系统'),
    jsonb_build_object(
      'old_chinese_name', v_target.chinese_name,
      'new_chinese_name', v_chinese_name,
      'old_display_name', v_old_display,
      'new_display_name', v_new_display
    )
  );

  return v_target.id;
end;
$$;
revoke all on function public.update_profile_chinese_name(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.update_profile_chinese_name(uuid, text) to authenticated;

create or replace function public.admin_set_user_disabled(
  p_user_id uuid,
  p_disabled boolean,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_reason text := nullif(btrim(p_reason), '');
  v_action text;
  v_cleared_subordinate_count int := 0;
begin
  if not public.is_admin() then raise exception 'Only administrators can change account status'; end if;
  if p_user_id is null then raise exception 'User ID is required'; end if;
  if p_disabled is null then raise exception 'Disabled flag is required'; end if;
  if p_user_id = (select auth.uid()) and p_disabled then raise exception 'You cannot disable your own account'; end if;
  if p_disabled and v_reason is null then raise exception 'A reason is required to disable an account'; end if;
  if char_length(coalesce(v_reason, '')) > 1000 then raise exception 'Reason is too long'; end if;

  -- 与业务写入及离职交接共用锁，避免停用后仍有使用旧权限启动的事务落库。
  -- 锁顺序固定为 account_handover -> admin_account_status -> hierarchy -> profile。
  perform pg_advisory_xact_lock(hashtext('account_handover')::bigint);
  perform pg_advisory_xact_lock(hashtext('admin_account_status')::bigint);
  perform pg_advisory_xact_lock(hashtext('profiles_supervisor_hierarchy')::bigint);
  select * into v_actor
  from public.profiles
  where id = (select auth.uid())
  for update;
  if not found or v_actor.status::text <> 'approved' or v_actor.role::text <> 'admin' then
    raise exception 'Administrator permission was revoked while waiting for the account lock';
  end if;
  select * into v_target from public.profiles where id = p_user_id for update;
  if not found then raise exception 'User does not exist'; end if;

  if p_disabled and v_target.status::text <> 'approved' then
    raise exception 'Only approved accounts can be disabled';
  end if;
  if not p_disabled and v_target.status::text <> 'disabled' then
    raise exception 'Only disabled accounts can be restored';
  end if;

  if p_disabled and v_target.role::text = 'admin' and not exists (
    select 1 from public.profiles p
    where p.id <> v_target.id and p.role::text = 'admin' and p.status::text = 'approved'
  ) then
    raise exception 'At least one approved administrator must remain';
  end if;

  perform set_config('app.profile_mutation_rpc', 'lifecycle', true);
  if p_disabled then
    update public.profiles
    set supervisor_id = null
    where supervisor_id = v_target.id;
    get diagnostics v_cleared_subordinate_count = row_count;
  end if;

  if p_disabled then
    update public.profiles
    set status = 'disabled', disabled_at = now(), disabled_by = v_actor.id,
        supervisor_id = null
    where id = v_target.id;
    v_action := 'disable';
  else
    update public.profiles
    set status = 'approved', disabled_at = null, disabled_by = null
    where id = v_target.id;
    v_action := 'restore';
  end if;

  insert into public.account_lifecycle_audit_logs(
    action, source_user_id, source_name_snapshot, actor_id, actor_name_snapshot,
    reason, detail
  ) values (
    v_action, v_target.id,
    coalesce(public.profile_display_name(v_target.id), v_target.email),
    v_actor.id, coalesce(public.profile_display_name(v_actor.id), '系统'),
    v_reason,
    jsonb_build_object(
      'old_status', v_target.status::text,
      'new_status', case when p_disabled then 'disabled' else 'approved' end,
      'cleared_subordinate_count', v_cleared_subordinate_count
    )
  );

  return v_target.id;
end;
$$;
revoke all on function public.admin_set_user_disabled(uuid, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_set_user_disabled(uuid, boolean, text) to authenticated;

-- 永久删除只用于从未产生任何引用的 pending 误建账号；离职账号必须走停用或交接。
create or replace function public.admin_can_delete_pending_user(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
volatile
as $$
declare
  v_status text;
begin
  if not public.is_admin() then raise exception 'Only administrators can inspect account deletion'; end if;
  select status::text into v_status from public.profiles where id = p_user_id;
  return v_status = 'pending' and not public.profile_has_any_reference(p_user_id);
end;
$$;
revoke all on function public.admin_can_delete_pending_user(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_can_delete_pending_user(uuid) to authenticated;

create or replace function public.admin_handover_user(
  p_from_user_id uuid,
  p_to_user_id uuid,
  p_customer_ids uuid[],
  p_transfer_open_orders boolean,
  p_disable_source boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_source public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_reason text := nullif(btrim(p_reason), '');
  v_requested_count int := 0;
  v_customer_count int := 0;
  v_business_count int := 0;
  v_shop_count int := 0;
  v_cleared_subordinate_count int := 0;
  v_customer_ids uuid[] := '{}'::uuid[];
  v_business_ids uuid[] := '{}'::uuid[];
  v_shop_ids uuid[] := '{}'::uuid[];
begin
  if not public.is_admin() then raise exception 'Only administrators can hand over accounts'; end if;
  if p_from_user_id is null or p_to_user_id is null then raise exception 'Source and target users are required'; end if;
  if p_transfer_open_orders is null or p_disable_source is null then
    raise exception 'Transfer and disable flags are required';
  end if;
  if p_from_user_id = p_to_user_id then raise exception 'Source and target users must be different'; end if;
  if v_reason is null then raise exception 'A handover reason is required'; end if;
  if char_length(v_reason) > 1000 then raise exception 'Reason is too long'; end if;

  perform pg_advisory_xact_lock(hashtext('account_handover')::bigint);
  perform pg_advisory_xact_lock(hashtext('admin_account_status')::bigint);
  perform pg_advisory_xact_lock(hashtext('profiles_supervisor_hierarchy')::bigint);

  select * into v_actor
  from public.profiles
  where id = (select auth.uid())
  for update;
  if not found or v_actor.status::text <> 'approved' or v_actor.role::text <> 'admin' then
    raise exception 'Administrator permission was revoked while waiting for the handover lock';
  end if;

  select * into v_source from public.profiles where id = p_from_user_id for update;
  if not found then raise exception 'Source user does not exist'; end if;
  if v_source.status::text not in ('approved', 'disabled') then
    raise exception 'Pending accounts cannot be handed over';
  end if;

  select * into v_target from public.profiles where id = p_to_user_id for update;
  if not found or v_target.status::text <> 'approved' or v_target.role::text = 'finance' then
    raise exception 'Target user must be an approved non-finance user';
  end if;
  if p_disable_source and p_from_user_id = v_actor.id then
    raise exception 'You cannot disable your own account';
  end if;
  if p_disable_source and v_source.role::text = 'admin' and v_source.status::text = 'approved' and not exists (
    select 1 from public.profiles p
    where p.id <> v_source.id and p.role::text = 'admin' and p.status::text = 'approved'
  ) then
    raise exception 'At least one approved administrator must remain';
  end if;

  if p_customer_ids is null then
    perform 1 from public.customers c where c.created_by = v_source.id for update;
    select coalesce(array_agg(c.id order by c.id), '{}'::uuid[]) into v_customer_ids
    from public.customers c where c.created_by = v_source.id;
  elsif cardinality(p_customer_ids) > 0 then
    select count(*) into v_requested_count from (select distinct unnest(p_customer_ids)) requested;
    perform 1 from public.customers c where c.id = any(p_customer_ids) for update;
    select coalesce(array_agg(c.id order by c.id), '{}'::uuid[]) into v_customer_ids
    from public.customers c
    where c.id = any(p_customer_ids) and c.created_by = v_source.id;
    if cardinality(v_customer_ids) <> v_requested_count then
      raise exception 'One or more customers do not belong to the source user';
    end if;
  end if;

  perform set_config('app.customer_owner_rpc', 'transfer', true);
  update public.customers
  set created_by = v_target.id
  where id = any(v_customer_ids);
  get diagnostics v_customer_count = row_count;

  if p_transfer_open_orders then
    -- 订单只随本次实际交接的客户一起转移。管理员可能曾为其他业务员的客户
    -- 代建订单，不能把这类订单交给无该客户权限的普通接手人。
    with updated as (
      update public.business_orders bo
      set salesperson_id = v_target.id,
          salesperson_display_name_snapshot = public.profile_display_name(v_target.id),
          version = bo.version + 1
      where bo.salesperson_id = v_source.id
        and bo.customer_id = any(v_customer_ids)
        and bo.status::text <> 'completed'
        and bo.closed_at is null
      returning bo.id
    )
    select coalesce(array_agg(id order by id), '{}'::uuid[]), count(*)::int
      into v_business_ids, v_business_count
    from updated;
  end if;

  with changed as (
    insert into public.finance_daily_order_shop_salespeople(
      shop_id, salesperson_id, is_active, created_by
    )
    select a.shop_id, v_target.id, true, v_actor.id
    from public.finance_daily_order_shop_salespeople a
    where a.salesperson_id = v_source.id and a.is_active = true
    on conflict (shop_id, salesperson_id) do update set is_active = true
    returning shop_id
  )
  select coalesce(array_agg(shop_id order by shop_id), '{}'::uuid[]), count(*)::int
    into v_shop_ids, v_shop_count
  from changed;

  if p_disable_source then
    update public.finance_daily_order_shop_salespeople
    set is_active = false
    where salesperson_id = v_source.id;

    perform set_config('app.profile_mutation_rpc', 'lifecycle', true);
    update public.profiles
    set supervisor_id = null
    where supervisor_id = v_source.id;
    get diagnostics v_cleared_subordinate_count = row_count;

    update public.profiles
    set status = 'disabled', disabled_at = now(), disabled_by = v_actor.id,
        supervisor_id = null
    where id = v_source.id;
  end if;

  insert into public.account_lifecycle_audit_logs(
    action, source_user_id, target_user_id,
    source_name_snapshot, target_name_snapshot,
    actor_id, actor_name_snapshot, reason, detail
  ) values (
    'handover', v_source.id, v_target.id,
    coalesce(public.profile_display_name(v_source.id), v_source.email),
    coalesce(public.profile_display_name(v_target.id), v_target.email),
    v_actor.id, coalesce(public.profile_display_name(v_actor.id), '系统'),
    v_reason,
    jsonb_build_object(
      'customer_count', v_customer_count,
      'customer_ids', to_jsonb(v_customer_ids),
      'business_order_count', v_business_count,
      'business_order_ids', to_jsonb(v_business_ids),
      'shop_assignment_count', v_shop_count,
      'shop_ids', to_jsonb(v_shop_ids),
      'source_disabled', p_disable_source,
      'cleared_subordinate_count', v_cleared_subordinate_count
    )
  );

  return jsonb_build_object(
    'customer_count', v_customer_count,
    'business_order_count', v_business_count,
    'shop_assignment_count', v_shop_count,
    'source_disabled', p_disable_source
  );
end;
$$;
revoke all on function public.admin_handover_user(uuid, uuid, uuid[], boolean, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_handover_user(uuid, uuid, uuid[], boolean, boolean, text)
  to authenticated;

-- 客户负责人只能由受控交接 RPC 修改。GUC 只是模式标记，还必须核对当前执行身份
-- 是否为受信 SECURITY DEFINER 函数的 owner，避免 authenticated 伪造 GUC 绕过。
create or replace function public.protect_customer_owner_change()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_rpc_mode text := current_setting('app.customer_owner_rpc', true);
  v_trusted_rpc_owner boolean := false;
begin
  if new.created_by is distinct from old.created_by then
    select exists (
      select 1
      from pg_catalog.pg_proc proc
      join pg_catalog.pg_roles owner_role on owner_role.oid = proc.proowner
      where proc.oid in (
        to_regprocedure('public.admin_handover_user(uuid,uuid,uuid[],boolean,boolean,text)'),
        to_regprocedure('public.transfer_customers(uuid[],uuid,text,text,text)')
      )
        and owner_role.rolname = current_user
    ) into v_trusted_rpc_owner;

    if not (v_trusted_rpc_owner and v_rpc_mode = 'transfer') then
      raise exception 'Customer ownership changes must use the protected transfer RPC';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.protect_customer_owner_change()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_customers_protect_owner_change on public.customers;
create trigger trg_customers_protect_owner_change
  before update of created_by on public.customers for each row
  execute function public.protect_customer_owner_change();

-- 客户负责人变更后留下不可变审计记录。
create or replace function public.audit_customer_owner_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := (select auth.uid());
begin
  if new.created_by is distinct from old.created_by then
    insert into public.account_lifecycle_audit_logs(
      action, source_user_id, target_user_id,
      source_name_snapshot, target_name_snapshot,
      actor_id, actor_name_snapshot, detail
    ) values (
      'customer_transfer', old.created_by, new.created_by,
      public.profile_display_name(old.created_by),
      public.profile_display_name(new.created_by),
      v_actor_id, coalesce(public.profile_display_name(v_actor_id), '系统'),
      jsonb_build_object('customer_id', new.id, 'customer_name', new.name)
    );
  end if;
  return new;
end;
$$;
revoke all on function public.audit_customer_owner_change()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_customers_audit_owner_change on public.customers;
create trigger trg_customers_audit_owner_change
  after update of created_by on public.customers for each row
  execute function public.audit_customer_owner_change();

-- 单个和批量客户转移共用此原子 RPC。非管理员只能转移自己当前拥有的客户；
-- 所有客户与目标账号先完整校验并锁定，任何一个无权或不存在都会整批失败。
create or replace function public.transfer_customers(
  p_customer_ids uuid[],
  p_target_user_id uuid,
  p_country text default null,
  p_company text default null,
  p_contact_person text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_customer_ids uuid[] := '{}'::uuid[];
  v_customer_count int := 0;
begin
  if p_customer_ids is null or cardinality(p_customer_ids) = 0 then
    raise exception 'At least one customer is required';
  end if;
  if p_target_user_id is null then
    raise exception 'Target user is required';
  end if;
  if exists (select 1 from unnest(p_customer_ids) requested(id) where requested.id is null) then
    raise exception 'Customer IDs cannot contain null values';
  end if;

  perform pg_advisory_xact_lock(hashtext('account_handover')::bigint);

  select * into v_actor
  from public.profiles
  where id = (select auth.uid())
  for update;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Only approved users can transfer customers';
  end if;

  select * into v_target
  from public.profiles
  where id = p_target_user_id
  for update;
  if not found or v_target.status::text <> 'approved' or v_target.role::text = 'finance' then
    raise exception 'Target user must be an approved non-finance user';
  end if;

  select coalesce(array_agg(requested.id order by requested.id), '{}'::uuid[])
    into v_customer_ids
  from (
    select distinct requested.requested_id as id
    from unnest(p_customer_ids) as requested(requested_id)
  ) requested;

  perform c.id
  from public.customers c
  where c.id = any(v_customer_ids)
  order by c.id
  for update;

  select count(*)::int into v_customer_count
  from public.customers c
  where c.id = any(v_customer_ids)
    and (v_actor.role::text = 'admin' or c.created_by = v_actor.id);

  if v_customer_count <> cardinality(v_customer_ids) then
    raise exception 'One or more customers do not exist or cannot be transferred by the current user';
  end if;

  perform set_config('app.customer_owner_rpc', 'transfer', true);
  update public.customers c
  set created_by = v_target.id,
      country = coalesce(p_country, c.country),
      company = coalesce(p_company, c.company),
      contact_person = coalesce(p_contact_person, c.contact_person)
  where c.id = any(v_customer_ids);

  return v_customer_count;
end;
$$;
revoke all on function public.transfer_customers(uuid[], uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.transfer_customers(uuid[], uuid, text, text, text)
  to authenticated;

-- 复制只复制客户当前资料，不复制 PI、订单或其他历史事实。
create or replace function public.copy_customers(
  p_customer_ids uuid[],
  p_target_user_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_customer public.customers%rowtype;
  v_copied_customer_id uuid;
  v_customer_ids uuid[] := '{}'::uuid[];
  v_customer_count int := 0;
begin
  if p_customer_ids is null or cardinality(p_customer_ids) = 0 then
    raise exception 'At least one customer is required';
  end if;
  if p_target_user_id is null then
    raise exception 'Target user is required';
  end if;
  if exists (select 1 from unnest(p_customer_ids) requested(id) where requested.id is null) then
    raise exception 'Customer IDs cannot contain null values';
  end if;

  perform pg_advisory_xact_lock(hashtext('account_handover')::bigint);

  select * into v_actor
  from public.profiles
  where id = (select auth.uid())
  for update;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Only approved users can copy customers';
  end if;

  select * into v_target
  from public.profiles
  where id = p_target_user_id
  for update;
  if not found or v_target.status::text <> 'approved' or v_target.role::text = 'finance' then
    raise exception 'Target user must be an approved non-finance user';
  end if;

  select coalesce(array_agg(requested.id order by requested.id), '{}'::uuid[])
    into v_customer_ids
  from (
    select distinct requested.requested_id as id
    from unnest(p_customer_ids) as requested(requested_id)
  ) requested;

  perform c.id
  from public.customers c
  where c.id = any(v_customer_ids)
  order by c.id
  for share;

  select count(*)::int into v_customer_count
  from public.customers c
  where c.id = any(v_customer_ids)
    and (v_actor.role::text = 'admin' or c.created_by = v_actor.id);

  if v_customer_count <> cardinality(v_customer_ids) then
    raise exception 'One or more customers do not exist or cannot be copied by the current user';
  end if;

  -- 每个副本单独记录真实原负责人。管理员可跨负责人批量复制，不能把不可变
  -- 审计中的 source_user_id 错记为执行管理员。
  for v_customer in
    select c.*
    from public.customers c
    where c.id = any(v_customer_ids)
    order by c.id
  loop
    insert into public.customers(
      name, company, email, phone, address, city, state, postal_code,
      country, contact_person, group_id, created_by
    ) values (
      v_customer.name, v_customer.company, v_customer.email, v_customer.phone,
      v_customer.address, v_customer.city, v_customer.state, v_customer.postal_code,
      v_customer.country, v_customer.contact_person, v_customer.group_id, v_target.id
    )
    returning id into v_copied_customer_id;

    insert into public.account_lifecycle_audit_logs(
      action, source_user_id, target_user_id,
      source_name_snapshot, target_name_snapshot,
      actor_id, actor_name_snapshot, detail
    ) values (
      'customer_copy', v_customer.created_by, v_target.id,
      public.profile_display_name(v_customer.created_by),
      coalesce(public.profile_display_name(v_target.id), v_target.email),
      v_actor.id, coalesce(public.profile_display_name(v_actor.id), '系统'),
      jsonb_build_object(
        'source_customer_id', v_customer.id,
        'copied_customer_id', v_copied_customer_id,
        'customer_name', v_customer.name
      )
    );
  end loop;

  return v_customer_count;
end;
$$;
revoke all on function public.copy_customers(uuid[], uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.copy_customers(uuid[], uuid)
  to authenticated;

-- -----------------------------------------------------------------------------
-- 4. 新负责人可读取客户的历史资料，但历史创建人/业务员不改写。
-- -----------------------------------------------------------------------------

create or replace function public.can_view_pi(p_pi_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.proforma_invoices pi
    join public.profiles me on me.id = (select auth.uid())
    left join public.customers c on c.id = pi.customer_id
    where pi.id = p_pi_id
      and me.status::text = 'approved'
      and (
        me.role::text in ('admin', 'finance')
        or pi.created_by = me.id
        or c.created_by = me.id
        or public.is_my_subordinate(pi.created_by)
        or public.is_my_subordinate(c.created_by)
      )
  );
$$;
revoke all on function public.can_view_pi(uuid) from public, anon, authenticated, service_role;
grant execute on function public.can_view_pi(uuid) to authenticated;

create or replace function public.can_manage_pi(p_pi_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.proforma_invoices pi
    join public.profiles me on me.id = (select auth.uid())
    where pi.id = p_pi_id
      and me.status::text = 'approved'
      and (
        me.role::text = 'admin'
        or pi.created_by = me.id
      )
  );
$$;
revoke all on function public.can_manage_pi(uuid) from public, anon, authenticated, service_role;
grant execute on function public.can_manage_pi(uuid) to authenticated;

-- 普通表写入只能创建自己的客户、修改自己客户资料（管理员可修改任意资料）。
-- 跨负责人转移与复制必须调用上方受控 RPC；保护触发器会阻止直接修改 created_by。

drop policy if exists "profiles_select_all" on public.profiles;
create policy "profiles_select_all" on public.profiles
  for select to authenticated using (
    id = (select auth.uid()) or public.is_approved_user()
  );

drop policy if exists "customers_select_own" on public.customers;
create policy "customers_select_own" on public.customers
  for select to authenticated using (
    public.is_approved_user()
    and (
      created_by = (select auth.uid())
      or public.is_admin()
      or public.is_my_subordinate(created_by)
    )
  );
drop policy if exists "customers_insert" on public.customers;
create policy "customers_insert" on public.customers
  for insert to authenticated with check (
    public.is_approved_user() and created_by = (select auth.uid())
  );
drop policy if exists "customers_update" on public.customers;
create policy "customers_update" on public.customers
  for update to authenticated using (
    public.is_approved_user() and (created_by = (select auth.uid()) or public.is_admin())
  ) with check (
    public.is_approved_user() and (created_by = (select auth.uid()) or public.is_admin())
  );
drop policy if exists "customers_delete" on public.customers;
create policy "customers_delete" on public.customers
  for delete to authenticated using (
    public.is_approved_user() and (created_by = (select auth.uid()) or public.is_admin())
  );

drop policy if exists "pi_select_own" on public.proforma_invoices;
create policy "pi_select_own" on public.proforma_invoices
  for select to authenticated using (public.can_view_pi(id));
drop policy if exists "pi_insert" on public.proforma_invoices;
create policy "pi_insert" on public.proforma_invoices
  for insert to authenticated with check (
    public.is_approved_user() and created_by = (select auth.uid())
  );
drop policy if exists "pi_update" on public.proforma_invoices;
create policy "pi_update" on public.proforma_invoices
  for update to authenticated using (public.can_manage_pi(id))
  with check (public.can_manage_pi(id));
drop policy if exists "pi_delete" on public.proforma_invoices;
create policy "pi_delete" on public.proforma_invoices
  for delete to authenticated using (public.can_manage_pi(id));

drop policy if exists "pi_items_select_own" on public.pi_items;
create policy "pi_items_select_own" on public.pi_items
  for select to authenticated using (public.can_view_pi(pi_id));
drop policy if exists "pi_items_write" on public.pi_items;
create policy "pi_items_write" on public.pi_items
  for all to authenticated using (public.can_manage_pi(pi_id))
  with check (public.can_manage_pi(pi_id));

create or replace function public.can_view_business_order(p_order_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.business_orders bo
    join public.profiles me on me.id = (select auth.uid())
    left join public.customers c on c.id = bo.customer_id
    where bo.id = p_order_id
      and me.status::text = 'approved'
      and (
        me.role::text in ('admin', 'finance')
        or bo.salesperson_id = me.id
        or public.is_my_subordinate(bo.salesperson_id)
        or c.created_by = me.id
        or public.is_my_subordinate(c.created_by)
      )
  );
$$;
revoke all on function public.can_view_business_order(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.can_view_business_order(uuid) to authenticated;

drop policy if exists "daily_order_workflows_select" on public.finance_daily_order_workflows;
create policy "daily_order_workflows_select" on public.finance_daily_order_workflows
  for select to authenticated using (
    public.is_approved_user()
    and (
      public.is_finance_or_admin()
      or salesperson_id = (select auth.uid())
      or public.is_my_subordinate(salesperson_id)
      or exists (
        select 1 from public.customers c
        where c.id = finance_daily_order_workflows.customer_id
          and (
            c.created_by = (select auth.uid())
            or public.is_my_subordinate(c.created_by)
          )
      )
    )
  );

drop policy if exists "daily_orders_select" on public.finance_daily_orders;
create policy "daily_orders_select" on public.finance_daily_orders
  for select to authenticated using (
    public.is_approved_user()
    and (
      public.is_finance_or_admin()
      or salesperson_id = (select auth.uid())
      or public.is_my_subordinate(salesperson_id)
      or exists (
        select 1
        from public.finance_daily_order_workflows wf
        join public.customers c on c.id = wf.customer_id
        where wf.id = finance_daily_orders.workflow_id
          and (
            c.created_by = (select auth.uid())
            or public.is_my_subordinate(c.created_by)
          )
      )
    )
  );

-- -----------------------------------------------------------------------------
-- 5. 停用账号只可读取自己的 profile 状态，不能继续通过旧宽松策略读写业务数据。
-- -----------------------------------------------------------------------------

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()) and public.is_approved_user())
  with check (id = (select auth.uid()) and public.is_approved_user());

drop policy if exists "company_select_all" on public.company_settings;
create policy "company_select_all" on public.company_settings
  for select to authenticated using (public.is_approved_user());

drop policy if exists "products_select_all" on public.products;
create policy "products_select_all" on public.products
  for select to authenticated using (public.is_approved_user());
drop policy if exists "products_insert" on public.products;
create policy "products_insert" on public.products
  for insert to authenticated with check (public.is_approved_user());
drop policy if exists "products_update" on public.products;
create policy "products_update" on public.products
  for update to authenticated using (public.is_approved_user())
  with check (public.is_approved_user());

drop policy if exists "groups_select_all" on public.customer_groups;
create policy "groups_select_all" on public.customer_groups
  for select to authenticated using (public.is_approved_user());
drop policy if exists "groups_write" on public.customer_groups;
create policy "groups_write" on public.customer_groups
  for all to authenticated using (public.is_approved_user())
  with check (public.is_approved_user());

drop policy if exists "product_groups_select_all" on public.product_groups;
create policy "product_groups_select_all" on public.product_groups
  for select to authenticated using (public.is_approved_user());
drop policy if exists "product_groups_write" on public.product_groups;
create policy "product_groups_write" on public.product_groups
  for all to authenticated using (public.is_approved_user())
  with check (public.is_approved_user());

drop policy if exists pi_favorites_select_own on public.pi_favorites;
create policy pi_favorites_select_own on public.pi_favorites
  for select to authenticated
  using (public.is_approved_user() and user_id = (select auth.uid()));
drop policy if exists pi_favorites_insert_own on public.pi_favorites;
create policy pi_favorites_insert_own on public.pi_favorites
  for insert to authenticated
  with check (public.is_approved_user() and user_id = (select auth.uid()));
drop policy if exists pi_favorites_delete_own on public.pi_favorites;
create policy pi_favorites_delete_own on public.pi_favorites
  for delete to authenticated
  using (public.is_approved_user() and user_id = (select auth.uid()));

drop policy if exists "company_profiles_select_own" on public.company_profiles;
create policy "company_profiles_select_own" on public.company_profiles
  for select to authenticated
  using (public.is_approved_user() and created_by = (select auth.uid()));
drop policy if exists "company_profiles_insert_own" on public.company_profiles;
create policy "company_profiles_insert_own" on public.company_profiles
  for insert to authenticated
  with check (public.is_approved_user() and created_by = (select auth.uid()));
drop policy if exists "company_profiles_update_own" on public.company_profiles;
create policy "company_profiles_update_own" on public.company_profiles
  for update to authenticated
  using (public.is_approved_user() and created_by = (select auth.uid()))
  with check (public.is_approved_user() and created_by = (select auth.uid()));
drop policy if exists "company_profiles_delete_own" on public.company_profiles;
create policy "company_profiles_delete_own" on public.company_profiles
  for delete to authenticated
  using (public.is_approved_user() and created_by = (select auth.uid()));

drop policy if exists "wc_select_own" on public.weight_calculations;
create policy "wc_select_own" on public.weight_calculations
  for select to authenticated using (
    public.is_approved_user()
    and (created_by = (select auth.uid()) or public.is_admin())
  );
drop policy if exists "wc_insert" on public.weight_calculations;
create policy "wc_insert" on public.weight_calculations
  for insert to authenticated
  with check (public.is_approved_user() and created_by = (select auth.uid()));
drop policy if exists "wc_update" on public.weight_calculations;
create policy "wc_update" on public.weight_calculations
  for update to authenticated using (
    public.is_approved_user()
    and (created_by = (select auth.uid()) or public.is_admin())
  ) with check (
    public.is_approved_user()
    and (created_by = (select auth.uid()) or public.is_admin())
  );
drop policy if exists "wc_delete" on public.weight_calculations;
create policy "wc_delete" on public.weight_calculations
  for delete to authenticated using (
    public.is_approved_user()
    and (created_by = (select auth.uid()) or public.is_admin())
  );
drop policy if exists "wc_items_select_own" on public.weight_calc_items;
create policy "wc_items_select_own" on public.weight_calc_items
  for select to authenticated using (
    public.is_approved_user()
    and exists (
      select 1 from public.weight_calculations wc
      where wc.id = weight_calc_items.calc_id
        and (wc.created_by = (select auth.uid()) or public.is_admin())
    )
  );
drop policy if exists "wc_items_write" on public.weight_calc_items;
create policy "wc_items_write" on public.weight_calc_items
  for all to authenticated using (
    public.is_approved_user()
    and exists (
      select 1 from public.weight_calculations wc
      where wc.id = weight_calc_items.calc_id
        and (wc.created_by = (select auth.uid()) or public.is_admin())
    )
  ) with check (
    public.is_approved_user()
    and exists (
      select 1 from public.weight_calculations wc
      where wc.id = weight_calc_items.calc_id
        and (wc.created_by = (select auth.uid()) or public.is_admin())
    )
  );

drop policy if exists "daily_order_change_requests_select" on public.finance_daily_order_change_requests;
create policy "daily_order_change_requests_select" on public.finance_daily_order_change_requests
  for select to authenticated using (
    public.is_approved_user()
    and (
      public.is_finance_or_admin()
      or requested_by = (select auth.uid())
      or public.is_my_subordinate(requested_by)
    )
  );

drop policy if exists "daily_order_screenshots_select" on public.finance_daily_order_screenshots;
create policy "daily_order_screenshots_select" on public.finance_daily_order_screenshots
  for select to authenticated using (
    public.is_approved_user()
    and exists (
      select 1 from public.finance_daily_orders o
      where o.id = finance_daily_order_screenshots.order_id
    )
  );

-- Storage 读取策略同样校验 approved，避免停用账号凭旧 JWT 继续读取截图对象。
drop policy if exists "finance_daily_order_screenshots_select" on storage.objects;
create policy "finance_daily_order_screenshots_select" on storage.objects for select to authenticated
using (
  bucket_id = 'finance-daily-order-screenshots'
  and public.is_approved_user()
  and array_length(storage.foldername(name), 1) = 2
  and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$'
  and exists (
    select 1
    from public.finance_daily_orders o
    where o.id = ((storage.foldername(name))[2])::uuid
  )
);

-- finance_daily_orders 的 SELECT RLS 已统一覆盖财务/管理员、原业务、主管及客户当前负责人，
-- 因而截图对象权限与截图元数据和订单可见性保持一致。
-- 私有文件写入同样要求账号仍为 approved。公开产品图保留公开读取。
drop policy if exists "product_images_write" on storage.objects;
create policy "product_images_write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-images' and public.is_approved_user());
-- PI PDF 仅由服务端 Admin Client 生成短时签名链接；authenticated 不再直接列举、读写整个私有桶。
drop policy if exists "pi_pdfs_rw" on storage.objects;
drop policy if exists "company_assets_write" on storage.objects;
create policy "company_assets_write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'company-assets' and public.is_approved_user());
drop policy if exists "company_assets_update" on storage.objects;
create policy "company_assets_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'company-assets' and public.is_approved_user())
  with check (bucket_id = 'company-assets' and public.is_approved_user());

-- -----------------------------------------------------------------------------
-- 6. 第三轮安全收口：并发停用、客户交接和历史财务记录
-- -----------------------------------------------------------------------------

-- 所有业务表写语句必须取得账号交接共享锁并重新锁定、读取当前账号状态。
-- 旧 RPC 可能在 DML 前已锁业务行，因此使用 try-shared：交接持有独占锁时立即失败回滚，避免反向锁序死锁。
create or replace function public.guard_approved_actor_statement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
begin
  if v_actor_id is null then
    return null;
  end if;

  if not pg_try_advisory_xact_lock_shared(hashtext('account_handover')::bigint) then
    raise exception 'Account transition is in progress; retry the request';
  end if;
  select * into v_actor
  from public.profiles
  where id = v_actor_id
  for update;

  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Only approved users can modify business records';
  end if;
  return null;
end;
$$;
revoke all on function public.guard_approved_actor_statement()
  from public, anon, authenticated, service_role;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'company_settings', 'products', 'product_groups', 'customer_groups', 'customers',
    'proforma_invoices', 'pi_items', 'pi_favorites', 'company_profiles',
    'weight_calculations', 'weight_calc_items', 'product_financials',
    'finance_orders', 'finance_transactions', 'finance_order_costs',
    'finance_daily_order_shops', 'finance_daily_order_shop_groups',
    'finance_daily_order_shop_salespeople', 'business_orders', 'business_order_items',
    'business_order_payments', 'business_order_finance_details',
    'business_custom_products', 'business_custom_product_versions',
    'business_customer_transfers', 'business_order_payment_allocations',
    'business_rpc_idempotency', 'business_order_shipments',
    'business_order_shipment_items', 'business_order_returns',
    'business_order_return_items'
  ]
  loop
    if to_regclass(format('public.%I', v_table)) is not null then
      execute format('drop trigger if exists trg_000_guard_approved_write on public.%I', v_table);
      execute format(
        'create trigger trg_000_guard_approved_write before insert or update or delete on public.%I for each statement execute function public.guard_approved_actor_statement()',
        v_table
      );
    end if;
  end loop;
end;
$$;

-- 客户交接锁释放后，使用锁定重读得到的当前负责人重新校验关联资产。
-- 这阻断了旧负责人先读取客户、管理员随后完成交接、旧请求最后才落单的竞态。
create or replace function public.guard_current_customer_assignment_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_customer_owner uuid;
begin
  if v_actor_id is null then
    return new;
  end if;

  select * into v_actor
  from public.profiles
  where id = v_actor_id
  for update;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Only approved users can create customer assets';
  end if;

  select created_by into v_customer_owner
  from public.customers
  where id = new.customer_id
  for share;
  if not found then
    raise exception 'Customer does not exist';
  end if;

  if tg_table_name = 'business_orders' then
    if v_actor.role::text not in ('sales', 'supervisor', 'admin') then
      raise exception 'Current user cannot create business orders';
    end if;
    if v_actor.role::text in ('sales', 'supervisor')
       and (
         new.salesperson_id is distinct from v_actor.id
         or v_customer_owner is distinct from v_actor.id
       ) then
      raise exception 'Business order salesperson must match the current customer owner';
    end if;
  elsif v_actor.role::text not in ('admin', 'finance')
        and v_customer_owner is distinct from v_actor.id then
    raise exception 'Customer is not manageable by current user';
  end if;

  return new;
end;
$$;
revoke all on function public.guard_current_customer_assignment_insert()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_business_orders_current_customer on public.business_orders;
create trigger trg_business_orders_current_customer
  before insert on public.business_orders for each row
  execute function public.guard_current_customer_assignment_insert();

drop trigger if exists trg_custom_products_current_customer on public.business_custom_products;
create trigger trg_custom_products_current_customer
  before insert on public.business_custom_products for each row
  execute function public.guard_current_customer_assignment_insert();

drop trigger if exists trg_customer_transfers_current_customer on public.business_customer_transfers;
create trigger trg_customer_transfers_current_customer
  before insert on public.business_customer_transfers for each row
  execute function public.guard_current_customer_assignment_insert();

drop trigger if exists trg_pi_current_customer on public.proforma_invoices;
create trigger trg_pi_current_customer
  before insert on public.proforma_invoices for each row
  execute function public.guard_current_customer_assignment_insert();

-- 旧财务订单和收支流水的负责人及姓名是历史事实，不允许事后重写。
create or replace function public.protect_legacy_finance_identity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.salesperson_id is distinct from old.salesperson_id
     or new.salesperson_name_snapshot is distinct from old.salesperson_name_snapshot
     or new.salesperson_display_name_snapshot is distinct from old.salesperson_display_name_snapshot then
    raise exception 'Historical finance salesperson identity is immutable';
  end if;
  return new;
end;
$$;
revoke all on function public.protect_legacy_finance_identity()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_finance_orders_protect_identity on public.finance_orders;
create trigger trg_finance_orders_protect_identity
  before update of salesperson_id, salesperson_name_snapshot, salesperson_display_name_snapshot
  on public.finance_orders for each row
  execute function public.protect_legacy_finance_identity();

drop trigger if exists trg_finance_transactions_protect_identity on public.finance_transactions;
create trigger trg_finance_transactions_protect_identity
  before update of salesperson_id, salesperson_name_snapshot, salesperson_display_name_snapshot
  on public.finance_transactions for each row
  execute function public.protect_legacy_finance_identity();


-- 店铺分配属于配置，不是旧每日订单事实；候选统一为已审核的非财务账号。
create or replace function public.save_finance_daily_order_shop(
  p_shop_id uuid, p_name text, p_group_id uuid, p_is_active boolean,
  p_salesperson_ids uuid[], p_default_currency public.currency_code
)
returns public.finance_daily_order_shops
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_shop public.finance_daily_order_shops%rowtype;
  v_sales_id uuid;
begin
  v_actor := public.assert_daily_order_finance_actor();
  if nullif(btrim(p_name), '') is null or char_length(btrim(p_name)) > 100 then
    raise exception 'Invalid shop name';
  end if;
  if p_default_currency is null or p_default_currency::text not in ('CNY', 'USD') then
    raise exception 'Invalid shop currency';
  end if;
  if p_group_id is not null and not exists (
    select 1 from public.finance_daily_order_shop_groups where id = p_group_id
  ) then
    raise exception 'Shop group does not exist';
  end if;
  if coalesce(array_length(p_salesperson_ids, 1), 0) > 200 then
    raise exception 'Too many salespeople';
  end if;
  foreach v_sales_id in array coalesce(p_salesperson_ids, array[]::uuid[]) loop
    if not exists (
      select 1 from public.profiles
      where id = v_sales_id
        and status::text = 'approved'
        and role::text <> 'finance'
    ) then
      raise exception 'Assigned user does not exist, is not approved, or is a finance user';
    end if;
  end loop;

  if p_shop_id is null then
    insert into public.finance_daily_order_shops(
      name, group_id, is_active, default_currency, created_by
    ) values (
      btrim(p_name), p_group_id, p_is_active, p_default_currency, v_actor.id
    ) returning * into v_shop;
  else
    update public.finance_daily_order_shops
    set name = btrim(p_name), group_id = p_group_id,
        is_active = p_is_active, default_currency = p_default_currency
    where id = p_shop_id
    returning * into v_shop;
    if not found then raise exception 'Shop does not exist'; end if;
  end if;

  update public.finance_daily_order_shop_salespeople
  set is_active = false
  where shop_id = v_shop.id
    and salesperson_id <> all(coalesce(p_salesperson_ids, array[]::uuid[]));

  foreach v_sales_id in array coalesce(p_salesperson_ids, array[]::uuid[]) loop
    insert into public.finance_daily_order_shop_salespeople(
      shop_id, salesperson_id, is_active, created_by
    ) values (v_shop.id, v_sales_id, true, v_actor.id)
    on conflict (shop_id, salesperson_id) do update set is_active = true;
  end loop;
  return v_shop;
end;
$$;
revoke all on function public.save_finance_daily_order_shop(
  uuid, text, uuid, boolean, uuid[], public.currency_code
) from public, anon, authenticated, service_role;
grant execute on function public.save_finance_daily_order_shop(
  uuid, text, uuid, boolean, uuid[], public.currency_code
) to authenticated;

create or replace function public.save_finance_daily_order_shop(
  p_shop_id uuid, p_name text, p_group_id uuid, p_is_active boolean,
  p_salesperson_ids uuid[]
)
returns public.finance_daily_order_shops
language sql
security definer
set search_path = public
as $$
  select public.save_finance_daily_order_shop(
    p_shop_id, p_name, p_group_id, p_is_active, p_salesperson_ids,
    case
      when p_shop_id is null then 'CNY'::public.currency_code
      else coalesce(
        (select s.default_currency from public.finance_daily_order_shops s where s.id = p_shop_id),
        'CNY'::public.currency_code
      )
    end
  );
$$;
revoke all on function public.save_finance_daily_order_shop(
  uuid, text, uuid, boolean, uuid[]
) from public, anon, authenticated, service_role;
grant execute on function public.save_finance_daily_order_shop(
  uuid, text, uuid, boolean, uuid[]
) to authenticated;
