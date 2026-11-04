-- 0133_payroll_publish_lock.sql
-- 已发布工资表锁定：金额对外承诺后不可追溯改写，必须先撤回发布（published → draft）。
--   1. 工资表允许 published → draft 撤回，撤回时清空 published_by/published_at（满足 publish_pair 约束）。
--   2. 已发布工资表禁止新增明细行、修改金额、删除明细行；原逻辑是财务改金额后静默把该行重置为待确认。

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
    if old.status = 'draft' and new.status = 'published' then
      new.published_by := auth.uid();
      new.published_at := now();
    elsif old.status = 'published' and new.status = 'draft' then
      new.published_by := null;
      new.published_at := null;
    else
      raise exception 'Invalid payroll sheet status transition';
    end if;
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

-- 撤回发布：published → draft，并把全表确认状态重置为待确认（原子执行，避免半撤回）。
create or replace function public.unpublish_payroll_sheet(p_sheet_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_finance_or_admin() then
    raise exception 'Only finance or admin can unpublish payroll sheets';
  end if;

  update public.payroll_sheets
     set status = 'draft'
   where id = p_sheet_id and status = 'published';
  if not found then
    raise exception 'Payroll sheet is not published';
  end if;

  update public.payroll_items
     set confirmation = 'pending',
         confirmed_at = null,
         rejected_at = null,
         rejected_reason = null
   where sheet_id = p_sheet_id
     and (confirmation <> 'pending'
          or confirmed_at is not null
          or rejected_at is not null
          or rejected_reason is not null);
end;
$$;

revoke all on function public.unpublish_payroll_sheet(uuid) from public, anon, authenticated, service_role;
grant execute on function public.unpublish_payroll_sheet(uuid) to authenticated;
