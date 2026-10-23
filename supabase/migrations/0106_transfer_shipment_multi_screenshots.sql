-- 0106 转账收款截图改为可选并支持多张；发货批次截图支持多张
--
-- 业务背景：
--   1. 登记客户转账时截图常常拿不到（先转账后补凭证），且一笔转账可能附多张
--      支付截图；发货批次同理可能附多张物流截图。
--   2. 沿用 0103 的最小侵入方案：首图留在原列（proof_path / screenshot_path，
--      其中 proof_path 去掉 NOT NULL），第 2 张起进新增数组列
--      （extra_proof_paths / extra_screenshot_paths），全部历史读取面
--      （select proof_path / screenshot_path 的视图、导出、RPC）零改动。
--   3. 路径合法性仍由两个 v2 RPC 逐张校验（uid 归属 + 命名空间 + storage 对象存在），
--      与 0103 对 screenshot_path 只在 RPC 校验的做法一致，不新增表级 CHECK。
--   4. 两个 RPC 均为 drop 旧签名 + create 新签名（末参带默认值）：12 参数的
--      旧式调用（含 0041 的 legacy 包装函数 record_business_customer_transfer，
--      SQL 语言后期绑定）不受影响。
--
-- 幂等性：drop not null / add column if not exists / drop+create 函数，可重复执行。

begin;

-- -----------------------------------------------------------------------------
-- 1. 转账收款截图：proof_path 可空（首图），新增附加凭证数组列
-- -----------------------------------------------------------------------------
alter table public.business_customer_transfers
  alter column proof_path drop not null;

alter table public.business_customer_transfers
  add column if not exists extra_proof_paths text[] not null default '{}';

comment on column public.business_customer_transfers.proof_path is
  'business-payment-proofs 私有 bucket 内的首张凭证 object name；未上传凭证时为空';
comment on column public.business_customer_transfers.extra_proof_paths is
  '第 2 张起的附加凭证路径数组，命名空间与 proof_path 一致（uid/customer/<cid>/<uuid>.ext 或 uid/order/<oid>/<uuid>.ext）';

-- -----------------------------------------------------------------------------
-- 2. 发货批次：新增附加截图数组列
-- -----------------------------------------------------------------------------
alter table public.business_order_shipments
  add column if not exists extra_screenshot_paths text[] not null default '{}';

comment on column public.business_order_shipments.extra_screenshot_paths is
  'business-shipment-screenshots 私有 bucket 内第 2 张起的截图路径数组（uid/<订单ID>/<uuid>.ext）';

-- -----------------------------------------------------------------------------
-- 3. 登记转账 RPC：收款凭证可空 + 附加凭证（最多 10 张）
-- -----------------------------------------------------------------------------
drop function if exists public.record_business_customer_transfer_v2(
  uuid, uuid, public.currency_code, numeric, numeric, timestamptz,
  public.business_payment_type, text, text, text, text, jsonb
);

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
  p_allocations jsonb,
  p_extra_proof_paths jsonb default null
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
  v_extra_proof_paths text[] := '{}'::text[];
  v_path text;
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

  -- 首张凭证：留空（NULL/空白）表示未上传，改为合法输入。
  if nullif(btrim(coalesce(p_proof_path, '')), '') is null then
    p_proof_path := null;
  else
    if split_part(p_proof_path, '/', 1) <> v_uid::text then
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
  end if;

  -- 附加凭证：逐张按首图同款规则校验，禁止与首图或彼此重复，合计最多 10 张。
  if p_extra_proof_paths is not null then
    if jsonb_typeof(p_extra_proof_paths) is distinct from 'array' then
      raise exception 'Invalid transfer proof path';
    end if;
    for v_path in
      select btrim(e.value #>> '{}')
      from jsonb_array_elements(p_extra_proof_paths) as e(value)
    loop
      if nullif(v_path, '') is null
         or split_part(v_path, '/', 1) <> v_uid::text
         or v_path is not distinct from coalesce(p_proof_path, '')
         or v_path = any (v_extra_proof_paths) then
        raise exception 'Invalid transfer proof path';
      end if;
      if p_customer_id is not null then
        if v_path !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/customer/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
           or split_part(v_path, '/', 2) <> 'customer'
           or split_part(v_path, '/', 3) <> p_customer_id::text then
          raise exception 'Invalid transfer proof path';
        end if;
      else
        if v_path !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/order/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
           or split_part(v_path, '/', 2) <> 'order'
           or split_part(v_path, '/', 3) <> p_order_id::text then
          raise exception 'Invalid transfer proof path';
        end if;
      end if;
      if not exists (
        select 1 from storage.objects so
        where so.bucket_id = 'business-payment-proofs' and so.name = v_path
      ) then
        raise exception 'Transfer proof object does not exist';
      end if;
      v_extra_proof_paths := v_extra_proof_paths || v_path;
    end loop;
    if array_length(v_extra_proof_paths, 1) > 9 then
      raise exception 'Transfer cannot have more than 10 proof images';
    end if;
  end if;

  v_hash := encode(digest(jsonb_build_object(
    'customer_id', p_customer_id, 'order_id', p_order_id,
    'currency', p_currency::text,
    'amount', round(p_amount, 2), 'exchange_rate_to_cny', v_rate,
    'received_at', p_received_at, 'payment_type', p_payment_type::text,
    'proof_path', p_proof_path, 'extra_proof_paths', to_jsonb(v_extra_proof_paths),
    'notes', nullif(btrim(p_notes), ''),
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
    payment_type, proof_path, extra_proof_paths, notes, idempotency_key, payload_hash,
    created_by, updated_by
  ) values (
    p_customer_id, p_order_id, p_currency, round(p_amount, 2),
    v_rate, p_received_at,
    p_payment_type, p_proof_path, v_extra_proof_paths, nullif(btrim(p_notes), ''),
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
  public.business_payment_type, text, text, text, text, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.record_business_customer_transfer_v2(
  uuid, uuid, public.currency_code, numeric, numeric, timestamptz,
  public.business_payment_type, text, text, text, text, jsonb, jsonb
) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. 发货批次 RPC：附加截图（合计最多 10 张）
-- -----------------------------------------------------------------------------
drop function if exists public.create_business_order_shipment_v2(
  uuid, timestamptz, text, text, jsonb, text, boolean, text, text
);

create or replace function public.create_business_order_shipment_v2(
  p_order_id uuid,
  p_shipped_at timestamptz,
  p_tracking_number text,
  p_notes text,
  p_items jsonb,
  p_idempotency_key text,
  p_allow_overship boolean,
  p_overship_reason text,
  p_screenshot_path text,
  p_extra_screenshot_paths jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := (select auth.uid());
  v_result jsonb;
  v_shipment_id uuid;
  v_extra_screenshot_paths text[] := '{}'::text[];
  v_path text;
begin
  if not public.has_current_permission('orders.ship') then
    raise exception 'Current account does not have shipment permission';
  end if;

  if p_screenshot_path is not null then
    if p_screenshot_path !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$'
       or (storage.foldername(p_screenshot_path))[1] is distinct from v_uid::text
       or ((storage.foldername(p_screenshot_path))[2])::uuid is distinct from p_order_id
    then
      raise exception 'Invalid shipment screenshot path';
    end if;
  end if;

  -- 附加截图：逐张按首图同款规则校验，禁止与首图或彼此重复，合计最多 10 张。
  if p_extra_screenshot_paths is not null then
    if jsonb_typeof(p_extra_screenshot_paths) is distinct from 'array' then
      raise exception 'Invalid shipment screenshot path';
    end if;
    for v_path in
      select btrim(e.value #>> '{}')
      from jsonb_array_elements(p_extra_screenshot_paths) as e(value)
    loop
      if nullif(v_path, '') is null
         or v_path !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$'
         or (storage.foldername(v_path))[1] is distinct from v_uid::text
         or ((storage.foldername(v_path))[2])::uuid is distinct from p_order_id
         or v_path is not distinct from coalesce(p_screenshot_path, '')
         or v_path = any (v_extra_screenshot_paths)
      then
        raise exception 'Invalid shipment screenshot path';
      end if;
      v_extra_screenshot_paths := v_extra_screenshot_paths || v_path;
    end loop;
    if array_length(v_extra_screenshot_paths, 1) > 9 then
      raise exception 'Shipment cannot have more than 10 screenshot images';
    end if;
  end if;

  v_result := public.create_business_order_shipment_internal_0057(
    p_order_id, p_shipped_at, p_tracking_number, p_notes, p_items,
    p_idempotency_key, p_allow_overship, p_overship_reason
  );
  v_shipment_id := (v_result -> 'shipment' ->> 'id')::uuid;
  if v_shipment_id is not null then
    update public.business_order_shipments
    set screenshot_path = p_screenshot_path,
        extra_screenshot_paths = v_extra_screenshot_paths
    where id = v_shipment_id;
  end if;
  return case
    when v_shipment_id is not null
      then jsonb_set(
             jsonb_set(v_result, '{shipment,screenshot_path}', to_jsonb(p_screenshot_path)),
             '{shipment,extra_screenshot_paths}',
             to_jsonb(v_extra_screenshot_paths)
           )
    else v_result
  end;
end;
$$;

revoke all on function public.create_business_order_shipment_v2(
  uuid, timestamptz, text, text, jsonb, text, boolean, text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.create_business_order_shipment_v2(
  uuid, timestamptz, text, text, jsonb, text, boolean, text, text, jsonb
) to authenticated;

commit;
