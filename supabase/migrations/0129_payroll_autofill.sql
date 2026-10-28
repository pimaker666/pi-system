-- 0129_payroll_autofill.sql
-- 工资表自动取数：员工薪资档案 + 工资表满勤天数。
-- 设计原则：
--   1. payroll_salary_profiles：每员工一条底薪/社保代扣/公积金代扣档案，新建工资表或补入员工时
--      自动带入明细行，仍可在工资表内逐行手动改（改动只落明细行，不回写档案）。
--   2. payroll_sheets.full_attendance_days：该月满勤天数（默认按国家法定口径=当月工作日数，
--      由代码侧算好写入，允许财务按实际调整）；考勤扣款=底薪/满勤天数×(满勤天数-实际出勤天数)，代码侧计算。
--   3. 可见性：薪资档案仅财务/管理员可见可维护；full_attendance_days 在工资表头上，随工资表既有 RLS。

begin;

-- -----------------------------------------------------------------------------
-- 1. 员工薪资档案
-- -----------------------------------------------------------------------------
create table if not exists public.payroll_salary_profiles (
  profile_id       uuid primary key references public.profiles(id) on delete cascade,
  base_salary      numeric(12,2) not null default 0 check (base_salary >= 0),
  social_insurance numeric(12,2) not null default 0 check (social_insurance >= 0),
  housing_fund     numeric(12,2) not null default 0 check (housing_fund >= 0),
  updated_by       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.payroll_salary_profiles is '员工薪资档案：底薪/社保代扣/公积金代扣，新建工资表时自动带入明细行';

drop trigger if exists trg_payroll_salary_profiles_touch on public.payroll_salary_profiles;
create trigger trg_payroll_salary_profiles_touch
  before update on public.payroll_salary_profiles
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 2. 工资表满勤天数
-- -----------------------------------------------------------------------------
alter table public.payroll_sheets
  add column if not exists full_attendance_days int check (full_attendance_days is null or full_attendance_days between 1 and 31);

comment on column public.payroll_sheets.full_attendance_days is '满勤天数（考勤扣款分母），默认当月工作日数，可按实际调整';

-- -----------------------------------------------------------------------------
-- 3. 守卫 + RLS：仅财务/管理员维护薪资档案
-- -----------------------------------------------------------------------------
create or replace function public.payroll_salary_profile_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_finance_or_admin() then
    raise exception 'Only finance or admin can modify payroll salary profiles';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.payroll_salary_profile_guard() from public, anon, authenticated, service_role;
grant execute on function public.payroll_salary_profile_guard() to authenticated;

drop trigger if exists trg_payroll_salary_profiles_guard on public.payroll_salary_profiles;
create trigger trg_payroll_salary_profiles_guard
  before insert or update or delete on public.payroll_salary_profiles
  for each row execute function public.payroll_salary_profile_guard();

alter table public.payroll_salary_profiles enable row level security;

grant select, insert, update, delete on public.payroll_salary_profiles to authenticated;

drop policy if exists "payroll_salary_profiles_select" on public.payroll_salary_profiles;
create policy "payroll_salary_profiles_select" on public.payroll_salary_profiles
  for select to authenticated
  using (public.is_finance_or_admin());

drop policy if exists "payroll_salary_profiles_insert" on public.payroll_salary_profiles;
create policy "payroll_salary_profiles_insert" on public.payroll_salary_profiles
  for insert to authenticated
  with check (public.is_finance_or_admin());

drop policy if exists "payroll_salary_profiles_update" on public.payroll_salary_profiles;
create policy "payroll_salary_profiles_update" on public.payroll_salary_profiles
  for update to authenticated
  using (public.is_finance_or_admin())
  with check (public.is_finance_or_admin());

drop policy if exists "payroll_salary_profiles_delete" on public.payroll_salary_profiles;
create policy "payroll_salary_profiles_delete" on public.payroll_salary_profiles
  for delete to authenticated
  using (public.is_finance_or_admin());

commit;
