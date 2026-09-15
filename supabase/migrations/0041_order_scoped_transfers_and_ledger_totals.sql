-- 0041 订单作用域客户转账 + 台账订单总金额/未收尾款批量口径
--
-- 业务背景：
--   1. 0037 起每日订单允许不关联客户，但收款登记仍被「订单未关联客户」挡死。
--      转账新增「订单作用域」：customer_id 为空时挂在 order_id 上，凭证走
--      uid/order/<订单>/<文件>，且必须分摊到该订单本身——没有客户就没有预收款账户，
--      未分摊的余额无处可去。
--   2. 台账要显示订单总金额与未收尾款。未收尾款必须与
--      get_business_order_settlement_summary 同口径（建单实收 + 有效转账分摊），
--      而 PostgREST 内嵌 business_customer_transfers 会被客户可见性 RLS 过滤：
--      业务员能看到自己被指派的订单，却看不到别人名下的客户，内嵌为空会让未收尾款偏大。
--      所以改成一次批量 RPC，用 security definer 求值后再按 can_view_business_order 收口。

begin;

-- -----------------------------------------------------------------------------
-- 1. 转账表：customer_id 可空，新增互斥的 order_id 作用域
-- -----------------------------------------------------------------------------
alter table public.business_customer_transfers
  alter column customer_id drop not null;

alter table public.business_customer_transfers
  add column if not exists order_id uuid
    references public.business_orders(id) on delete restrict;

comment on column public.business_customer_transfers.customer_id is
  '客户作用域转账的客户；与 order_id 互斥，订单无关联客户时为空';
comment on column public.business_customer_transfers.order_id is
  '订单作用域转账挂的订单；与 customer_id 互斥，只能分摊到该订单';

alter table public.business_customer_transfers
  drop constraint if exists business_customer_transfer_scope;
alter table public.business_customer_transfers
  add constraint business_customer_transfer_scope
  check ((customer_id is not null) <> (order_id is not null));

alter table public.business_customer_transfers
  drop constraint if exists business_customer_transfer_proof_path;
alter table public.business_customer_transfers
  add constraint business_customer_transfer_proof_path check (
    -- 旧收款保留 uid/order_id/file；客户转账用 uid/customer/customer_id/file；
    -- 订单作用域转账用 uid/order/order_id/file。显式命名空间避免 UUID 碰撞导致的越权读取。
    proof_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
    or proof_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/customer/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
    or proof_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/order/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
  );

create index if not exists idx_business_customer_transfers_order_currency
  on public.business_customer_transfers (order_id, currency, received_at desc);
create index if not exists idx_business_customer_transfers_order_active
  on public.business_customer_transfers (order_id, currency)
  where voided_at is null;

-- -----------------------------------------------------------------------------
-- 2. 管理权判定：客户作用域沿用 can_manage_business_customer，
--    订单作用域用「管理员/财务，或订单自己的业务员/主管」，与分摊执行器的门禁一致。
-- -----------------------------------------------------------------------------
create or replace function public.can_manage_business_order_payments(p_order_id uuid)
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
    where bo.id = p_order_id
      and me.status::text = 'approved'
      and (
        me.role::text in ('admin', 'finance')
        or (me.role::text in ('sales', 'supervisor') and bo.salesperson_id = me.id)
      )
  );
$$;
revoke all on function public.can_manage_business_order_payments(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.can_manage_business_order_payments(uuid) to authenticated;

create or replace function public.can_manage_business_transfer(p_transfer_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.business_customer_transfers t
    where t.id = p_transfer_id
      and (
        (t.customer_id is not null and public.can_manage_business_customer(t.customer_id))
        or (t.customer_id is null and public.can_manage_business_order_payments(t.order_id))
      )
  );
$$;
revoke all on function public.can_manage_business_transfer(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.can_manage_business_transfer(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 3. RLS：订单作用域转账对能看该订单的人可见
-- -----------------------------------------------------------------------------
drop policy if exists "business_customer_transfers_select"
  on public.business_customer_transfers;
create policy "business_customer_transfers_select" on public.business_customer_transfers
  for select to authenticated
  using (
    (customer_id is not null and public.can_access_business_customer(customer_id))
    or (order_id is not null and public.can_view_business_order(order_id))
  );

-- -----------------------------------------------------------------------------
-- 4. Storage：收款凭证新增 uid/order/<订单>/<文件> 命名空间
-- -----------------------------------------------------------------------------
drop policy if exists "business_payment_proofs_insert" on storage.objects;
create policy "business_payment_proofs_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'business-payment-proofs'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (
      (
        array_length(storage.foldername(name), 1) = 2
        and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
        and exists (
          select 1 from public.business_orders bo
          join public.profiles p on p.id = (select auth.uid())
          where bo.id = ((storage.foldername(name))[2])::uuid
            and p.status::text = 'approved'
            and (
              (p.role::text in ('sales', 'supervisor')
               and bo.salesperson_id = p.id
               and bo.status::text in ('draft', 'rejected'))
              or (p.role::text in ('admin', 'finance'))
            )
        )
      )
      or
      (
        array_length(storage.foldername(name), 1) = 3
        and (storage.foldername(name))[2] = 'customer'
        and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/customer/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
        and public.can_manage_business_customer(((storage.foldername(name))[3])::uuid)
      )
      or
      (
        array_length(storage.foldername(name), 1) = 3
        and (storage.foldername(name))[2] = 'order'
        and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/order/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
        and public.can_manage_business_order_payments(((storage.foldername(name))[3])::uuid)
      )
    )
  );

drop policy if exists "business_payment_proofs_select" on storage.objects;
create policy "business_payment_proofs_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'business-payment-proofs'
    and (
      (
        array_length(storage.foldername(name), 1) = 2
        and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
        and public.can_view_business_order(((storage.foldername(name))[2])::uuid)
      )
      or
      (
        array_length(storage.foldername(name), 1) = 3
        and (storage.foldername(name))[2] = 'customer'
        and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/customer/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
        and public.can_access_business_customer(((storage.foldername(name))[3])::uuid)
      )
      or
      (
        array_length(storage.foldername(name), 1) = 3
        and (storage.foldername(name))[2] = 'order'
        and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/order/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
        and public.can_view_business_order(((storage.foldername(name))[3])::uuid)
      )
    )
  );

-- -----------------------------------------------------------------------------
-- 5. 插入触发器：订单作用域转账没有客户可校验，改由 RPC 的订单门禁负责
-- -----------------------------------------------------------------------------
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

  if tg_table_name = 'business_orders' then
    if v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
      raise exception 'Current user cannot create business orders';
    end if;
    if new.customer_id is null then
      if v_actor.role::text not in ('admin', 'finance') then
        raise exception 'Business order customer is required';
      end if;
      return new;
    end if;
  end if;

  if tg_table_name = 'business_customer_transfers' and new.customer_id is null then
    if new.order_id is null then
      raise exception 'Customer transfer requires a customer or an order';
    end if;
    if v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
      raise exception 'Role cannot record order transfers';
    end if;
    return new;
  end if;

  select created_by into v_customer_owner
  from public.customers
  where id = new.customer_id
  for share;
  if not found then
    raise exception 'Customer does not exist';
  end if;

  if tg_table_name = 'business_orders' then
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

-- -----------------------------------------------------------------------------
-- 6. 分摊执行器：订单作用域转账只能分摊到自己挂的那一单
-- -----------------------------------------------------------------------------
create or replace function public.business_apply_transfer_allocations(
  p_transfer_id uuid,
  p_allocations jsonb,
  p_actor_id uuid,
  p_correction_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transfer public.business_customer_transfers%rowtype;
  v_actor public.profiles%rowtype;
  v_item jsonb;
  v_order public.business_orders%rowtype;
  v_allocation public.business_order_payment_allocations%rowtype;
  v_order_id uuid;
  v_amount numeric;
  v_payment_type public.business_payment_type;
  v_transfer_allocated numeric;
  v_order_paid numeric;
  v_requested numeric;
  v_created jsonb := '[]'::jsonb;
begin
  select * into v_actor from public.profiles where id = p_actor_id;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Approved account required';
  end if;

  select * into v_transfer
  from public.business_customer_transfers
  where id = p_transfer_id
  for update;
  if not found then
    raise exception 'Customer transfer does not exist';
  end if;
  if v_transfer.voided_at is not null then
    raise exception 'Customer transfer is voided';
  end if;
  if not public.can_manage_business_transfer(v_transfer.id) then
    raise exception 'Customer transfer is not manageable by current user';
  end if;

  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' then
    raise exception 'Allocations must be a JSON array';
  end if;
  if char_length(coalesce(p_correction_reason, '')) > 1000 then
    raise exception 'Correction reason cannot exceed 1000 characters';
  end if;
  if jsonb_array_length(p_allocations) > 500 then
    raise exception 'Allocations cannot exceed 500';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_allocations) as x(order_id uuid, amount numeric, payment_type text)
    group by x.order_id
    having x.order_id is null or count(*) > 1
  ) then
    raise exception 'Each allocation must have a unique order_id';
  end if;

  -- 固定顺序锁住全部目标订单，避免多个转账并发分摊时死锁或超收。
  perform bo.id
  from public.business_orders bo
  join (
    select x.order_id
    from jsonb_to_recordset(p_allocations) as x(order_id uuid, amount numeric, payment_type text)
  ) requested on requested.order_id = bo.id
  order by bo.id
  for update of bo;

  if (select count(*) from jsonb_to_recordset(p_allocations)
        as x(order_id uuid, amount numeric, payment_type text))
     <> (select count(*) from public.business_orders bo
         join (select x.order_id from jsonb_to_recordset(p_allocations)
               as x(order_id uuid, amount numeric, payment_type text)) r
           on r.order_id = bo.id) then
    raise exception 'One or more allocation orders do not exist';
  end if;

  select coalesce(sum(a.amount), 0) into v_transfer_allocated
  from public.business_order_payment_allocations a
  where a.transfer_id = v_transfer.id and a.voided_at is null;

  select coalesce(sum(round(x.amount, 2)), 0) into v_requested
  from jsonb_to_recordset(p_allocations) as x(order_id uuid, amount numeric, payment_type text);
  if v_requested > v_transfer.amount - v_transfer_allocated then
    raise exception 'Allocations exceed transfer available amount';
  end if;
  if v_transfer.customer_id is null
     and (
       jsonb_array_length(p_allocations) <> 1
       or v_requested <> v_transfer.amount
     ) then
    raise exception 'Order transfer must be fully allocated to its own order';
  end if;

  for v_item in select value from jsonb_array_elements(p_allocations)
  loop
    v_order_id := nullif(v_item->>'order_id', '')::uuid;
    v_amount := round((v_item->>'amount')::numeric, 2);
    if v_amount is null or v_amount <= 0 or v_amount > 999999999999 then
      raise exception 'Allocation amount is invalid';
    end if;
    if coalesce(v_item->>'payment_type', '') not in ('', 'full', 'deposit', 'balance') then
      raise exception 'Allocation payment type is invalid';
    end if;
    v_payment_type := coalesce(
      nullif(v_item->>'payment_type', '')::public.business_payment_type,
      v_transfer.payment_type
    );

    select * into v_order from public.business_orders where id = v_order_id;
    if v_transfer.customer_id is null then
      if v_order.id is distinct from v_transfer.order_id then
        raise exception 'Order transfer can only be allocated to its own order';
      end if;
    elsif v_order.customer_id is distinct from v_transfer.customer_id then
      raise exception 'Allocation order customer does not match transfer customer';
    end if;
    if v_order.currency is distinct from v_transfer.currency then
      raise exception 'Allocation order currency does not match transfer currency';
    end if;
    if v_actor.role::text in ('sales', 'supervisor')
       and v_order.salesperson_id is distinct from p_actor_id then
      raise exception 'Sales user cannot allocate to another salesperson order';
    elsif v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
      raise exception 'Role cannot allocate customer transfers';
    end if;
    if v_order.status::text = 'completed'
       and (v_order.completion_gate_version >= 2
            or v_actor.role::text not in ('admin', 'finance')) then
      raise exception 'Completed order allocations require the legacy admin/finance correction path';
    end if;
    if v_order.status::text = 'completed'
       and v_order.completion_gate_version < 2
       and nullif(btrim(p_correction_reason), '') is null then
      raise exception 'Correction reason is required for legacy completed order allocations';
    end if;

    select coalesce(sum(a.amount), 0) into v_order_paid
    from public.business_order_payment_allocations a
    join public.business_customer_transfers t on t.id = a.transfer_id
    where a.order_id = v_order.id
      and a.voided_at is null
      and t.voided_at is null;
    if v_amount > v_order.total_amount - v_order_paid then
      raise exception 'Allocation exceeds order outstanding amount';
    end if;

    insert into public.business_order_payment_allocations (
      transfer_id, order_id, amount, payment_type, created_by
    ) values (
      v_transfer.id, v_order.id, v_amount, v_payment_type, p_actor_id
    ) returning * into v_allocation;

    perform public.business_refresh_order_payment_status(v_order.id);
    update public.business_orders set version = version + 1 where id = v_order.id;
    perform public.write_business_lifecycle_audit(
      v_order.id, v_transfer.customer_id, 'allocation', v_allocation.id,
      'create', null, to_jsonb(v_allocation),
      case when v_order.status::text = 'completed' then btrim(p_correction_reason) else null end,
      p_actor_id
    );
    v_created := v_created || jsonb_build_array(to_jsonb(v_allocation));
  end loop;

  return v_created;
end;
$$;
revoke all on function public.business_apply_transfer_allocations(uuid, jsonb, uuid, text)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 7. 登记转账 V2：p_customer_id 为空时走订单作用域
--    订单作用域要求：订单本身没有客户、币种一致、至少分摊一笔到该订单、
--    凭证路径落在 uid/order/<订单>/<文件>。
-- -----------------------------------------------------------------------------
create or replace function public.record_business_customer_transfer_v2(
  p_customer_id uuid,
  p_order_id uuid,
  p_currency public.currency_code,
  p_amount numeric,
  p_exchange_rate_to_cny numeric,
  p_received_at timestamptz,
  p_payment_type public.business_payment_type,
  p_proof_path text,
  p_notes text,
  p_correction_reason text,
  p_idempotency_key text,
  p_allocations jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_transfer public.business_customer_transfers%rowtype;
  v_existing public.business_customer_transfers%rowtype;
  v_idempotency public.business_rpc_idempotency%rowtype;
  v_hash text;
  v_allocations jsonb;
  v_result jsonb;
begin
  select * into v_actor from public.profiles where id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved business role required';
  end if;
  if (p_customer_id is null) = (p_order_id is null) then
    raise exception 'Transfer requires exactly one of customer or order';
  end if;

  if p_customer_id is not null then
    if not public.can_manage_business_customer(p_customer_id) then
      raise exception 'Customer is not manageable by current user';
    end if;
  else
    select * into v_order from public.business_orders bo where bo.id = p_order_id for update;
    if not found then
      raise exception 'Business order does not exist';
    end if;
    if v_order.customer_id is not null then
      raise exception 'Order already has a customer; record the transfer on the customer';
    end if;
    if v_order.closed_at is not null then
      raise exception 'Closed business order cannot receive transfers';
    end if;
    if not public.can_manage_business_order_payments(p_order_id) then
      raise exception 'Business order is not manageable by current user';
    end if;
    if v_order.currency is distinct from p_currency then
      raise exception 'Transfer currency does not match order currency';
    end if;
    if p_allocations is null or jsonb_typeof(p_allocations) <> 'array'
       or jsonb_array_length(p_allocations) < 1 then
      raise exception 'Order transfer must be allocated to its own order';
    end if;
  end if;

  if p_amount is null or round(p_amount, 2) <= 0 or round(p_amount, 2) > 999999999999 then
    raise exception 'Transfer amount is invalid';
  end if;
  if p_exchange_rate_to_cny is null or round(p_exchange_rate_to_cny, 8) <= 0
     or round(p_exchange_rate_to_cny, 8) > 1000000 then
    raise exception 'Exchange rate is invalid';
  end if;
  if p_currency::text = 'CNY' and round(p_exchange_rate_to_cny, 8) <> 1 then
    raise exception 'CNY exchange rate must equal one';
  end if;
  if p_received_at is null then
    raise exception 'Received time is required';
  end if;
  if nullif(btrim(p_idempotency_key), '') is null
     or char_length(btrim(p_idempotency_key)) > 200 then
    raise exception 'Idempotency key is required and cannot exceed 200 characters';
  end if;
  if char_length(coalesce(p_notes, '')) > 1000 then
    raise exception 'Transfer notes cannot exceed 1000 characters';
  end if;
  if char_length(coalesce(p_correction_reason, '')) > 1000 then
    raise exception 'Correction reason cannot exceed 1000 characters';
  end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' then
    raise exception 'Allocations must be a JSON array';
  end if;

  if nullif(btrim(p_proof_path), '') is null
     or split_part(p_proof_path, '/', 1) <> v_uid::text then
    raise exception 'Invalid transfer proof path';
  end if;
  if p_customer_id is not null then
    if p_proof_path !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/customer/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
       or split_part(p_proof_path, '/', 2) <> 'customer'
       or split_part(p_proof_path, '/', 3) <> p_customer_id::text then
      raise exception 'Invalid transfer proof path';
    end if;
  else
    if p_proof_path !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/order/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
       or split_part(p_proof_path, '/', 2) <> 'order'
       or split_part(p_proof_path, '/', 3) <> p_order_id::text then
      raise exception 'Invalid transfer proof path';
    end if;
  end if;
  if not exists (
    select 1 from storage.objects so
    where so.bucket_id = 'business-payment-proofs' and so.name = p_proof_path
  ) then
    raise exception 'Transfer proof object does not exist';
  end if;

  v_hash := encode(digest(jsonb_build_object(
    'customer_id', p_customer_id, 'order_id', p_order_id,
    'currency', p_currency::text,
    'amount', round(p_amount, 2), 'exchange_rate_to_cny', round(p_exchange_rate_to_cny, 8),
    'received_at', p_received_at, 'payment_type', p_payment_type::text,
    'proof_path', p_proof_path, 'notes', nullif(btrim(p_notes), ''),
    'correction_reason', nullif(btrim(p_correction_reason), ''),
    'allocations', p_allocations
  )::text, 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    v_uid::text || ':record_business_customer_transfer_v2:' || btrim(p_idempotency_key), 0
  ));

  select * into v_idempotency
  from public.business_rpc_idempotency
  where actor_id = v_uid
    and operation = 'record_business_customer_transfer_v2'
    and idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_idempotency.payload_hash <> v_hash then
      raise exception 'Idempotency key was already used with a different payload';
    end if;
    return v_idempotency.result;
  end if;

  select * into v_existing
  from public.business_customer_transfers
  where created_by = v_uid and idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_existing.payload_hash is distinct from v_hash then
      raise exception 'Idempotency key was already used with a different payload';
    end if;
    raise exception 'Transfer idempotency result is missing';
  end if;

  insert into public.business_customer_transfers (
    customer_id, order_id, currency, amount, exchange_rate_to_cny, received_at,
    payment_type, proof_path, notes, idempotency_key, payload_hash,
    created_by, updated_by
  ) values (
    p_customer_id, p_order_id, p_currency, round(p_amount, 2),
    round(p_exchange_rate_to_cny, 8), p_received_at,
    p_payment_type, p_proof_path, nullif(btrim(p_notes), ''),
    btrim(p_idempotency_key), v_hash, v_uid, v_uid
  ) returning * into v_transfer;

  v_allocations := public.business_apply_transfer_allocations(
    v_transfer.id, p_allocations, v_uid, p_correction_reason
  );
  perform public.write_business_lifecycle_audit(
    p_order_id, p_customer_id, 'transfer', v_transfer.id,
    'create', null, to_jsonb(v_transfer), null, v_uid
  );
  v_result := jsonb_build_object('transfer', to_jsonb(v_transfer), 'allocations', v_allocations);
  insert into public.business_rpc_idempotency (
    actor_id, operation, idempotency_key, payload_hash, result
  ) values (
    v_uid, 'record_business_customer_transfer_v2', btrim(p_idempotency_key), v_hash, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.record_business_customer_transfer_v2(
  uuid, uuid, public.currency_code, numeric, numeric, timestamptz,
  public.business_payment_type, text, text, text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.record_business_customer_transfer_v2(
  uuid, uuid, public.currency_code, numeric, numeric, timestamptz,
  public.business_payment_type, text, text, text, text, jsonb
) to authenticated;

-- 旧签名保留原语义：没有订单作用域，客户必填。
create or replace function public.record_business_customer_transfer(
  p_customer_id uuid,
  p_currency public.currency_code,
  p_amount numeric,
  p_exchange_rate_to_cny numeric,
  p_received_at timestamptz,
  p_payment_type public.business_payment_type,
  p_proof_path text,
  p_notes text,
  p_correction_reason text,
  p_idempotency_key text,
  p_allocations jsonb
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.record_business_customer_transfer_v2(
    p_customer_id, null, p_currency, p_amount, p_exchange_rate_to_cny, p_received_at,
    p_payment_type, p_proof_path, p_notes, p_correction_reason, p_idempotency_key,
    p_allocations
  );
$$;
revoke all on function public.record_business_customer_transfer(
  uuid, public.currency_code, numeric, numeric, timestamptz,
  public.business_payment_type, text, text, text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.record_business_customer_transfer(
  uuid, public.currency_code, numeric, numeric, timestamptz,
  public.business_payment_type, text, text, text, text, jsonb
) to authenticated;

-- -----------------------------------------------------------------------------
-- 8. 追加分摊与作废转账：门禁改用 can_manage_business_transfer
-- -----------------------------------------------------------------------------
create or replace function public.allocate_business_customer_transfer(
  p_transfer_id uuid,
  p_allocations jsonb,
  p_correction_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_transfer public.business_customer_transfers%rowtype;
  v_hash text;
  v_existing public.business_rpc_idempotency%rowtype;
  v_result jsonb;
begin
  select * into v_actor from public.profiles where id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved business role required';
  end if;

  select * into v_transfer
  from public.business_customer_transfers
  where id = p_transfer_id;
  if not found then
    raise exception 'Customer transfer does not exist';
  end if;
  if v_transfer.voided_at is not null then
    raise exception 'Customer transfer is voided';
  end if;
  if not public.can_manage_business_transfer(p_transfer_id) then
    raise exception 'Customer transfer is not manageable by current user';
  end if;

  if nullif(btrim(p_idempotency_key), '') is null
     or char_length(btrim(p_idempotency_key)) > 200 then
    raise exception 'Idempotency key is required and cannot exceed 200 characters';
  end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' then
    raise exception 'Allocations must be a JSON array';
  end if;
  if char_length(coalesce(p_correction_reason, '')) > 1000 then
    raise exception 'Correction reason cannot exceed 1000 characters';
  end if;

  v_hash := encode(digest(jsonb_build_object(
    'transfer_id', p_transfer_id,
    'allocations', p_allocations,
    'correction_reason', nullif(btrim(p_correction_reason), '')
  )::text, 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    v_uid::text || ':allocate_business_customer_transfer:' || btrim(p_idempotency_key), 0
  ));

  select * into v_existing
  from public.business_rpc_idempotency
  where actor_id = v_uid
    and operation = 'allocate_business_customer_transfer'
    and idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_existing.payload_hash <> v_hash then
      raise exception 'Idempotency key was already used with a different payload';
    end if;
    return v_existing.result;
  end if;

  v_result := jsonb_build_object(
    'transfer_id', p_transfer_id,
    'allocations', public.business_apply_transfer_allocations(
      p_transfer_id, p_allocations, v_uid, p_correction_reason
    )
  );
  insert into public.business_rpc_idempotency (
    actor_id, operation, idempotency_key, payload_hash, result
  ) values (
    v_uid, 'allocate_business_customer_transfer', btrim(p_idempotency_key), v_hash, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.allocate_business_customer_transfer(uuid, jsonb, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.allocate_business_customer_transfer(uuid, jsonb, text, text)
  to authenticated;

create or replace function public.void_business_customer_transfer(
  p_transfer_id uuid,
  p_reason text
)
returns public.business_customer_transfers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_transfer public.business_customer_transfers%rowtype;
  v_old jsonb;
  v_order_id uuid;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Approved account required';
  end if;
  if nullif(btrim(p_reason), '') is null or char_length(btrim(p_reason)) > 1000 then
    raise exception 'Void reason is required and cannot exceed 1000 characters';
  end if;

  select * into v_transfer from public.business_customer_transfers t
  where t.id = p_transfer_id for update;
  if not found or v_transfer.voided_at is not null then
    raise exception 'Active customer transfer does not exist';
  end if;
  if not public.can_manage_business_transfer(p_transfer_id) then
    raise exception 'Customer transfer is not manageable by current user';
  end if;

  perform bo.id
  from public.business_orders bo
  join public.business_order_payment_allocations a on a.order_id = bo.id
  where a.transfer_id = v_transfer.id and a.voided_at is null
  order by bo.id
  for update of bo;

  if exists (
    select 1
    from public.business_order_payment_allocations a
    join public.business_orders bo on bo.id = a.order_id
    where a.transfer_id = v_transfer.id
      and a.voided_at is null
      and bo.closed_at is not null
  ) then
    raise exception 'Closed business order transfers cannot be voided';
  end if;

  if exists (
    select 1
    from public.business_order_payment_allocations a
    join public.business_orders bo on bo.id = a.order_id
    where a.transfer_id = v_transfer.id
      and a.voided_at is null
      and bo.status::text = 'completed'
      and (
        bo.completion_gate_version >= 2
        or v_actor.role::text not in ('admin', 'finance')
      )
  ) then
    raise exception 'Completed order transfers require the legacy admin/finance correction path';
  end if;

  v_old := to_jsonb(v_transfer);
  update public.business_customer_transfers t
  set voided_at = now(), voided_by = v_uid, void_reason = btrim(p_reason),
      updated_by = v_uid, updated_at = now()
  where t.id = p_transfer_id returning * into v_transfer;

  for v_order_id in
    select distinct a.order_id
    from public.business_order_payment_allocations a
    where a.transfer_id = v_transfer.id and a.voided_at is null
    order by a.order_id
  loop
    perform public.business_refresh_order_payment_status(v_order_id);
    update public.business_orders bo set version = bo.version + 1 where bo.id = v_order_id;
  end loop;

  perform public.write_business_lifecycle_audit(
    v_transfer.order_id, v_transfer.customer_id, 'transfer', v_transfer.id,
    'void', v_old, to_jsonb(v_transfer), p_reason, v_uid
  );
  return v_transfer;
end;
$$;
revoke all on function public.void_business_customer_transfer(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.void_business_customer_transfer(uuid, text)
  to authenticated;

-- -----------------------------------------------------------------------------
-- 9. 台账批量未收尾款：与 get_business_order_settlement_summary 同口径，
--    一次调用覆盖整页订单，避免 PostgREST 内嵌转账被客户可见性 RLS 过滤。
-- -----------------------------------------------------------------------------
create or replace function public.get_business_orders_outstanding_amount(p_order_ids uuid[])
returns table (order_id uuid, outstanding_amount numeric)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if coalesce(array_length(p_order_ids, 1), 0) > 1000 then
    raise exception 'Too many orders requested';
  end if;
  return query
  select bo.id,
         greatest(
           bo.total_amount
             - coalesce(bo.total_sales_amount, 0)
             - coalesce(pay.amount, 0),
           0
         )
  from public.business_orders bo
  left join lateral (
    select sum(a.amount) as amount
    from public.business_order_payment_allocations a
    join public.business_customer_transfers t on t.id = a.transfer_id
    where a.order_id = bo.id
      and a.voided_at is null
      and t.voided_at is null
  ) pay on true
  where bo.id = any (coalesce(p_order_ids, array[]::uuid[]))
    and public.can_view_business_order(bo.id);
end;
$$;
revoke all on function public.get_business_orders_outstanding_amount(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.get_business_orders_outstanding_amount(uuid[])
  to authenticated;

commit;
