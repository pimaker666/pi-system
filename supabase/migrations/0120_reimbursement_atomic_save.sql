-- 0120_reimbursement_atomic_save.sql
-- 仅管理员审批；父单锁串行化明细编辑与审批；主单、明细及重提一次事务保存。
begin;

create or replace function public.finance_reimbursement_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_is_admin boolean;
begin
  select p.role::text = 'admin' into actor_is_admin
  from public.profiles p
  where p.id = actor_id and p.status::text = 'approved';
  if not found then
    raise exception 'An approved authenticated user is required';
  end if;

  if tg_op = 'INSERT' then
    if new.applicant_id is distinct from actor_id then
      raise exception 'Reimbursement applicant must be the current user';
    end if;
    if new.status <> 'pending'
       or new.reviewed_by is not null or new.reviewed_at is not null
       or new.completed_by is not null or new.completed_at is not null
       or new.reject_reason is not null then
      raise exception 'New reimbursement must start as pending';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.applicant_id is distinct from old.applicant_id
     or new.created_at is distinct from old.created_at then
    raise exception 'Reimbursement identity and creation time cannot be changed';
  end if;
  if new.reviewed_by is distinct from old.reviewed_by
     or new.reviewed_at is distinct from old.reviewed_at
     or new.completed_by is distinct from old.completed_by
     or new.completed_at is distinct from old.completed_at then
    raise exception 'Review fields cannot be modified directly';
  end if;
  if new.reject_reason is distinct from old.reject_reason
     and not (old.status = 'pending' and new.status = 'rejected') then
    raise exception 'Reject reason can only be set when rejecting';
  end if;

  if old.status is distinct from new.status then
    if new.expense_date is distinct from old.expense_date
       or new.project_name is distinct from old.project_name then
      raise exception 'Status changes cannot also edit reimbursement content';
    end if;

    if old.status = 'rejected' and new.status = 'pending' then
      if actor_id is distinct from old.applicant_id then
        raise exception 'Only the applicant can resubmit a reimbursement';
      end if;
      new.reject_reason := null;
      new.reviewed_by := null;
      new.reviewed_at := null;
      new.completed_by := null;
      new.completed_at := null;
    elsif old.status = 'pending' and new.status in ('approved', 'rejected') then
      if not actor_is_admin then
        raise exception 'Only an approved admin can review a reimbursement';
      end if;
      if new.status = 'approved' and not exists (
        select 1 from public.finance_reimbursement_items i where i.request_id = old.id
      ) then
        raise exception 'Cannot approve a reimbursement without items';
      end if;
      if new.status = 'rejected'
         and (new.reject_reason is null or char_length(btrim(new.reject_reason)) not between 1 and 500) then
        raise exception 'Reject reason is required and must not exceed 500 characters';
      end if;
      new.reviewed_by := actor_id;
      new.reviewed_at := now();
    elsif old.status = 'approved' and new.status = 'completed' then
      if not actor_is_admin then
        raise exception 'Only an approved admin can complete a reimbursement';
      end if;
      new.completed_by := actor_id;
      new.completed_at := now();
    else
      raise exception 'Invalid reimbursement status transition';
    end if;
  else
    if old.status not in ('pending', 'rejected') then
      raise exception 'Approved or completed reimbursement cannot be modified';
    end if;
    if actor_id is distinct from old.applicant_id then
      raise exception 'Only the applicant can edit a reimbursement';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.finance_reimbursement_guard() from public, anon, authenticated, service_role;
grant execute on function public.finance_reimbursement_guard() to authenticated;

-- SELECT 策略保留财务可见；UPDATE 只允许本人或已批准管理员，触发器进一步限制操作。
drop policy if exists "finance_reimbursement_requests_update" on public.finance_reimbursement_requests;
create policy "finance_reimbursement_requests_update" on public.finance_reimbursement_requests
  for update to authenticated
  using (
    applicant_id = auth.uid() or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.status::text = 'approved' and p.role::text = 'admin'
    )
  )
  with check (
    applicant_id = auth.uid() or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.status::text = 'approved' and p.role::text = 'admin'
    )
  );

create or replace function public.finance_reimbursement_item_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  parent_status text;
  parent_applicant uuid;
  parent_id uuid;
begin
  if tg_op = 'UPDATE' and new.request_id is distinct from old.request_id then
    raise exception 'Reimbursement items cannot move to another request';
  end if;
  if tg_op = 'DELETE' then
    parent_id := old.request_id;
  else
    parent_id := new.request_id;
  end if;

  -- 与父单 UPDATE 使用同一行锁，等待审批后必须重新检查当前状态。
  select r.status, r.applicant_id into parent_status, parent_applicant
  from public.finance_reimbursement_requests r
  where r.id = parent_id
  for update;
  if not found then
    -- ON DELETE CASCADE 时父单已经删除；其他情况交由明确错误拒绝。
    if tg_op = 'DELETE' then
      return old;
    end if;
    raise exception 'Reimbursement request does not exist';
  end if;
  if parent_status not in ('pending', 'rejected') then
    raise exception 'Reimbursement items are locked after approval';
  end if;
  if auth.uid() is distinct from parent_applicant then
    raise exception 'Only the applicant can edit reimbursement items';
  end if;
  if not exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.status::text = 'approved'
  ) then
    raise exception 'An approved authenticated user is required';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.finance_reimbursement_item_guard() from public, anon, authenticated, service_role;
grant execute on function public.finance_reimbursement_item_guard() to authenticated;

create or replace function public.save_finance_reimbursement_request(
  p_request_id uuid,
  p_expense_date date,
  p_project_name text,
  p_items jsonb
)
returns jsonb
language plpgsql
security invoker set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  v_request_id uuid;
  previous_request public.finance_reimbursement_requests%rowtype;
  v_project_name text := nullif(btrim(p_project_name), '');
  item jsonb;
  unit_price numeric;
  quantity numeric;
  receipt_path text;
  old_receipt_paths text[] := array[]::text[];
  unused_receipt_paths text[];
begin
  if actor_id is null or not public.is_approved_user() then
    raise exception 'An approved authenticated user is required';
  end if;
  if p_expense_date is null or not isfinite(p_expense_date) then
    raise exception 'A valid expense date is required';
  end if;
  if v_project_name is not null and char_length(v_project_name) > 200 then
    raise exception 'Project name must not exceed 200 characters';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Reimbursement items must be an array';
  end if;
  if jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'A reimbursement must contain 1 to 100 items';
  end if;

  -- 在任何写入前验证；不依赖 numeric(18,4) 的隐式四舍五入来接受非法精度。
  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item) <> 'object'
       or jsonb_typeof(item -> 'summary') is distinct from 'string'
       or char_length(btrim(item ->> 'summary')) not between 1 and 500
       or jsonb_typeof(item -> 'unit_price') is distinct from 'number'
       or jsonb_typeof(item -> 'quantity') is distinct from 'number' then
      raise exception 'Invalid reimbursement item';
    end if;
    unit_price := (item ->> 'unit_price')::numeric;
    quantity := (item ->> 'quantity')::numeric;
    if unit_price <= 0 or unit_price > 999999999999
       or quantity <= 0 or quantity > 999999999999
       or unit_price <> round(unit_price, 4) or quantity <> round(quantity, 4) then
      raise exception 'Unit price and quantity must be positive, in range and have at most 4 decimals';
    end if;
    if unit_price * quantity >= 100000000000000
       or round(unit_price * quantity, 4) >= 100000000000000 then
      raise exception 'Reimbursement item amount exceeds numeric(18,4) range';
    end if;
    if item ? 'receipt_path' and jsonb_typeof(item -> 'receipt_path') not in ('string', 'null') then
      raise exception 'Invalid reimbursement receipt path';
    end if;
    receipt_path := item ->> 'receipt_path';
    if receipt_path is not null and (
      split_part(receipt_path, '/', 1) <> actor_id::text
      or receipt_path !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$'
    ) then
      raise exception 'Receipt path must be a valid image belonging to the applicant';
    end if;
  end loop;

  if p_request_id is null then
    insert into public.finance_reimbursement_requests (applicant_id, expense_date, project_name)
    values (actor_id, p_expense_date, v_project_name)
    returning id into v_request_id;
  else
    select r.* into previous_request
    from public.finance_reimbursement_requests r
    where r.id = p_request_id
    for update;
    if not found then
      raise exception 'Reimbursement request does not exist or is not accessible';
    end if;
    if previous_request.applicant_id is distinct from actor_id
       or previous_request.status not in ('pending', 'rejected') then
      raise exception 'Only the applicant can save a pending or rejected reimbursement';
    end if;
    v_request_id := previous_request.id;
    select coalesce(array_agg(distinct i.receipt_path), array[]::text[]) into old_receipt_paths
    from public.finance_reimbursement_items i
    where i.request_id = v_request_id and i.receipt_path is not null;

    update public.finance_reimbursement_requests r
    set expense_date = p_expense_date, project_name = v_project_name
    where r.id = v_request_id;
    delete from public.finance_reimbursement_items i where i.request_id = v_request_id;
  end if;

  insert into public.finance_reimbursement_items (request_id, summary, unit_price, quantity, receipt_path, sort_order)
  select v_request_id, btrim(value ->> 'summary'), (value ->> 'unit_price')::numeric,
         (value ->> 'quantity')::numeric, value ->> 'receipt_path', (ordinality - 1)::int
  from jsonb_array_elements(p_items) with ordinality;

  -- 单独状态 UPDATE，内容保存与重提仍属于本 RPC 的同一事务。
  if previous_request.status = 'rejected' then
    update public.finance_reimbursement_requests r set status = 'pending' where r.id = v_request_id;
  end if;

  -- 凭证可能被本人其他报销单复用，仍被引用的路径不能清理。
  select coalesce(array_agg(path), array[]::text[]) into unused_receipt_paths
  from unnest(old_receipt_paths) as paths(path)
  where not exists (
    select 1 from public.finance_reimbursement_items i where i.receipt_path = path
  );
  return jsonb_build_object('request_id', v_request_id, 'receipt_paths', to_jsonb(unused_receipt_paths));
end;
$$;

revoke all on function public.save_finance_reimbursement_request(uuid, date, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.save_finance_reimbursement_request(uuid, date, text, jsonb)
  to authenticated;

-- foldername 排除文件名，{uid}/{uuid}.png 只有一级目录。
drop policy if exists "finance_reimbursement_receipts_insert" on storage.objects;
create policy "finance_reimbursement_receipts_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'finance-reimbursement-receipts'
    and public.is_approved_user()
    and array_length(storage.foldername(name), 1) = 1
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$'
  );

commit;
