-- 0115 作废后的收款分摊支持重新分摊
--
-- 背景：撤回分摊后记录保留为已作废，但前端没有恢复入口；重新走「登记转账」
-- 会新增一笔转账，走 allocate_business_customer_transfer 又要求无客户订单转账
-- 本批全额分摊（而已作废的那一笔只是整笔转账的一部分），无法还原单条分摊。
-- 本迁移新增 restore_business_order_payment_allocation：把原分摊行恢复为有效，
-- 保留原转账、目标（产品行/运费/整单）与金额，并重新校验转账可用余额、
-- 目标未收与订单未收（口径与 business_apply_transfer_allocations 一致），
-- 同时对订单刷新收款状态、自增版本并写入 restore 审计。

begin;

create or replace function public.restore_business_order_payment_allocation(
  p_allocation_id uuid,
  p_reason text default null
)
returns public.business_order_payment_allocations
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_allocation public.business_order_payment_allocations%rowtype;
  v_order public.business_orders%rowtype;
  v_transfer public.business_customer_transfers%rowtype;
  v_item public.business_order_items%rowtype;
  v_old jsonb;
  v_transfer_allocated numeric;
  v_item_allocated numeric;
  v_shipping_allocated numeric;
  v_order_paid numeric;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Approved account required';
  end if;
  if char_length(coalesce(p_reason, '')) > 1000 then
    raise exception 'Restore reason cannot exceed 1000 characters';
  end if;

  select * into v_allocation
  from public.business_order_payment_allocations
  where id = p_allocation_id;
  if not found or v_allocation.voided_at is null then
    raise exception 'Voided allocation does not exist';
  end if;

  select * into v_transfer
  from public.business_customer_transfers
  where id = v_allocation.transfer_id
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

  select * into v_order
  from public.business_orders
  where id = v_allocation.order_id
  for update;
  if not found then
    raise exception 'Business order does not exist';
  end if;
  if v_order.voided_at is not null then
    raise exception 'Voided business order is immutable';
  end if;
  if v_order.closed_at is not null then
    raise exception 'Closed business order is immutable';
  end if;
  if v_order.status::text = 'completed' then
    raise exception 'Completed business order is immutable';
  end if;

  if v_actor.role::text in ('sales', 'supervisor') then
    if v_order.salesperson_id is distinct from v_uid then
      raise exception 'Sales user cannot restore another owner allocation';
    end if;
  elsif v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Role cannot restore payment allocations';
  end if;

  select coalesce(sum(a.amount), 0) into v_transfer_allocated
  from public.business_order_payment_allocations a
  where a.transfer_id = v_transfer.id and a.voided_at is null;
  if v_allocation.amount > round(v_transfer.amount - v_transfer_allocated, 4) then
    raise exception 'Allocations exceed transfer available amount';
  end if;

  if v_allocation.allocation_target = 'item' then
    select * into v_item
    from public.business_order_items i
    where i.id = v_allocation.order_item_id and i.order_id = v_order.id;
    if not found then
      raise exception 'Allocation order item does not belong to allocation order';
    end if;
    select coalesce(sum(a.amount), 0) into v_item_allocated
    from public.business_order_payment_allocations a
    join public.business_customer_transfers t on t.id = a.transfer_id
    where a.order_item_id = v_item.id
      and a.voided_at is null
      and t.voided_at is null;
    if v_allocation.amount > round(
      v_item.line_amount
      - coalesce(v_item.product_received_amount, 0)
      - v_item_allocated,
      4
    ) then
      raise exception 'Allocation exceeds order item outstanding amount';
    end if;
  elsif v_allocation.allocation_target = 'shipping' then
    select coalesce(sum(a.amount), 0) into v_shipping_allocated
    from public.business_order_payment_allocations a
    join public.business_customer_transfers t on t.id = a.transfer_id
    where a.order_id = v_order.id
      and a.allocation_target = 'shipping'
      and a.voided_at is null
      and t.voided_at is null;
    if v_allocation.amount > round(
      coalesce(v_order.shipping_fee, 0)
      - coalesce(v_order.total_shipping_received_amount, 0)
      - v_shipping_allocated,
      4
    ) then
      raise exception 'Allocation exceeds order shipping outstanding amount';
    end if;
  end if;

  select coalesce(sum(a.amount), 0) into v_order_paid
  from public.business_order_payment_allocations a
  join public.business_customer_transfers t on t.id = a.transfer_id
  where a.order_id = v_order.id
    and a.voided_at is null
    and t.voided_at is null;
  if v_allocation.amount > round(
    v_order.total_amount
    - coalesce(v_order.total_sales_amount, 0)
    - v_order_paid,
    4
  ) then
    raise exception 'Allocation exceeds order outstanding amount';
  end if;

  v_old := to_jsonb(v_allocation);
  update public.business_order_payment_allocations
  set voided_at = null, voided_by = null, void_reason = null
  where id = v_allocation.id
  returning * into v_allocation;

  perform public.business_refresh_order_payment_status(v_order.id);
  update public.business_orders bo set version = bo.version + 1 where bo.id = v_order.id;
  perform public.write_business_lifecycle_audit(
    v_order.id, v_transfer.customer_id, 'allocation', v_allocation.id,
    'restore', v_old, to_jsonb(v_allocation),
    nullif(btrim(p_reason), ''), v_uid
  );

  return v_allocation;
end;
$function$;

revoke all on function public.restore_business_order_payment_allocation(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.restore_business_order_payment_allocation(uuid, text)
  to authenticated;

commit;
