-- 0148_payroll_item_push.sql
-- 工资条支持单行撤回/单行推送：整表推送后的偶发错误，可只撤回该员工、改数后单独推送。
--   1. payroll_items 增加 pushed_at：null=员工看不到（未推送/无账号），非空=已推送时间。
--   2. 可见性改按行：员工只能读到本人且已推送的行；工资表可见性要求本人存在已推送行。
--   3. 守卫改为行级锁：已推送行不可改数，撤回该行（pushed_at 置空）后即可修改；推送/撤回由财务执行，
--      撤回时确认状态回到待确认。整表发布/撤回改为 RPC 原子完成。
--   4. 员工不再有工资明细写权限（确认/驳回入口已移除）。

begin;

alter table public.payroll_items
  add column if not exists pushed_at timestamptz;

comment on column public.payroll_items.pushed_at is '工资条推送时间；null=该员工看不到（未推送或没有系统账号）';

-- 存量：已发布表中的账号员工按整表发布时间回填，避免上线后员工突然看不到工资条
set local session_replication_role = 'replica';
update public.payroll_items i
   set pushed_at = s.published_at
  from public.payroll_sheets s
 where s.id = i.sheet_id
   and s.status = 'published'
   and i.profile_id is not null
   and i.pushed_at is null;
set local session_replication_role = 'origin';

-- -----------------------------------------------------------------------------
-- 1. 工资明细守卫：行级推送状态
-- -----------------------------------------------------------------------------
create or replace function public.payroll_item_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  parent_status text;
  content_changed boolean;
  push_changed boolean;
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
    if new.pushed_at is not null then
      raise exception 'New payroll item must start unpushed';
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
  push_changed := new.pushed_at is distinct from old.pushed_at;

  if public.is_finance_or_admin() then
    if content_changed and push_changed then
      raise exception 'Cannot edit and push a payroll item in the same step';
    end if;

    if content_changed then
      -- 已推送行对外承诺，先撤回这一行才能改数；草稿表或未推送行可直接改
      if parent_status <> 'draft' and old.pushed_at is not null then
        raise exception 'Pushed payroll items are locked; withdraw this payslip before editing';
      end if;
    end if;

    if push_changed then
      if new.pushed_at is not null then
        if parent_status <> 'published' then
          raise exception 'Payroll items can only be pushed while the sheet is published';
        end if;
        if old.pushed_at is not null then
          raise exception 'Payroll item is already pushed';
        end if;
        if new.profile_id is null then
          raise exception 'Employees without an account cannot receive payslips';
        end if;
        new.pushed_at := now();
      end if;
      -- 推送与撤回都重置确认状态；撤回清空历史确认字段
      new.confirmation := 'pending';
      new.confirmed_at := null;
      new.rejected_at := null;
      new.rejected_reason := null;
    end if;

    if not content_changed and not push_changed then
      -- 无内容变更时财务只能把行重置回待确认，不能代员工确认/驳回
      if new.confirmation <> 'pending'
         or new.confirmed_at is not null or new.rejected_at is not null or new.rejected_reason is not null then
        raise exception 'Finance cannot confirm or reject on behalf of an employee';
      end if;
    end if;
    return new;
  end if;

  -- 员工本人：仅允许推进确认状态，金额与推送状态一律不可动
  if content_changed
     or push_changed
     or new.confirmation is not distinct from old.confirmation then
    raise exception 'Employees can only confirm or reject their own payroll';
  end if;
  if old.profile_id is distinct from auth.uid() then
    raise exception 'Can only confirm or reject your own payroll';
  end if;
  if old.pushed_at is null then
    raise exception 'Payroll item has not been pushed yet';
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

-- -----------------------------------------------------------------------------
-- 2. 整表发布/撤回 RPC：原子完成状态与逐行推送状态
-- -----------------------------------------------------------------------------
create or replace function public.publish_payroll_sheet(p_sheet_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  pushable_count int;
begin
  if not public.is_finance_or_admin() then
    raise exception 'Only finance or admin can publish payroll sheets';
  end if;

  if not exists (
    select 1 from public.payroll_sheets where id = p_sheet_id and status = 'draft'
  ) then
    raise exception 'Payroll sheet is not draft';
  end if;

  select count(*) into pushable_count
  from public.payroll_items
  where sheet_id = p_sheet_id and profile_id is not null;
  if pushable_count = 0 then
    raise exception 'No pushable payroll rows';
  end if;

  update public.payroll_sheets
     set status = 'published'
   where id = p_sheet_id and status = 'draft';

  update public.payroll_items
     set pushed_at = now(),
         confirmation = 'pending',
         confirmed_at = null,
         rejected_at = null,
         rejected_reason = null
   where sheet_id = p_sheet_id
     and profile_id is not null;
end;
$$;

revoke all on function public.publish_payroll_sheet(uuid) from public, anon, authenticated, service_role;
grant execute on function public.publish_payroll_sheet(uuid) to authenticated;

create or replace function public.unpublish_payroll_sheet(p_sheet_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_finance_or_admin() then
    raise exception 'Only finance or admin can unpublish payroll sheets';
  end if;

  perform set_config('payroll.unpublishing', '1', true);

  update public.payroll_sheets
     set status = 'draft'
   where id = p_sheet_id and status = 'published';
  if not found then
    raise exception 'Payroll sheet is not published';
  end if;

  update public.payroll_items
     set pushed_at = null,
         confirmation = 'pending',
         confirmed_at = null,
         rejected_at = null,
         rejected_reason = null
   where sheet_id = p_sheet_id;

  perform set_config('payroll.unpublishing', '', true);
end;
$$;

revoke all on function public.unpublish_payroll_sheet(uuid) from public, anon, authenticated, service_role;
grant execute on function public.unpublish_payroll_sheet(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 3. RLS：工资条可见性按行，写权限收回财务/管理员
-- -----------------------------------------------------------------------------
drop policy if exists "payroll_sheets_select" on public.payroll_sheets;
create policy "payroll_sheets_select" on public.payroll_sheets
  for select to authenticated
  using (
    public.is_finance_or_admin()
    or (
      status = 'published'
      and exists (
        select 1 from public.payroll_items i
        where i.sheet_id = payroll_sheets.id
          and i.profile_id = auth.uid()
          and i.pushed_at is not null
      )
    )
  );

drop policy if exists "payroll_items_select" on public.payroll_items;
create policy "payroll_items_select" on public.payroll_items
  for select to authenticated
  using (
    public.is_finance_or_admin()
    or (profile_id = auth.uid() and pushed_at is not null)
  );

drop policy if exists "payroll_items_update" on public.payroll_items;
create policy "payroll_items_update" on public.payroll_items
  for update to authenticated
  using (public.is_finance_or_admin())
  with check (public.is_finance_or_admin());

commit;
