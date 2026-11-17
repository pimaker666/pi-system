-- 0150_cleanup_inactive_lifecycle_on_item_delete.sql
-- 删除产品行时，清理该行上「已作废」的发货/退货明细，否则外键 RESTRICT 会拦住删行；
-- 有效发货或有效退货仍然照旧拦截，不作放宽。
--   1. prevent_business_order_return_item_mutation：退货单已作废时允许删除其明细行（仅 DELETE；UPDATE 仍禁止）。
--   2. protect_business_order_item_invariants：DELETE 分支在放行前清理指向本行的失效发货/退货明细并写订单审计。
--      顺序必须先删退货明细再删发货明细（退货明细外键指向发货明细）。
-- 说明：失效发货/退货的批次与退货单头保留，作为已作废历史；明细随产品行一并清除。

begin;

create or replace function public.prevent_business_order_return_item_mutation()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if tg_op = 'DELETE' then
    if exists (
      select 1
      from public.business_order_returns r
      where r.id = old.return_id
        and r.voided_at is not null
    ) then
      return old;
    end if;
  end if;
  raise exception 'Business order return items are immutable';
end;
$function$;

create or replace function public.protect_business_order_item_invariants()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_order public.business_orders%rowtype;
  v_has_allocation boolean;
  v_has_shipment boolean;
  v_net_shipped numeric;
  v_dead_returns integer := 0;
  v_dead_shipments integer := 0;
  v_actor_id uuid := (select auth.uid());
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
    where a.order_item_id = old.id
      and a.allocation_target = 'item'
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

    delete from public.business_order_return_items rt
    where rt.order_item_id = old.id
      and exists (
        select 1
        from public.business_order_returns r
        where r.id = rt.return_id and r.voided_at is not null
      );
    get diagnostics v_dead_returns = row_count;

    delete from public.business_order_shipment_items si
    where si.order_item_id = old.id
      and exists (
        select 1
        from public.business_order_shipments s
        where s.id = si.shipment_id and s.voided_at is not null
      );
    get diagnostics v_dead_shipments = row_count;

    if v_actor_id is not null and (v_dead_returns + v_dead_shipments) > 0 then
      perform public.write_business_order_audit(
        old.order_id, 'item', old.id, 'update',
        v_order.status, v_order.status,
        jsonb_build_object(
          'removed_return_items', v_dead_returns,
          'removed_shipment_items', v_dead_shipments
        ),
        '{}'::jsonb,
        'Order item removed; inactive shipment/return records cleaned',
        v_actor_id
      );
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
$function$;

commit;
