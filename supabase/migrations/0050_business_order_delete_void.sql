-- 0050 业务订单删除与作废
--
-- 无业务事实的误建草稿单可物理删除；一旦存在业务事实，只能作废。
-- 作废保留全部历史，但撤销订单的有效付款分摊，不作废客户转账本身。

begin;

-- -----------------------------------------------------------------------------
-- 1. 作废状态与审计类型
-- -----------------------------------------------------------------------------
alter table public.business_orders
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references public.profiles(id) on delete set null,
  add column if not exists void_reason text;

alter table public.business_orders
  drop constraint if exists business_orders_void_actor;
alter table public.business_orders
  add constraint business_orders_void_actor check (
    (voided_at is null and voided_by is null and void_reason is null)
    or (
      voided_at is not null
      and voided_by is not null
      and nullif(btrim(void_reason), '') is not null
      and char_length(void_reason) <= 1000
    )
  );

comment on column public.business_orders.voided_at is
  '订单作废时间；作废与工作流状态正交，保留原状态和全部业务事实。';
comment on column public.business_orders.voided_by is
  '作废订单的已审批管理员。';
comment on column public.business_orders.void_reason is
  '订单作废原因，作废时必填。';

create index if not exists idx_business_orders_active_status_date
  on public.business_orders (status, order_date desc)
  where voided_at is null;
create index if not exists idx_business_orders_active_sales_status_date
  on public.business_orders (salesperson_id, status, order_date desc)
  where voided_at is null;

alter table public.business_lifecycle_audit_logs
  drop constraint if exists business_lifecycle_audit_logs_entity_type_check;
alter table public.business_lifecycle_audit_logs
  add constraint business_lifecycle_audit_logs_entity_type_check check (
    entity_type in (
      'custom_product', 'custom_product_version', 'transfer', 'allocation',
      'shipment', 'return', 'closure', 'order_void'
    )
  );

create or replace function public.write_business_lifecycle_audit(
  p_order_id uuid,
  p_customer_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_action text,
  p_old_data jsonb,
  p_new_data jsonb,
  p_reason text,
  p_actor_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
begin
  if p_entity_type not in (
    'custom_product', 'custom_product_version', 'transfer', 'allocation',
    'shipment', 'return', 'closure', 'order_void'
  ) then
    raise exception 'Invalid lifecycle audit entity type';
  end if;
  if char_length(coalesce(p_action, '')) not between 1 and 100 then
    raise exception 'Invalid lifecycle audit action';
  end if;
  if char_length(coalesce(p_reason, '')) > 1000 then
    raise exception 'Audit reason cannot exceed 1000 characters';
  end if;

  select * into v_actor from public.profiles where id = p_actor_id;
  if not found then
    raise exception 'Audit actor does not exist';
  end if;

  insert into public.business_lifecycle_audit_logs (
    order_id, customer_id, entity_type, entity_id, action,
    old_data, new_data, reason, actor_id, actor_snapshot
  ) values (
    p_order_id, p_customer_id, p_entity_type, p_entity_id, p_action,
    p_old_data, p_new_data, nullif(btrim(p_reason), ''), p_actor_id,
    jsonb_build_object(
      'id', v_actor.id,
      'email', v_actor.email,
      'full_name', coalesce(nullif(btrim(v_actor.chinese_name), ''), v_actor.full_name),
      'role', v_actor.role::text
    )
  );
end;
$$;
revoke all on function public.write_business_lifecycle_audit(
  uuid, uuid, text, uuid, text, jsonb, jsonb, text, uuid
) from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. 统一冻结作废订单的后续写入
-- -----------------------------------------------------------------------------
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
    or new.custom_product_version_id is distinct from old.custom_product_version_id
  ) then
    raise exception 'Order item product cannot be replaced after an active payment allocation';
  end if;
  if v_has_allocation and new.unit_price is distinct from old.unit_price then
    raise exception 'Order item price cannot be changed after an active payment allocation';
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

create or replace function public.prevent_closed_order_new_lifecycle_rows()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_order public.business_orders%rowtype;
begin
  select * into v_order from public.business_orders where id = new.order_id;
  if not found then
    raise exception 'Business order does not exist';
  end if;
  if v_order.voided_at is not null then
    raise exception 'Voided business order cannot receive new allocations or shipments';
  end if;
  if v_order.status::text = 'completed' then
    raise exception 'Completed business order is immutable';
  end if;
  if v_order.closed_at is not null then
    raise exception 'Closed business order cannot receive new allocations or shipments';
  end if;
  return new;
end;
$$;
revoke all on function public.prevent_closed_order_new_lifecycle_rows()
  from public, anon, authenticated, service_role;

create or replace function public.prevent_voided_order_row_write()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_order_id uuid := coalesce(new.order_id, old.order_id);
begin
  if v_order_id is not null and exists (
    select 1 from public.business_orders bo
    where bo.id = v_order_id and bo.voided_at is not null
  ) then
    raise exception 'Voided business order records are immutable';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function public.prevent_voided_order_row_write()
  from public, anon, authenticated, service_role;

create or replace function public.prevent_voided_finance_order_cost_write()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_order_id uuid := coalesce(new.business_order_id, old.business_order_id);
begin
  if v_order_id is not null and exists (
    select 1 from public.business_orders bo
    where bo.id = v_order_id and bo.voided_at is not null
  ) then
    raise exception 'Voided business order costs are immutable';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function public.prevent_voided_finance_order_cost_write()
  from public, anon, authenticated, service_role;

create or replace function public.prevent_voided_order_item_cost_override_write()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_item_id uuid := coalesce(new.business_order_item_id, old.business_order_item_id);
begin
  if exists (
    select 1
    from public.business_order_items i
    join public.business_orders bo on bo.id = i.order_id
    where i.id = v_item_id and bo.voided_at is not null
  ) then
    raise exception 'Voided business order costs are immutable';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function public.prevent_voided_order_item_cost_override_write()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_prevent_voided_order_allocation_write
  on public.business_order_payment_allocations;
create trigger trg_prevent_voided_order_allocation_write
  before insert or update or delete on public.business_order_payment_allocations
  for each row execute function public.prevent_voided_order_row_write();

drop trigger if exists trg_prevent_voided_order_shipment_write
  on public.business_order_shipments;
create trigger trg_prevent_voided_order_shipment_write
  before insert or update or delete on public.business_order_shipments
  for each row execute function public.prevent_voided_order_row_write();

drop trigger if exists trg_prevent_voided_order_return_write
  on public.business_order_returns;
create trigger trg_prevent_voided_order_return_write
  before insert or update or delete on public.business_order_returns
  for each row execute function public.prevent_voided_order_row_write();

drop trigger if exists trg_prevent_voided_order_attachment_write
  on public.business_order_attachments;
create trigger trg_prevent_voided_order_attachment_write
  before insert or update or delete on public.business_order_attachments
  for each row execute function public.prevent_voided_order_row_write();

drop trigger if exists trg_prevent_voided_order_finance_detail_write
  on public.business_order_finance_details;
create trigger trg_prevent_voided_order_finance_detail_write
  before insert or update or delete on public.business_order_finance_details
  for each row execute function public.prevent_voided_order_row_write();

drop trigger if exists trg_prevent_voided_order_amount_revision_write
  on public.business_order_amount_revisions;
create trigger trg_prevent_voided_order_amount_revision_write
  before insert or update or delete on public.business_order_amount_revisions
  for each row execute function public.prevent_voided_order_row_write();

drop trigger if exists trg_prevent_voided_order_transfer_write
  on public.business_customer_transfers;
create trigger trg_prevent_voided_order_transfer_write
  before insert or update or delete on public.business_customer_transfers
  for each row execute function public.prevent_voided_order_row_write();

drop trigger if exists trg_prevent_voided_finance_order_cost_write
  on public.finance_order_costs;
create trigger trg_prevent_voided_finance_order_cost_write
  before insert or update or delete on public.finance_order_costs
  for each row execute function public.prevent_voided_finance_order_cost_write();

drop trigger if exists trg_prevent_voided_order_item_cost_override_write
  on public.finance_business_order_item_cost_overrides;
create trigger trg_prevent_voided_order_item_cost_override_write
  before insert or update or delete on public.finance_business_order_item_cost_overrides
  for each row execute function public.prevent_voided_order_item_cost_override_write();

-- -----------------------------------------------------------------------------
-- 3. 编辑门禁与状态重算
-- -----------------------------------------------------------------------------
create or replace function public.business_order_accepts_entry_edits(
  p_order_id uuid,
  p_role text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select bo.voided_at is null
    and bo.closed_at is null
    and (
      bo.status::text in ('draft', 'rejected')
      or (
        coalesce(p_role, '') in ('admin', 'finance')
        and bo.status::text = 'approved'
        and not exists (
          select 1
          from public.business_order_payment_allocations a
          join public.business_customer_transfers t on t.id = a.transfer_id
          where a.order_id = bo.id and a.voided_at is null and t.voided_at is null
        )
        and not exists (
          select 1
          from public.business_order_shipments s
          where s.order_id = bo.id and s.voided_at is null
        )
      )
    )
  from public.business_orders bo
  where bo.id = p_order_id;
$$;
revoke all on function public.business_order_accepts_entry_edits(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.business_order_accepts_entry_edits(uuid, text)
  to authenticated;

create or replace function public.business_refresh_order_payment_status(p_order_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total numeric;
  v_paid numeric;
  v_status text;
  v_existing_status text;
  v_voided_at timestamptz;
begin
  select bo.total_amount,
         bo.payment_status,
         bo.voided_at,
         coalesce(bo.total_sales_amount, 0)
           + coalesce(sum(a.amount) filter (
               where a.voided_at is null and t.voided_at is null
             ), 0)
    into v_total, v_existing_status, v_voided_at, v_paid
  from public.business_orders bo
  left join public.business_order_payment_allocations a on a.order_id = bo.id
  left join public.business_customer_transfers t on t.id = a.transfer_id
  where bo.id = p_order_id
  group by bo.id, bo.total_amount, bo.payment_status, bo.voided_at;

  if not found then
    raise exception 'Business order does not exist';
  end if;
  if v_voided_at is not null then
    return v_existing_status;
  end if;

  v_status := case
    when v_total <= 0 then 'fully_paid'
    when v_paid <= 0 then 'unpaid'
    when v_paid < v_total then 'partially_paid'
    else 'fully_paid'
  end;

  update public.business_orders
  set payment_status = v_status
  where id = p_order_id and payment_status is distinct from v_status;

  return v_status;
end;
$$;
revoke all on function public.business_refresh_order_payment_status(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.business_refresh_order_fulfillment_status(p_order_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_required numeric;
  v_net_shipped numeric;
  v_status text;
  v_existing_status text;
  v_voided_at timestamptz;
begin
  select bo.fulfillment_status, bo.voided_at
    into v_existing_status, v_voided_at
  from public.business_orders bo
  where bo.id = p_order_id;
  if not found then
    raise exception 'Business order does not exist';
  end if;
  if v_voided_at is not null then
    return v_existing_status;
  end if;

  select coalesce(sum(i.quantity), 0),
         coalesce(sum(public.business_order_item_net_shipped(i.id)), 0)
    into v_required, v_net_shipped
  from public.business_order_items i
  where i.order_id = p_order_id;

  v_status := case
    when v_net_shipped <= 0 then 'unshipped'
    when v_required > 0 and v_net_shipped >= v_required then 'fully_shipped'
    else 'partially_shipped'
  end;

  update public.business_orders
  set fulfillment_status = v_status
  where id = p_order_id and fulfillment_status is distinct from v_status;

  return v_status;
end;
$$;
revoke all on function public.business_refresh_order_fulfillment_status(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.get_business_order_edit_constraints(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
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

  select coalesce(sum(round(public.business_order_item_net_shipped(i.id) * i.unit_price, 2)), 0)
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
                             and v_order.closed_at is null and v_allocated = 0,
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
    'available_balance', round(v_allocated - v_shipped_value, 2),
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
$$;
revoke all on function public.get_business_order_edit_constraints(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_business_order_edit_constraints(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. 受控删除与作废
-- -----------------------------------------------------------------------------
create or replace function public.delete_business_order_draft(
  p_order_id uuid,
  p_expected_version int
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_audit_count int;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved' or v_actor.role::text <> 'admin' then
    raise exception 'Approved administrator required to delete a business order';
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
  if v_order.status::text <> 'draft' or v_order.closed_at is not null or v_order.voided_at is not null then
    raise exception 'Only an open draft business order can be deleted';
  end if;

  if exists (select 1 from public.business_order_payments where order_id = v_order.id)
     or exists (select 1 from public.business_customer_transfers where order_id = v_order.id)
     or exists (select 1 from public.business_order_payment_allocations where order_id = v_order.id)
     or exists (select 1 from public.business_order_shipments where order_id = v_order.id)
     or exists (select 1 from public.business_order_returns where order_id = v_order.id)
     or exists (select 1 from public.business_order_attachments where order_id = v_order.id)
     or exists (select 1 from public.business_order_amount_revisions where order_id = v_order.id)
     or exists (select 1 from public.business_order_finance_details where order_id = v_order.id)
     or exists (select 1 from public.finance_order_costs where business_order_id = v_order.id)
     or exists (
       select 1
       from public.finance_business_order_item_cost_overrides c
       join public.business_order_items i on i.id = c.business_order_item_id
       where i.order_id = v_order.id
     )
     or exists (select 1 from public.business_lifecycle_audit_logs where order_id = v_order.id)
  then
    raise exception 'Business order with business records can only be voided';
  end if;

  select count(*) into v_audit_count
  from public.business_order_audit_logs l
  where l.order_id = v_order.id;
  if v_audit_count <> 1 or not exists (
    select 1
    from public.business_order_audit_logs l
    where l.order_id = v_order.id
      and l.entity_type = 'order'
      and l.entity_id = v_order.id
      and l.action = 'create'::public.business_audit_action
  ) then
    raise exception 'Business order with audit history can only be voided';
  end if;

  delete from public.business_order_audit_logs where order_id = v_order.id;
  delete from public.business_orders where id = v_order.id;
  return v_order.id;
end;
$$;
revoke all on function public.delete_business_order_draft(uuid, int)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_business_order_draft(uuid, int) to authenticated;

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
  if not found or v_actor.status::text <> 'approved' or v_actor.role::text <> 'admin' then
    raise exception 'Approved administrator required to void a business order';
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

commit;
