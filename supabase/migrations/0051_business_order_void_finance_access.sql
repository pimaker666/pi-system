begin;

create or replace function public.void_business_order(
  p_order_id uuid,
  p_expected_version int,
  p_reason text,
  p_idempotency_key text
)
returns public.business_orders
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_allocation public.business_order_payment_allocations%rowtype;
  v_idempotency public.business_rpc_idempotency%rowtype;
  v_old_order jsonb;
  v_old_allocation jsonb;
  v_transfer_customer_id uuid;
  v_hash text;
  v_result jsonb;
begin
  perform set_config('app.void_business_order_rpc', 'true', true);

  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found
     or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Approved administrator or finance user required to void a business order';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null
     or char_length(btrim(p_reason)) > 1000 then
    raise exception 'Order void reason is required and cannot exceed 1000 characters';
  end if;
  if nullif(btrim(coalesce(p_idempotency_key, '')), '') is null
     or char_length(btrim(p_idempotency_key)) > 200 then
    raise exception 'Idempotency key is invalid';
  end if;

  v_hash := encode(digest(jsonb_build_object(
    'order_id', p_order_id,
    'expected_version', p_expected_version,
    'reason', btrim(p_reason)
  )::text, 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    v_uid::text || ':void_business_order:' || btrim(p_idempotency_key), 0
  ));

  select * into v_idempotency
  from public.business_rpc_idempotency
  where actor_id = v_uid
    and operation = 'void_business_order'
    and idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_idempotency.payload_hash <> v_hash then
      raise exception 'Idempotency key was already used with a different payload';
    end if;
    select * into v_order
    from jsonb_populate_record(null::public.business_orders, v_idempotency.result);
    return v_order;
  end if;

  select * into v_order
  from public.business_orders bo
  where bo.id = p_order_id
  for update;
  if not found then
    raise exception 'Business order does not exist';
  end if;
  if v_order.version <> p_expected_version then
    raise exception 'Business order version conflict';
  end if;
  if v_order.voided_at is not null then
    raise exception 'Business order is already voided';
  end if;

  v_old_order := to_jsonb(v_order);

  for v_allocation in
    select a.*
    from public.business_order_payment_allocations a
    where a.order_id = v_order.id and a.voided_at is null
    order by a.id
    for update
  loop
    v_old_allocation := to_jsonb(v_allocation);
    select t.customer_id into v_transfer_customer_id
    from public.business_customer_transfers t
    where t.id = v_allocation.transfer_id;

    update public.business_order_payment_allocations a
    set voided_at = now(),
        voided_by = v_uid,
        void_reason = btrim(p_reason)
    where a.id = v_allocation.id
    returning * into v_allocation;

    perform public.write_business_lifecycle_audit(
      v_order.id, v_transfer_customer_id, 'allocation', v_allocation.id,
      'void', v_old_allocation, to_jsonb(v_allocation), btrim(p_reason), v_uid
    );
  end loop;

  perform public.business_refresh_order_payment_status(v_order.id);

  update public.business_orders bo
  set voided_at = now(),
      voided_by = v_uid,
      void_reason = btrim(p_reason),
      version = bo.version + 1
  where bo.id = v_order.id
  returning * into v_order;

  perform public.write_business_order_audit(
    v_order.id, 'order', v_order.id, 'update'::public.business_audit_action,
    (v_old_order->>'status')::public.business_order_status, v_order.status,
    v_old_order, to_jsonb(v_order), btrim(p_reason), v_uid
  );
  perform public.write_business_lifecycle_audit(
    v_order.id, v_order.customer_id, 'order_void', v_order.id,
    'void', v_old_order, to_jsonb(v_order), btrim(p_reason), v_uid
  );

  v_result := to_jsonb(v_order);
  insert into public.business_rpc_idempotency (
    actor_id, operation, idempotency_key, payload_hash, result
  ) values (
    v_uid, 'void_business_order', btrim(p_idempotency_key), v_hash, v_result
  );

  return v_order;
end;
$$;

revoke all on function public.void_business_order(uuid, int, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.void_business_order(uuid, int, text, text)
  to authenticated;

comment on function public.void_business_order(uuid, int, text, text) is
  '作废订单：仅已审批管理员或财务可执行，作废有效收款分摊并保留客户转账和完整审计。';

commit;
