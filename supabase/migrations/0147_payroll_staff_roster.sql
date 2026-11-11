-- 0147_payroll_staff_roster.sql
-- 薪资档案升级为工资花名册：工资表人员不再直接取「全部已启用的账号」，而是取薪资档案。
--   1. payroll_salary_profiles 增加代理主键 id、姓名 name、排序 sort_order；profile_id 放宽可空
--      （无系统账号的员工也能维护薪资档案），账号员工仍保持唯一关联。
--   2. 为现有已启用账号补建薪资档案，保证升级后新建工资表仍默认包含全部在职员工；
--      之后新增/删除人员以薪资档案为准，新建工资表逐条带入。
--   3. payroll_items 增加 salary_profile_id（档案删除时置空、保留历史姓名）与 employee_name 姓名快照，
--      profile_id 放宽可空（无账号人员没有账号，也无需员工本人确认）；既有明细按 profile 回填。
--   4. 工资明细守卫把新增列纳入「内容变更」判定，published 锁定口径不变。

begin;

-- 回填/补建属于纯数据搬运，迁移以 supabase_admin 执行时没有 JWT；
-- 守卫触发器会拒绝此类 UPDATE/INSERT，故在此期间停用行触发器（0128 同口径）。
set local session_replication_role = 'replica';

-- -----------------------------------------------------------------------------
-- 1. 薪资档案：代理主键 + 姓名 + 排序，profile_id 可空
-- -----------------------------------------------------------------------------
alter table public.payroll_salary_profiles add column if not exists id uuid;
update public.payroll_salary_profiles set id = gen_random_uuid() where id is null;
alter table public.payroll_salary_profiles alter column id set not null;
alter table public.payroll_salary_profiles alter column id set default gen_random_uuid();

alter table public.payroll_salary_profiles drop constraint if exists payroll_salary_profiles_pkey;
alter table public.payroll_salary_profiles add constraint payroll_salary_profiles_pkey primary key (id);

alter table public.payroll_salary_profiles drop constraint if exists payroll_salary_profiles_profile_id_key;
alter table public.payroll_salary_profiles add constraint payroll_salary_profiles_profile_key unique (profile_id);
alter table public.payroll_salary_profiles alter column profile_id drop not null;

alter table public.payroll_salary_profiles add column if not exists name text;
alter table public.payroll_salary_profiles add column if not exists sort_order int not null default 0;

comment on table public.payroll_salary_profiles is '工资花名册：账号员工关联 profile_id，无账号人员仅姓名；新建工资表默认带入全部档案人员';
comment on column public.payroll_salary_profiles.profile_id is '关联系统账号；无系统账号的员工为 null';
comment on column public.payroll_salary_profiles.name is '工资/发放名单姓名（账号员工建表时取 profile 名称）';

-- 回填已有档案的姓名
update public.payroll_salary_profiles sp
set name = coalesce(
  nullif(btrim(p.chinese_name), ''),
  nullif(btrim(p.full_name), ''),
  nullif(btrim(p.email), ''),
  '员工'
)
from public.profiles p
where p.id = sp.profile_id
  and sp.name is null;

-- 为全部已启用账号补建档案，保持升级后「新建工资表包含全部在职员工」的既有行为
insert into public.payroll_salary_profiles (profile_id, name)
select p.id,
       coalesce(
         nullif(btrim(p.chinese_name), ''),
         nullif(btrim(p.full_name), ''),
         nullif(btrim(p.email), ''),
         '员工'
       )
from public.profiles p
where p.status = 'approved'
  and not exists (
    select 1 from public.payroll_salary_profiles sp where sp.profile_id = p.id
  );

-- 排序：账号员工按账号创建顺序，无账号人员排在后面
with ordered as (
  select sp.id,
         row_number() over (order by p.created_at nulls last, p.full_name, sp.name) as rn
  from public.payroll_salary_profiles sp
  left join public.profiles p on p.id = sp.profile_id
)
update public.payroll_salary_profiles sp
set sort_order = ordered.rn
from ordered
where ordered.id = sp.id
  and sp.sort_order = 0;

alter table public.payroll_salary_profiles alter column name set not null;

-- -----------------------------------------------------------------------------
-- 2. 工资明细：关联档案 + 姓名快照，profile_id 可空，回填
-- -----------------------------------------------------------------------------
alter table public.payroll_items
  add column if not exists salary_profile_id uuid references public.payroll_salary_profiles(id) on delete set null;
alter table public.payroll_items add column if not exists employee_name text;

comment on column public.payroll_items.salary_profile_id is '来源薪资档案；档案删除后置空，行内保留姓名与金额快照';
comment on column public.payroll_items.employee_name is '工资行姓名快照（无账号人员唯一姓名来源）';

update public.payroll_items i
set employee_name = coalesce(
  nullif(btrim(p.chinese_name), ''),
  nullif(btrim(p.full_name), ''),
  nullif(btrim(p.email), ''),
  '员工'
)
from public.profiles p
where p.id = i.profile_id
  and i.employee_name is null;

update public.payroll_items i
set salary_profile_id = sp.id
from public.payroll_salary_profiles sp
where sp.profile_id = i.profile_id
  and i.salary_profile_id is null;

update public.payroll_items set employee_name = '员工' where employee_name is null;
alter table public.payroll_items alter column employee_name set not null;
alter table public.payroll_items alter column profile_id drop not null;

-- 同一工资表内同一档案只能出现一次；无账号人员以 salary_profile_id 判重
create unique index if not exists uq_payroll_items_sheet_salary_profile
  on public.payroll_items (sheet_id, salary_profile_id)
  where salary_profile_id is not null;

set local session_replication_role = 'origin';

-- -----------------------------------------------------------------------------
-- 3. 工资明细守卫：内容变更纳入新列（沿用 0133 其余口径）
-- -----------------------------------------------------------------------------
create or replace function public.payroll_item_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  parent_status text;
  content_changed boolean;
begin
  if tg_op = 'DELETE' then
    select status into parent_status from public.payroll_sheets where id = old.sheet_id;
    if found and parent_status <> 'draft' then
      raise exception 'Published payroll items are locked; unpublish before editing';
    end if;
    if not public.is_finance_or_admin() then
      raise exception 'Only finance or admin can delete payroll items';
    end if;
    return old;
  end if;

  select status into parent_status from public.payroll_sheets
  where id = coalesce(new.sheet_id, old.sheet_id);
  if not found then
    raise exception 'Payroll sheet does not exist';
  end if;

  if tg_op = 'INSERT' then
    if not public.is_finance_or_admin() then
      raise exception 'Only finance or admin can add payroll items';
    end if;
    if parent_status <> 'draft' then
      raise exception 'Published payroll items are locked; unpublish before editing';
    end if;
    if new.confirmation <> 'pending'
       or new.confirmed_at is not null or new.rejected_at is not null or new.rejected_reason is not null then
      raise exception 'New payroll item must start as pending';
    end if;
    return new;
  end if;

  -- UPDATE
  content_changed := new.sheet_id is distinct from old.sheet_id
    or new.profile_id is distinct from old.profile_id
    or new.salary_profile_id is distinct from old.salary_profile_id
    or new.employee_name is distinct from old.employee_name
    or new.sort_order is distinct from old.sort_order
    or new.attendance_days is distinct from old.attendance_days
    or new.base_salary is distinct from old.base_salary
    or new.commission is distinct from old.commission
    or new.bonus is distinct from old.bonus
    or new.attendance_deduction is distinct from old.attendance_deduction
    or new.other_deduction is distinct from old.other_deduction
    or new.social_insurance is distinct from old.social_insurance
    or new.housing_fund is distinct from old.housing_fund
    or new.tax is distinct from old.tax
    or new.remark is distinct from old.remark;

  if public.is_finance_or_admin() then
    if content_changed then
      if parent_status <> 'draft' then
        raise exception 'Published payroll items are locked; unpublish before editing';
      end if;
    else
      -- 无内容变更时财务只能把行重置回待确认，不能代员工确认/驳回
      if new.confirmation <> 'pending'
         or new.confirmed_at is not null or new.rejected_at is not null or new.rejected_reason is not null then
        raise exception 'Finance cannot confirm or reject on behalf of an employee';
      end if;
    end if;
    return new;
  end if;

  -- 员工本人：仅允许推进确认状态，金额一律不可动
  if content_changed
     or new.confirmation is not distinct from old.confirmation then
    raise exception 'Employees can only confirm or reject their own payroll';
  end if;
  if old.profile_id is distinct from auth.uid() then
    raise exception 'Can only confirm or reject your own payroll';
  end if;
  if parent_status <> 'published' then
    raise exception 'Payroll sheet has not been published yet';
  end if;
  if not (old.confirmation = 'pending' and new.confirmation in ('confirmed', 'rejected')) then
    raise exception 'Invalid payroll confirmation transition';
  end if;
  if new.confirmation = 'confirmed' then
    new.confirmed_at := now();
    new.rejected_at := null;
    new.rejected_reason := null;
  else
    if new.rejected_reason is null or char_length(btrim(new.rejected_reason)) = 0 then
      raise exception 'Reject reason is required';
    end if;
    new.rejected_at := now();
    new.confirmed_at := null;
  end if;
  return new;
end;
$$;

revoke all on function public.payroll_item_guard() from public, anon, authenticated, service_role;
grant execute on function public.payroll_item_guard() to authenticated;

commit;
