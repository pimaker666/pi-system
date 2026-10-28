-- 0128_attendance_members.sql
-- 考勤表人员名册：考勤行从「全员 profiles」改为「按表维护的花名册」。
--   1. 新表 attendance_members：sheet 级成员，profile_id 关联系统账号（可空）；
--      无账号人员手动录入（仅 name）。profile 成员每表唯一（手动成员不限制重名）。
--   2. attendance_entries 增加 member_id 并回填，profile_id 放宽可空（保留用于员工本人 RLS/查询），
--      唯一约束从 (sheet_id, profile_id, day) 改为 (sheet_id, member_id, day)。
--   3. 守卫/RLS 与 0122 同口径：仅财务/管理员维护，花名册对全员可见（员工需知道表上有谁）。

begin;

-- -----------------------------------------------------------------------------
-- 1. 花名册
-- -----------------------------------------------------------------------------
create table if not exists public.attendance_members (
  id         uuid primary key default gen_random_uuid(),
  sheet_id   uuid not null references public.attendance_sheets(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 50),
  sort_order int  not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- profile 成员每表唯一；手动成员 profile_id 为 null，Postgres 唯一约束对 null 不冲突，允许重名
  constraint attendance_members_profile_unique unique (sheet_id, profile_id)
);

comment on table public.attendance_members is '考勤表花名册：关联系统账号的成员 + 手动录入的无账号人员';

create index if not exists idx_attendance_members_sheet
  on public.attendance_members (sheet_id, sort_order);

drop trigger if exists trg_attendance_members_touch on public.attendance_members;
create trigger trg_attendance_members_touch
  before update on public.attendance_members
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 2. entries 增加 member_id 并回填
-- -----------------------------------------------------------------------------
alter table public.attendance_entries
  add column if not exists member_id uuid references public.attendance_members(id) on delete cascade;

-- 既有数据：每个 (sheet_id, profile_id) 建一名成员，按 profile 创建顺序排（可重复执行）
insert into public.attendance_members (sheet_id, profile_id, name, sort_order)
select distinct_on_pair.sheet_id,
       distinct_on_pair.profile_id,
       coalesce(nullif(btrim(p.chinese_name), ''), nullif(btrim(p.full_name), ''), '成员') as name,
       row_number() over (partition by distinct_on_pair.sheet_id order by p.created_at, p.full_name) as sort_order
from (
  select distinct sheet_id, profile_id
  from public.attendance_entries
  where profile_id is not null
) distinct_on_pair
join public.profiles p on p.id = distinct_on_pair.profile_id
where not exists (
  select 1 from public.attendance_members am
  where am.sheet_id = distinct_on_pair.sheet_id
    and am.profile_id is not distinct from distinct_on_pair.profile_id
);

-- 回填期间停用行触发器（迁移以 supabase_admin 执行，无 JWT，守卫触发器会拒绝对
-- entries 的 UPDATE；回填是纯数据搬运，不改变业务可见性）
set local session_replication_role = 'replica';

update public.attendance_entries e
set member_id = m.id
from public.attendance_members m
where m.sheet_id = e.sheet_id
  and (m.profile_id is not distinct from e.profile_id);

set local session_replication_role = 'origin';

alter table public.attendance_entries alter column profile_id drop not null;

alter table public.attendance_entries drop constraint if exists attendance_entries_unique;
alter table public.attendance_entries drop constraint if exists attendance_entries_unique_member;
alter table public.attendance_entries
  add constraint attendance_entries_unique_member unique (sheet_id, member_id, day);

create index if not exists idx_attendance_entries_member
  on public.attendance_entries (sheet_id, member_id, day);

-- entries.profile_id 冗余自花名册：员工本人 RLS/查询依赖该列，由触发器统一同步
create or replace function public.attendance_entry_sync_profile()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  select profile_id into new.profile_id
  from public.attendance_members
  where id = new.member_id;
  return new;
end;
$$;

revoke all on function public.attendance_entry_sync_profile() from public, anon, authenticated, service_role;
grant execute on function public.attendance_entry_sync_profile() to authenticated;

drop trigger if exists trg_attendance_entries_sync_profile on public.attendance_entries;
create trigger trg_attendance_entries_sync_profile
  before insert or update on public.attendance_entries
  for each row execute function public.attendance_entry_sync_profile();

-- -----------------------------------------------------------------------------
-- 3. 守卫：花名册仅财务/管理员维护（member_id 非空后由 action 统一维护 profile_id）
-- -----------------------------------------------------------------------------
create or replace function public.attendance_member_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_finance_or_admin() then
    raise exception 'Only finance or admin can modify attendance members';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.attendance_member_guard() from public, anon, authenticated, service_role;
grant execute on function public.attendance_member_guard() to authenticated;

drop trigger if exists trg_attendance_members_guard on public.attendance_members;
create trigger trg_attendance_members_guard
  before insert or update or delete on public.attendance_members
  for each row execute function public.attendance_member_guard();

-- -----------------------------------------------------------------------------
-- 4. RLS
-- -----------------------------------------------------------------------------
alter table public.attendance_members enable row level security;

grant select, insert, update, delete on public.attendance_members to authenticated;

-- 花名册对全员可见（员工需知道表上有谁）
drop policy if exists "attendance_members_select" on public.attendance_members;
create policy "attendance_members_select" on public.attendance_members
  for select to authenticated
  using (true);

drop policy if exists "attendance_members_insert" on public.attendance_members;
create policy "attendance_members_insert" on public.attendance_members
  for insert to authenticated
  with check (public.is_finance_or_admin());

drop policy if exists "attendance_members_update" on public.attendance_members;
create policy "attendance_members_update" on public.attendance_members
  for update to authenticated
  using (public.is_finance_or_admin())
  with check (public.is_finance_or_admin());

drop policy if exists "attendance_members_delete" on public.attendance_members;
create policy "attendance_members_delete" on public.attendance_members
  for delete to authenticated
  using (public.is_finance_or_admin());

commit;
