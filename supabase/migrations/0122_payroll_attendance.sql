-- 0122_payroll_attendance.sql
-- 工资表 + 考勤表：替代原收支流水菜单位。
-- 设计原则：
--   1. 工资表（payroll_sheets/payroll_items）仅 CNY，格式对齐公司工资表模板：
--      出勤天数/基本工资/提成/奖金/考勤扣款 → 应发工资；其他/社保/公积金/个税扣款 → 应扣工资；实发=应发-应扣（代码侧计算不落库）。
--   2. 状态机：sheet draft（财务编辑）→ published（推送给员工确认），published 后金额仍可由财务修正，
--      触发器自动把该行确认状态重置回 pending。item confirmation：pending → confirmed/rejected（仅员工本人，仅 published），驳回必填原因。
--   3. 考勤表（attendance_sheets/attendance_entries）：每人每月一行考勤格（上午/下午两个符号），
--      符号集 √出勤 ●休假 ○请假 ☆病假 △外勤 ×旷工 ※迟到 ◇早退 ◆中途离岗 ▲出差；仅财务/管理员维护，员工只读本人。
--   4. 可见范围：财务/管理员全量；其他账号仅本人工资条/本人考勤。

begin;

-- -----------------------------------------------------------------------------
-- 1. 工资表头
-- -----------------------------------------------------------------------------
create table if not exists public.payroll_sheets (
  id            uuid primary key default gen_random_uuid(),
  period_month  date not null unique,
  payout_month  date,
  status        text not null default 'draft'
    check (status in ('draft', 'published')),
  published_by  uuid references public.profiles(id) on delete set null,
  published_at  timestamptz,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint payroll_sheets_month_check check (period_month = date_trunc('month', period_month)::date),
  constraint payroll_sheets_payout_month_check
    check (payout_month is null or payout_month = date_trunc('month', payout_month)::date),
  constraint payroll_sheets_publish_pair check (
    (status = 'published' and published_by is not null and published_at is not null)
    or (status = 'draft' and published_by is null and published_at is null)
  )
);

comment on table public.payroll_sheets is '工资表（按所属月份一张），draft=财务编辑中，published=已推送员工确认';
comment on column public.payroll_sheets.period_month is '所属月份（工资归属月，每月1日）';
comment on column public.payroll_sheets.payout_month is '发放月份（每月1日），可空';

-- -----------------------------------------------------------------------------
-- 2. 工资表明细行（每员工一行）
-- -----------------------------------------------------------------------------
create table if not exists public.payroll_items (
  id                   uuid primary key default gen_random_uuid(),
  sheet_id             uuid not null references public.payroll_sheets(id) on delete cascade,
  profile_id           uuid not null references public.profiles(id) on delete restrict,
  sort_order           int not null default 0,
  attendance_days      numeric(6,1) not null default 0 check (attendance_days >= 0 and attendance_days <= 62),
  base_salary          numeric(18,2) not null default 0,
  commission           numeric(18,2) not null default 0,
  bonus                numeric(18,2) not null default 0,
  attendance_deduction numeric(18,2) not null default 0,
  other_deduction      numeric(18,2) not null default 0,
  social_insurance     numeric(18,2) not null default 0,
  housing_fund         numeric(18,2) not null default 0,
  tax                  numeric(18,2) not null default 0,
  remark               text,
  confirmation         text not null default 'pending'
    check (confirmation in ('pending', 'confirmed', 'rejected')),
  confirmed_at         timestamptz,
  rejected_reason      text,
  rejected_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint payroll_items_sheet_profile_unique unique (sheet_id, profile_id),
  constraint payroll_items_remark_check check (remark is null or char_length(btrim(remark)) <= 500),
  constraint payroll_items_reject_pair check (
    (confirmation = 'rejected' and rejected_reason is not null and char_length(btrim(rejected_reason)) > 0
      and rejected_at is not null and confirmed_at is null)
    or (confirmation = 'confirmed' and confirmed_at is not null
      and rejected_reason is null and rejected_at is null)
    or (confirmation = 'pending' and confirmed_at is null
      and rejected_reason is null and rejected_at is null)
  )
);

comment on table public.payroll_items is '工资表明细行；应发=基本+提成+奖金-考勤扣款，应扣=其他+社保+公积金+个税，实发=应发-应扣（代码侧计算）';
comment on column public.payroll_items.confirmation is '员工确认状态：pending 待确认 / confirmed 已确认 / rejected 已驳回（仅 published 后可流转）';

create index if not exists idx_payroll_items_sheet on public.payroll_items (sheet_id, sort_order);
create index if not exists idx_payroll_items_profile on public.payroll_items (profile_id);

-- -----------------------------------------------------------------------------
-- 3. 考勤表头 + 考勤格
-- -----------------------------------------------------------------------------
create table if not exists public.attendance_sheets (
  id         uuid primary key default gen_random_uuid(),
  month      date not null unique,
  note       text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_sheets_month_check check (month = date_trunc('month', month)::date),
  constraint attendance_sheets_note_check check (note is null or char_length(btrim(note)) <= 500)
);

comment on table public.attendance_sheets is '考勤表（按月份一张），仅财务/管理员维护';

create table if not exists public.attendance_entries (
  id         uuid primary key default gen_random_uuid(),
  sheet_id   uuid not null references public.attendance_sheets(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete restrict,
  day        int not null check (day between 1 and 31),
  morning    text not null default '' check (morning in ('', '√', '●', '○', '☆', '△', '×', '※', '◇', '◆', '▲')),
  afternoon  text not null default '' check (afternoon in ('', '√', '●', '○', '☆', '△', '×', '※', '◇', '◆', '▲')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_entries_unique unique (sheet_id, profile_id, day)
);

comment on table public.attendance_entries is '考勤格：员工×日期，上午/下午各一个符号；空串=未标记';

create index if not exists idx_attendance_entries_sheet
  on public.attendance_entries (sheet_id, profile_id, day);

-- -----------------------------------------------------------------------------
-- 4. updated_at 触发器
-- -----------------------------------------------------------------------------
drop trigger if exists trg_payroll_sheets_touch on public.payroll_sheets;
create trigger trg_payroll_sheets_touch
  before update on public.payroll_sheets
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_payroll_items_touch on public.payroll_items;
create trigger trg_payroll_items_touch
  before update on public.payroll_items
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_attendance_sheets_touch on public.attendance_sheets;
create trigger trg_attendance_sheets_touch
  before update on public.attendance_sheets
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_attendance_entries_touch on public.attendance_entries;
create trigger trg_attendance_entries_touch
  before update on public.attendance_entries
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 5. 工资表守卫
--    a) sheet：draft→published 仅财务/管理员；published 后仅允许改发放月份；删除仅限 draft。
--    b) item：INSERT/内容修改/删除仅财务/管理员；published 后财务改内容自动重置确认状态；
--       员工只能推进本人行 pending→confirmed/rejected（父表须 published），驳回必填原因。
-- -----------------------------------------------------------------------------
create or replace function public.payroll_sheet_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if not public.is_finance_or_admin() then
      raise exception 'Only finance or admin can create payroll sheets';
    end if;
    if new.status <> 'draft' or new.published_by is not null or new.published_at is not null then
      raise exception 'New payroll sheet must start as draft';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if not public.is_finance_or_admin() then
      raise exception 'Only finance or admin can delete payroll sheets';
    end if;
    if old.status <> 'draft' then
      raise exception 'Published payroll sheet cannot be deleted';
    end if;
    return old;
  end if;

  -- UPDATE
  if not public.is_finance_or_admin() then
    raise exception 'Only finance or admin can modify payroll sheets';
  end if;
  if old.status is distinct from new.status then
    if not (old.status = 'draft' and new.status = 'published') then
      raise exception 'Invalid payroll sheet status transition';
    end if;
    new.published_by := auth.uid();
    new.published_at := now();
  else
    if old.status = 'published'
       and new.period_month is distinct from old.period_month then
      raise exception 'Published payroll sheet cannot change its period';
    end if;
    new.published_by := old.published_by;
    new.published_at := old.published_at;
  end if;
  return new;
end;
$$;

revoke all on function public.payroll_sheet_guard() from public, anon, authenticated, service_role;
grant execute on function public.payroll_sheet_guard() to authenticated;

drop trigger if exists trg_payroll_sheets_guard on public.payroll_sheets;
create trigger trg_payroll_sheets_guard
  before insert or update or delete on public.payroll_sheets
  for each row execute function public.payroll_sheet_guard();

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
      raise exception 'Payroll items are locked after publish';
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
    if new.confirmation <> 'pending'
       or new.confirmed_at is not null or new.rejected_at is not null or new.rejected_reason is not null then
      raise exception 'New payroll item must start as pending';
    end if;
    return new;
  end if;

  -- UPDATE
  content_changed := new.sheet_id is distinct from old.sheet_id
    or new.profile_id is distinct from old.profile_id
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
      -- published 后财务修正金额：该行自动回到待确认
      if parent_status = 'published' then
        new.confirmation := 'pending';
        new.confirmed_at := null;
        new.rejected_at := null;
        new.rejected_reason := null;
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

drop trigger if exists trg_payroll_items_guard on public.payroll_items;
create trigger trg_payroll_items_guard
  before insert or update or delete on public.payroll_items
  for each row execute function public.payroll_item_guard();

-- -----------------------------------------------------------------------------
-- 6. 考勤守卫：仅财务/管理员维护（含删除）；员工无任何写入口。
-- -----------------------------------------------------------------------------
create or replace function public.attendance_sheet_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_finance_or_admin() then
    raise exception 'Only finance or admin can modify attendance sheets';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.attendance_sheet_guard() from public, anon, authenticated, service_role;
grant execute on function public.attendance_sheet_guard() to authenticated;

drop trigger if exists trg_attendance_sheets_guard on public.attendance_sheets;
create trigger trg_attendance_sheets_guard
  before insert or update or delete on public.attendance_sheets
  for each row execute function public.attendance_sheet_guard();

create or replace function public.attendance_entry_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_finance_or_admin() then
    raise exception 'Only finance or admin can modify attendance entries';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.attendance_entry_guard() from public, anon, authenticated, service_role;
grant execute on function public.attendance_entry_guard() to authenticated;

drop trigger if exists trg_attendance_entries_guard on public.attendance_entries;
create trigger trg_attendance_entries_guard
  before insert or update or delete on public.attendance_entries
  for each row execute function public.attendance_entry_guard();

-- -----------------------------------------------------------------------------
-- 7. RLS
-- -----------------------------------------------------------------------------
alter table public.payroll_sheets enable row level security;
alter table public.payroll_items enable row level security;
alter table public.attendance_sheets enable row level security;
alter table public.attendance_entries enable row level security;

grant select, insert, update, delete on public.payroll_sheets to authenticated;
grant select, insert, update, delete on public.payroll_items to authenticated;
grant select, insert, update, delete on public.attendance_sheets to authenticated;
grant select, insert, update, delete on public.attendance_entries to authenticated;

drop policy if exists "payroll_sheets_select" on public.payroll_sheets;
create policy "payroll_sheets_select" on public.payroll_sheets
  for select to authenticated
  using (
    public.is_finance_or_admin()
    or (
      status = 'published'
      and exists (
        select 1 from public.payroll_items i
        where i.sheet_id = payroll_sheets.id and i.profile_id = auth.uid()
      )
    )
  );

drop policy if exists "payroll_sheets_write" on public.payroll_sheets;
create policy "payroll_sheets_write" on public.payroll_sheets
  for insert to authenticated
  with check (public.is_finance_or_admin());

drop policy if exists "payroll_sheets_update" on public.payroll_sheets;
create policy "payroll_sheets_update" on public.payroll_sheets
  for update to authenticated
  using (public.is_finance_or_admin())
  with check (public.is_finance_or_admin());

drop policy if exists "payroll_sheets_delete" on public.payroll_sheets;
create policy "payroll_sheets_delete" on public.payroll_sheets
  for delete to authenticated
  using (public.is_finance_or_admin());

drop policy if exists "payroll_items_select" on public.payroll_items;
create policy "payroll_items_select" on public.payroll_items
  for select to authenticated
  using (public.is_finance_or_admin() or profile_id = auth.uid());

drop policy if exists "payroll_items_insert" on public.payroll_items;
create policy "payroll_items_insert" on public.payroll_items
  for insert to authenticated
  with check (public.is_finance_or_admin());

drop policy if exists "payroll_items_update" on public.payroll_items;
create policy "payroll_items_update" on public.payroll_items
  for update to authenticated
  using (public.is_finance_or_admin() or profile_id = auth.uid())
  with check (public.is_finance_or_admin() or profile_id = auth.uid());

drop policy if exists "payroll_items_delete" on public.payroll_items;
create policy "payroll_items_delete" on public.payroll_items
  for delete to authenticated
  using (public.is_finance_or_admin());

-- 考勤表月份元数据对全员可见（员工需知道自己看的是哪个月）
drop policy if exists "attendance_sheets_select" on public.attendance_sheets;
create policy "attendance_sheets_select" on public.attendance_sheets
  for select to authenticated
  using (true);

drop policy if exists "attendance_sheets_insert" on public.attendance_sheets;
create policy "attendance_sheets_insert" on public.attendance_sheets
  for insert to authenticated
  with check (public.is_finance_or_admin());

drop policy if exists "attendance_sheets_update" on public.attendance_sheets;
create policy "attendance_sheets_update" on public.attendance_sheets
  for update to authenticated
  using (public.is_finance_or_admin())
  with check (public.is_finance_or_admin());

drop policy if exists "attendance_sheets_delete" on public.attendance_sheets;
create policy "attendance_sheets_delete" on public.attendance_sheets
  for delete to authenticated
  using (public.is_finance_or_admin());

drop policy if exists "attendance_entries_select" on public.attendance_entries;
create policy "attendance_entries_select" on public.attendance_entries
  for select to authenticated
  using (public.is_finance_or_admin() or profile_id = auth.uid());

drop policy if exists "attendance_entries_insert" on public.attendance_entries;
create policy "attendance_entries_insert" on public.attendance_entries
  for insert to authenticated
  with check (public.is_finance_or_admin());

drop policy if exists "attendance_entries_update" on public.attendance_entries;
create policy "attendance_entries_update" on public.attendance_entries
  for update to authenticated
  using (public.is_finance_or_admin())
  with check (public.is_finance_or_admin());

drop policy if exists "attendance_entries_delete" on public.attendance_entries;
create policy "attendance_entries_delete" on public.attendance_entries
  for delete to authenticated
  using (public.is_finance_or_admin());

commit;
