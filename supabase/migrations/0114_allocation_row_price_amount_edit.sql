-- 0114 已有分摊的明细行放开数量、单价与金额编辑
--
-- 背景：0110 已在 protect_business_order_item_invariants 中允许分摊行调整单价，
-- 但 get_business_order_edit_constraints 仍按 v_allocated = 0 判断
-- can_change_unit_price，前端据此把销售单价输入框禁用，与 0110 的触发器和
-- 「可调整单价」提示不一致。
-- 本次仅放开该标志：分摊行仍锁定产品身份（source_type/product_id/custom_product_id）
-- 与删除；数量继续由触发器限制不低于净已发货数量；订单总额不得低于有效分摊金额
-- 仍由 protect_business_order_allocation_invariants 兜底。

begin;

create or replace function public.get_business_order_edit_constraints(p_order_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_order public.business_orders%rowtype;
  v_actor public.profiles%rowtype;
  v_allocated numeric;
  v_shipped_value numeric;
  v_can_adjust boolean;
  v_items jsonb;
begin
  if not public.can_view_business_order(p_order_id) then
    raise exception 'Business order is not accessible';
  end if;
  select * into v_order from public.business_orders bo where bo.id = p_order_id;
  if not found then raise exception 'Business order does not exist'; end if;
  select * into v_actor from public.profiles p where p.id = (select auth.uid());

  select coalesce(sum(a.amount), 0) into v_allocated
  from public.business_order_payment_allocations a
  join public.business_customer_transfers t on t.id = a.transfer_id
  where a.order_id = p_order_id and a.voided_at is null and t.voided_at is null;

  select coalesce(sum(round(public.business_order_item_net_shipped(i.id) * i.unit_price, 4)), 0)
    into v_shipped_value
  from public.business_order_items i
  where i.order_id = p_order_id;

  v_can_adjust := v_order.voided_at is null
    and v_order.status::text = 'approved'
    and v_order.approval_status = 'approved'
    and v_order.closed_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
    'order_item_id', i.id,
    'source_type', i.source_type,
    'product_id', i.product_id,
    'custom_product_id', i.custom_product_id,
    'custom_product_version_id', i.custom_product_version_id,
    'ordered_quantity', i.quantity,
    'unit_price', i.unit_price,
    'gross_shipped_quantity', coalesce(q.gross_shipped, 0),
    'returned_quantity', coalesce(q.returned, 0),
    'net_shipped_quantity', coalesce(q.gross_shipped, 0) - coalesce(q.returned, 0),
    'minimum_quantity', coalesce(q.gross_shipped, 0) - coalesce(q.returned, 0),
    'can_delete', v_order.voided_at is null and v_order.status::text <> 'completed'
                  and v_order.closed_at is null and v_allocated = 0
                  and coalesce(q.gross_shipped, 0) = 0,
    'can_replace_product', v_order.voided_at is null and v_order.status::text <> 'completed'
                           and v_order.closed_at is null and v_allocated = 0
                           and coalesce(q.gross_shipped, 0) = 0,
    'can_change_unit_price', v_order.voided_at is null and v_order.status::text <> 'completed'
                             and v_order.closed_at is null,
    'can_increase_quantity', v_can_adjust
  ) order by i.sort_order, i.id), '[]'::jsonb) into v_items
  from public.business_order_items i
  left join lateral (
    select
      coalesce(sum(si.quantity) filter (where s.voided_at is null), 0) as gross_shipped,
      coalesce((select sum(ri.quantity)
                from public.business_order_return_items ri
                join public.business_order_returns r on r.id = ri.return_id
                join public.business_order_shipment_items source_si on source_si.id = ri.shipment_item_id
                join public.business_order_shipments source_s on source_s.id = source_si.shipment_id
                where ri.order_item_id = i.id and r.voided_at is null
                  and source_s.voided_at is null), 0) as returned
    from public.business_order_shipment_items si
    join public.business_order_shipments s on s.id = si.shipment_id
    where si.order_item_id = i.id
  ) q on true
  where i.order_id = p_order_id;

  return jsonb_build_object(
    'order_id', v_order.id,
    'version', v_order.version,
    'status', v_order.status::text,
    'is_closed', v_order.closed_at is not null,
    'is_completed', v_order.status::text = 'completed',
    'is_voided', v_order.voided_at is not null,
    'voided_at', v_order.voided_at,
    'voided_by', v_order.voided_by,
    'void_reason', v_order.void_reason,
    'has_active_allocation', v_allocated > 0,
    'active_allocated_amount', v_allocated,
    'daily_received_amount', v_order.total_sales_amount,
    'items_subtotal', v_order.items_subtotal,
    'shipping_fee', v_order.shipping_fee,
    'total_amount', v_order.total_amount,
    'shipped_value', v_shipped_value,
    'available_balance', round(v_allocated - v_shipped_value, 4),
    'can_edit_order', public.business_order_accepts_entry_edits(
      v_order.id, coalesce(v_actor.role::text, '')
    ),
    'can_adjust_items', v_can_adjust,
    'can_overship', v_can_adjust,
    'can_add_allocation', v_order.voided_at is null
                          and v_order.status::text <> 'completed'
                          and v_order.closed_at is null,
    'can_add_shipment', v_order.voided_at is null
                        and v_order.status::text = 'approved'
                        and v_order.approval_status = 'approved'
                        and v_order.closed_at is null,
    'items', v_items
  );
end;
$function$;

commit;
