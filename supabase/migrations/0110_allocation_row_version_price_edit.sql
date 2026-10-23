-- 0110 分摊行放开版本与单价锁
-- 已有有效收款分摊的定制产品行：允许切到同一产品的新版本（编码/图片随之同步）
-- 并允许修改销售单价；产品身份（custom_product_id / source_type / product_id）
-- 与数量下限（不低于已发数量）仍然锁死。订单总额不得低于已分摊金额的后盾校验
-- 继续由建单/改单函数（0028/0099/0101）兜底。

create or replace function public.protect_business_order_item_invariants()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_order public.business_orders%rowtype;
  v_has_allocation boolean;
  v_has_shipment boolean;
  v_net_shipped numeric;
begin
  select * into v_order
  from public.business_orders
  where id = case when tg_op = 'INSERT' then new.order_id else old.order_id end;

  if not found then
    raise exception 'Business order does not exist';
  end if;
  if v_order.voided_at is not null then
    raise exception 'Voided business order items are immutable';
  end if;
  if v_order.status::text = 'completed' or v_order.closed_at is not null then
    raise exception 'Completed or closed order items are immutable';
  end if;

  if tg_op = 'INSERT' then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.order_id is distinct from old.order_id then
    raise exception 'Order item cannot be moved to another order';
  end if;

  select exists (
    select 1
    from public.business_order_payment_allocations a
    join public.business_customer_transfers t on t.id = a.transfer_id
    where a.order_id = old.order_id
      and a.voided_at is null
      and t.voided_at is null
  ) into v_has_allocation;
  select exists (
    select 1
    from public.business_order_shipment_items si
    join public.business_order_shipments s on s.id = si.shipment_id
    where si.order_item_id = old.id and s.voided_at is null
  ) into v_has_shipment;

  v_net_shipped := public.business_order_item_net_shipped(old.id);

  if tg_op = 'DELETE' then
    if v_has_allocation then
      raise exception 'Order items cannot be deleted after an active payment allocation';
    end if;
    if v_has_shipment then
      raise exception 'Shipped order items cannot be deleted';
    end if;
    return old;
  end if;

  if v_has_allocation and (
    new.source_type is distinct from old.source_type
    or new.product_id is distinct from old.product_id
    or new.custom_product_id is distinct from old.custom_product_id
  ) then
    raise exception 'Order item product cannot be replaced after an active payment allocation';
  end if;
  if v_has_shipment and (
    new.source_type is distinct from old.source_type
    or new.product_id is distinct from old.product_id
    or new.custom_product_id is distinct from old.custom_product_id
    or new.custom_product_version_id is distinct from old.custom_product_version_id
  ) then
    raise exception 'Shipped order item product cannot be replaced';
  end if;
  if new.quantity < v_net_shipped then
    raise exception 'Order item quantity cannot be less than net shipped quantity';
  end if;

  return new;
end;
$$;
revoke all on function public.protect_business_order_item_invariants()
  from public, anon, authenticated, service_role;
