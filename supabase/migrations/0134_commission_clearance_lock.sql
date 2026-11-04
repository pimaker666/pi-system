-- 0134_commission_clearance_lock.sql
-- 结清锁下沉到数据库：产品行处于 pending/confirmed 结清时，提点覆盖与订单运费/汇率不可再直接改写；
-- 已发布工资表的发放月份、满勤天数同样只读，需先撤回发布。
-- 此前仅 Server Action 校验，持有登录态可直接调用 PostgREST 绕过。

create or replace function public.commission_item_lock_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- 产品行被删除时允许级联清理其提点覆盖
  if tg_op = 'DELETE'
     and not exists (select 1 from public.business_order_items where id = old.business_order_item_id) then
    return old;
  end if;

  if tg_op in ('UPDATE', 'DELETE') and exists (
    select 1
    from public.finance_business_order_item_commission_clearances c
    where c.business_order_item_id = old.business_order_item_id
      and c.status in ('pending', 'confirmed')
  ) then
    raise exception 'Commission is locked by an active clearance; cancel the clearance before editing';
  end if;

  if tg_op in ('INSERT', 'UPDATE') and exists (
    select 1
    from public.finance_business_order_item_commission_clearances c
    where c.business_order_item_id = new.business_order_item_id
      and c.status in ('pending', 'confirmed')
  ) then
    raise exception 'Commission is locked by an active clearance; cancel the clearance before editing';
  end if;

  return coalesce(new, old);
end;
$$;

revoke all on function public.commission_item_lock_guard() from public, anon, authenticated, service_role;
grant execute on function public.commission_item_lock_guard() to authenticated;

drop trigger if exists trg_finance_business_order_item_commissions_lock
  on public.finance_business_order_item_commissions;
create trigger trg_finance_business_order_item_commissions_lock
  before insert or update or delete on public.finance_business_order_item_commissions
  for each row execute function public.commission_item_lock_guard();

create or replace function public.commission_order_lock_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- 订单被删除时允许级联清理运费提成
  if tg_op = 'DELETE'
     and not exists (select 1 from public.business_orders where id = old.business_order_id) then
    return old;
  end if;

  if tg_op in ('UPDATE', 'DELETE') and exists (
    select 1
    from public.business_order_items i
    join public.finance_business_order_item_commission_clearances c
      on c.business_order_item_id = i.id
    where i.order_id = old.business_order_id
      and c.status in ('pending', 'confirmed')
  ) then
    raise exception 'Commission is locked by an active clearance; cancel the clearance before editing';
  end if;

  if tg_op in ('INSERT', 'UPDATE') and exists (
    select 1
    from public.business_order_items i
    join public.finance_business_order_item_commission_clearances c
      on c.business_order_item_id = i.id
    where i.order_id = new.business_order_id
      and c.status in ('pending', 'confirmed')
  ) then
    raise exception 'Commission is locked by an active clearance; cancel the clearance before editing';
  end if;

  return coalesce(new, old);
end;
$$;

revoke all on function public.commission_order_lock_guard() from public, anon, authenticated, service_role;
grant execute on function public.commission_order_lock_guard() to authenticated;

drop trigger if exists trg_finance_business_order_commissions_lock
  on public.finance_business_order_commissions;
create trigger trg_finance_business_order_commissions_lock
  before insert or update or delete on public.finance_business_order_commissions
  for each row execute function public.commission_order_lock_guard();

-- 已发布工资表除确认状态外全部只读（此前只锁了所属月份）。
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
      -- 撤回必须走 RPC，确保同时清空全员确认状态
      if coalesce(current_setting('payroll.unpublishing', true), '') <> '1' then
        raise exception 'Use unpublish_payroll_sheet to unpublish payroll sheets';
      end if;
      new.published_by := null;
      new.published_at := null;
    else
      raise exception 'Invalid payroll sheet status transition';
    end if;
  else
    if old.status = 'published'
       and (new.period_month is distinct from old.period_month
            or new.payout_month is distinct from old.payout_month
            or new.full_attendance_days is distinct from old.full_attendance_days) then
      raise exception 'Published payroll sheet is locked; unpublish before editing';
    end if;
    new.published_by := old.published_by;
    new.published_at := old.published_at;
  end if;
  return new;
end;
$$;

revoke all on function public.payroll_sheet_guard() from public, anon, authenticated, service_role;
grant execute on function public.payroll_sheet_guard() to authenticated;

-- 撤回发布：published → draft，并重置全员确认；与上面的会话标记配合，禁止绕过。
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
     set confirmation = 'pending',
         confirmed_at = null,
         rejected_at = null,
         rejected_reason = null
   where sheet_id = p_sheet_id
     and (confirmation <> 'pending'
          or confirmed_at is not null
          or rejected_at is not null
          or rejected_reason is not null);

  perform set_config('payroll.unpublishing', '', true);
end;
$$;

revoke all on function public.unpublish_payroll_sheet(uuid) from public, anon, authenticated, service_role;
grant execute on function public.unpublish_payroll_sheet(uuid) to authenticated;
