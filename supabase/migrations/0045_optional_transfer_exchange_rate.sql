-- 0045 登记客户转账时兑人民币汇率改为选填
--
-- 业务背景：
--   1. 与 0040 订单汇率选填同款诉求：转账登记时常常还拿不到实际结汇汇率，
--      被迫填占位汇率会污染人民币口径。留空落 NULL：get_finance_summary 的
--      sum(amount * exchange_rate_to_cny) 会忽略 NULL 行、前端业绩用 ?? 0，
--      该笔转账暂不参与人民币折算，与订单级 NULL 语义一致。
--   2. CHECK 约束对 NULL 判 NULL（不为 false），区间检查与 CNY=1 检查均无需重建，
--      只需去掉 NOT NULL。
--   3. CNY 转账在 RPC 内仍按 1 落库（留空视作 1），保证 CNY 口径永远不缺汇率；
--      非 CNY 转账允许 NULL。显式传入的非法汇率（<=0 / >1000000 / CNY 非 1）照旧报错。
--
-- 幂等性：本迁移只做 drop not null（可重复执行）与 create or replace 函数，
-- 不做数据回填，重复执行结果一致。

begin;

-- -----------------------------------------------------------------------------
-- 1. 转账表汇率非必填：仅去掉 NOT NULL，CHECK 约束对 NULL 自动放行
-- -----------------------------------------------------------------------------
alter table public.business_customer_transfers
  alter column exchange_rate_to_cny drop not null;

comment on column public.business_customer_transfers.exchange_rate_to_cny is
  '兑人民币汇率，非必填；为空时该笔转账不参与人民币折算（CNY 转账仍按 1 落库）';

-- -----------------------------------------------------------------------------
-- 2. 登记转账 RPC：汇率守卫允许 NULL；CNY 留空按 1 落库
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
  v_rate numeric;
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
  if p_exchange_rate_to_cny is not null and (
       round(p_exchange_rate_to_cny, 8) <= 0
       or round(p_exchange_rate_to_cny, 8) > 1000000
     ) then
    raise exception 'Exchange rate is invalid';
  end if;
  if p_currency::text = 'CNY' and p_exchange_rate_to_cny is not null
     and round(p_exchange_rate_to_cny, 8) <> 1 then
    raise exception 'CNY exchange rate must equal one';
  end if;
  -- CNY 留空按 1 落库，其余币种留空落 NULL。
  v_rate := case
    when p_currency::text = 'CNY' then round(coalesce(p_exchange_rate_to_cny, 1), 8)
    else round(p_exchange_rate_to_cny, 8)
  end;
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
    'amount', round(p_amount, 2), 'exchange_rate_to_cny', v_rate,
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
    v_rate, p_received_at,
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

commit;
