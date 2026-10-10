-- 0099: 客户回收站
--
-- 客户删除改为软删除：先移入回收站，可恢复，也可彻底删除。
-- 硬删除会触发 business_orders.customer_id 外键 set null，进而撞上
-- 「作废/关闭订单不可改」和「已分摊不可换客户」两个守卫，这正是原来
-- 批量删除报 Voided business order cannot be edited or transitioned 的原因。
-- 因此彻底删除时通过事务级开关 app.customer_purge 放行「仅解绑客户」这一种改动。

begin;

alter table public.customers
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.profiles(id) on delete set null;

comment on column public.customers.deleted_at is '客户回收站：非空表示已删除，各业务列表须过滤';

create index if not exists idx_customers_deleted_at on public.customers (deleted_at);

-- ---------------------------------------------------------------------------
-- 1. 彻底删除客户时，订单只允许被解绑，其余字段一律照旧冻结
-- ---------------------------------------------------------------------------
create or replace function public.protect_business_order_closure()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_is_admin boolean;
  v_is_trusted_void boolean := coalesce(
    current_setting('app.void_business_order_rpc', true), ''
  ) = 'true';
begin
  if coalesce(current_setting('app.customer_purge', true), '') = 'true'
     and old.customer_id is not null
     and new.customer_id is null
     and (to_jsonb(new) - array['updated_at', 'total_cny', 'customer_id'])
         is not distinct from
         (to_jsonb(old) - array['updated_at', 'total_cny', 'customer_id']) then
    return new;
  end if;

  if old.voided_at is null and new.voided_at is not null then
    if not v_is_trusted_void then
      raise exception 'Business order can only be voided through the controlled RPC';
    end if;
    if (to_jsonb(new) - array[
      'voided_at', 'voided_by', 'void_reason', 'version', 'updated_at', 'total_cny'
    ]) is distinct from (to_jsonb(old) - array[
      'voided_at', 'voided_by', 'void_reason', 'version', 'updated_at', 'total_cny'
    ]) then
      raise exception 'Order void cannot modify other business order fields';
    end if;
    return new;
  elsif old.voided_at is not null then
    if new.voided_at is distinct from old.voided_at
       or new.voided_by is distinct from old.voided_by
       or new.void_reason is distinct from old.void_reason then
      raise exception 'Business order void is immutable';
    end if;
    if (to_jsonb(new) - array['updated_at', 'total_cny'])
       is distinct from
       (to_jsonb(old) - array['updated_at', 'total_cny']) then
      raise exception 'Voided business order cannot be edited or transitioned';
    end if;
    return new;
  end if;

  if old.closed_at is null and new.closed_at is not null then
    select exists (
      select 1 from public.profiles p
      where p.id = v_uid and p.status::text = 'approved' and p.role::text = 'admin'
    ) into v_is_admin;
    if old.status::text = 'completed' then
      raise exception 'Completed business order cannot be specially closed';
    end if;
    if not v_is_admin or new.closed_by is distinct from v_uid then
      raise exception 'Only an approved administrator can specially close an order';
    end if;
    if (to_jsonb(new) - array[
      'closed_at', 'closed_by', 'close_reason', 'version', 'updated_at', 'total_cny'
    ]) is distinct from (to_jsonb(old) - array[
      'closed_at', 'closed_by', 'close_reason', 'version', 'updated_at', 'total_cny'
    ]) then
      raise exception 'Special close cannot modify other business order fields';
    end if;
  elsif old.closed_at is not null then
    if v_is_trusted_void and (
      to_jsonb(new) - array['payment_status', 'updated_at', 'total_cny']
    ) is not distinct from (
      to_jsonb(old) - array['payment_status', 'updated_at', 'total_cny']
    ) then
      return new;
    end if;
    if new.closed_at is distinct from old.closed_at
       or new.closed_by is distinct from old.closed_by
       or new.close_reason is distinct from old.close_reason then
      raise exception 'Business order closure is immutable';
    end if;
    if (to_jsonb(new) - array['version', 'updated_at', 'total_cny'])
       is distinct from
       (to_jsonb(old) - array['version', 'updated_at', 'total_cny']) then
      raise exception 'Closed business order cannot be edited or transitioned';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.protect_business_order_closure()
  from public, anon, authenticated, service_role;

create or replace function public.protect_business_order_allocation_invariants()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_paid numeric;
begin
  if coalesce(current_setting('app.customer_purge', true), '') = 'true'
     and old.customer_id is not null
     and new.customer_id is null
     and new.currency is not distinct from old.currency
     and new.total_amount is not distinct from old.total_amount then
    return new;
  end if;

  select coalesce(sum(a.amount), 0) into v_paid
  from public.business_order_payment_allocations a
  join public.business_customer_transfers t on t.id = a.transfer_id
  where a.order_id = old.id
    and a.voided_at is null
    and t.voided_at is null;

  if (v_paid > 0 or (old.status::text = 'completed' and old.completion_gate_version >= 2))
     and new.customer_id is distinct from old.customer_id then
    raise exception 'Cannot change customer after payment allocation or completion';
  end if;
  if (v_paid > 0 or (old.status::text = 'completed' and old.completion_gate_version >= 2))
     and new.currency is distinct from old.currency then
    raise exception 'Cannot change currency after payment allocation or completion';
  end if;
  if v_paid > new.total_amount then
    raise exception 'Order total cannot be less than active payment allocations';
  end if;
  return new;
end;
$$;
revoke all on function public.protect_business_order_allocation_invariants()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. 回收站客户不得再被订单绑定
--    只拦「新绑定」：订单保留原本就已绑定的回收站客户时照常可编辑，
--    否则客户一进回收站，它名下所有订单都改不动。
-- ---------------------------------------------------------------------------
create or replace function public.reject_recycled_business_customer()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.customer_id is not distinct from old.customer_id then
    return new;
  end if;
  if new.customer_id is not null and exists (
    select 1 from public.customers c
    where c.id = new.customer_id and c.deleted_at is not null
  ) then
    raise exception 'Customer is in the recycle bin and cannot be bound to an order';
  end if;
  return new;
end;
$$;
revoke all on function public.reject_recycled_business_customer()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_reject_recycled_business_customer on public.business_orders;
create trigger trg_reject_recycled_business_customer
  before insert or update of customer_id on public.business_orders
  for each row execute function public.reject_recycled_business_customer();

-- ---------------------------------------------------------------------------
-- 2b. 遗留每日订单头：客户被彻底删除后只剩名称快照可留痕，允许解绑同时补快照
--     表上的 check 要求已提交/已审核的行必须有 customer_id 或名称快照，
--     只解绑不补快照会直接违反约束。
-- ---------------------------------------------------------------------------
create or replace function public.reject_legacy_daily_order_workflow_update_except_customer_detach()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if coalesce(current_setting('app.customer_purge', true), '') = 'true'
     and old.customer_id is not null
     and new.customer_id is null
     and (to_jsonb(old) - array['customer_id', 'customer_name_snapshot', 'updated_at'])
         is not distinct from
         (to_jsonb(new) - array['customer_id', 'customer_name_snapshot', 'updated_at']) then
    return new;
  end if;

  if old.customer_id is not null
     and new.customer_id is null
     and (to_jsonb(old) - 'customer_id' - 'updated_at')
         is not distinct from (to_jsonb(new) - 'customer_id' - 'updated_at')
     and not exists (
       select 1
       from public.customers
       where id = old.customer_id
     ) then
    return new;
  end if;

  raise exception 'Legacy daily-order facts are read-only; write business orders through business_orders';
end;
$$;
revoke all on function public.reject_legacy_daily_order_workflow_update_except_customer_detach()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. 回收站 RPC：移入 / 恢复 / 彻底删除
-- ---------------------------------------------------------------------------
create or replace function public.soft_delete_customers(p_customer_ids uuid[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_count int;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Approved account required';
  end if;
  if p_customer_ids is null or cardinality(p_customer_ids) = 0 then
    return 0;
  end if;
  if cardinality(p_customer_ids) > 500 then
    raise exception 'Too many customers in one request';
  end if;

  update public.customers c
  set deleted_at = now(),
      deleted_by = v_uid,
      updated_at = now()
  where c.id = any (p_customer_ids)
    and c.deleted_at is null
    and (c.created_by = v_uid or v_actor.role::text = 'admin');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.soft_delete_customers(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.soft_delete_customers(uuid[]) to authenticated;

create or replace function public.restore_customers(p_customer_ids uuid[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_count int;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Approved account required';
  end if;
  if p_customer_ids is null or cardinality(p_customer_ids) = 0 then
    return 0;
  end if;
  if cardinality(p_customer_ids) > 500 then
    raise exception 'Too many customers in one request';
  end if;

  update public.customers c
  set deleted_at = null,
      deleted_by = null,
      updated_at = now()
  where c.id = any (p_customer_ids)
    and c.deleted_at is not null
    and (c.created_by = v_uid or v_actor.role::text = 'admin');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.restore_customers(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.restore_customers(uuid[]) to authenticated;

create or replace function public.purge_customers(p_customer_ids uuid[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_ids uuid[];
  v_count int;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Approved account required';
  end if;
  if p_customer_ids is null or cardinality(p_customer_ids) = 0 then
    return 0;
  end if;
  if cardinality(p_customer_ids) > 500 then
    raise exception 'Too many customers in one request';
  end if;

  select array_agg(c.id) into v_ids
  from public.customers c
  where c.id = any (p_customer_ids)
    and c.deleted_at is not null
    and (c.created_by = v_uid or v_actor.role::text = 'admin');
  if v_ids is null then
    return 0;
  end if;

  -- 定制产品与转账是 NOT NULL 外键，删掉客户就必须连带销毁账目，宁可拒绝。
  if exists (
    select 1 from public.business_custom_products cp where cp.customer_id = any (v_ids)
  ) then
    raise exception '客户存在定制产品档案，无法彻底删除';
  end if;
  if exists (
    select 1 from public.business_customer_transfers t where t.customer_id = any (v_ids)
  ) then
    raise exception '客户存在收款转账记录，无法彻底删除';
  end if;

  -- 生命周期审计只按客户归档，解绑后仍保留订单与操作人。
  update public.business_lifecycle_audit_logs l
  set customer_id = null
  where l.customer_id = any (v_ids);

  perform set_config('app.customer_purge', 'true', true);

  -- 先主动补齐名称快照并解绑，避免外键级联把 customer_id 置空后违反
  -- fdo_workflow_customer_required_when_submitted。
  update public.finance_daily_order_workflows w
  set customer_name_snapshot = coalesce(w.customer_name_snapshot, c.name),
      customer_id = null,
      updated_at = now()
  from public.customers c
  where c.id = w.customer_id
    and c.id = any (v_ids);

  delete from public.customers c where c.id = any (v_ids);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.purge_customers(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.purge_customers(uuid[]) to authenticated;

commit;
