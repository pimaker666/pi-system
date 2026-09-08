-- 0030_business_order_completion.sql
-- 业务订单特殊关闭、产品级退货、净发货口径与订单行不可变约束。
-- 仅使用既有枚举值；可在 0029 后以单事务执行，并可安全重复执行。

-- -----------------------------------------------------------------------------
-- 1. 特殊关闭维度（与既有 status 枚举正交）
-- -----------------------------------------------------------------------------
alter table public.business_orders
  add column if not exists closed_at timestamptz,
  add column if not exists closed_by uuid references public.profiles(id) on delete restrict,
  add column if not exists close_reason text;

alter table public.business_orders
  drop constraint if exists business_orders_closure_complete;
alter table public.business_orders
  add constraint business_orders_closure_complete check (
    (closed_at is null and closed_by is null and close_reason is null)
    or
    (closed_at is not null and closed_by is not null
     and nullif(btrim(close_reason), '') is not null
     and char_length(btrim(close_reason)) <= 1000)
  );

comment on column public.business_orders.closed_at is
  '特殊关闭时间；不改变既有业务订单状态枚举';
comment on column public.business_orders.closed_by is
  '执行特殊关闭的管理员';
comment on column public.business_orders.close_reason is
  '特殊关闭原因，关闭时必填且最多 1000 字符';

create index if not exists idx_business_orders_closed_at
  on public.business_orders (closed_at desc) where closed_at is not null;
create index if not exists idx_business_orders_closed_by
  on public.business_orders (closed_by) where closed_by is not null;

-- -----------------------------------------------------------------------------
-- 2. 产品级退货；复合外键在物理层阻止跨订单、跨产品引用
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.business_order_items'::regclass
      and conname = 'business_order_items_id_order_key'
  ) then
    alter table public.business_order_items
      add constraint business_order_items_id_order_key unique (id, order_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.business_order_shipment_items'::regclass
      and conname = 'business_order_shipment_items_id_item_key'
  ) then
    alter table public.business_order_shipment_items
      add constraint business_order_shipment_items_id_item_key unique (id, order_item_id);
  end if;
end;
$$;

create table if not exists public.business_order_returns (
  id              uuid primary key default uuid_generate_v4(),
  order_id        uuid not null references public.business_orders(id) on delete restrict,
  returned_at     timestamptz not null,
  notes           text check (notes is null or char_length(notes) <= 1000),
  idempotency_key text check (
    idempotency_key is null or char_length(btrim(idempotency_key)) between 1 and 200
  ),
  payload_hash    text,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  voided_at       timestamptz,
  voided_by       uuid references public.profiles(id) on delete restrict,
  void_reason     text,
  constraint business_order_returns_id_order_key unique (id, order_id),
  constraint business_order_returns_void_complete check (
    (voided_at is null and voided_by is null and void_reason is null)
    or
    (voided_at is not null and voided_by is not null
     and nullif(btrim(void_reason), '') is not null
     and char_length(btrim(void_reason)) <= 1000)
  )
);

create table if not exists public.business_order_return_items (
  id               uuid primary key default uuid_generate_v4(),
  return_id        uuid not null,
  order_id         uuid not null,
  shipment_item_id uuid not null,
  order_item_id    uuid not null,
  quantity         numeric(18,4) not null check (
    quantity > 0 and quantity <= 999999999999
  ),
  created_at       timestamptz not null default now(),
  constraint business_order_return_items_return_order_fk
    foreign key (return_id, order_id)
    references public.business_order_returns(id, order_id) on delete restrict,
  constraint business_order_return_items_shipment_order_item_fk
    foreign key (shipment_item_id, order_item_id)
    references public.business_order_shipment_items(id, order_item_id) on delete restrict,
  constraint business_order_return_items_order_item_order_fk
    foreign key (order_item_id, order_id)
    references public.business_order_items(id, order_id) on delete restrict,
  constraint business_order_return_items_source_unique
    unique (return_id, shipment_item_id)
);

comment on table public.business_order_returns is
  '业务订单退货单；仅可通过受控 RPC 新增或作废';
comment on table public.business_order_return_items is
  '产品级部分退货明细；每行追溯到原发货明细并由复合外键约束同订单同产品';
comment on column public.business_order_return_items.shipment_item_id is
  '原始发货明细，退货数量不得超过该明细尚未退回数量';

create unique index if not exists idx_business_order_returns_idempotency
  on public.business_order_returns (created_by, idempotency_key)
  where idempotency_key is not null;
create index if not exists idx_business_order_returns_order_active
  on public.business_order_returns (order_id, returned_at desc)
  where voided_at is null;
create index if not exists idx_business_order_returns_created_by
  on public.business_order_returns (created_by);
create index if not exists idx_business_order_returns_voided_by
  on public.business_order_returns (voided_by) where voided_by is not null;
create index if not exists idx_business_order_return_items_return
  on public.business_order_return_items (return_id);
create index if not exists idx_business_order_return_items_order_return
  on public.business_order_return_items (order_id, return_id);
create index if not exists idx_business_order_return_items_shipment_item
  on public.business_order_return_items (shipment_item_id);
create index if not exists idx_business_order_return_items_order_item
  on public.business_order_return_items (order_item_id);

-- 生命周期审计使用文本动作，避免在事务中扩展并立即使用既有枚举。
alter table public.business_lifecycle_audit_logs
  drop constraint if exists business_lifecycle_audit_logs_entity_type_check;
alter table public.business_lifecycle_audit_logs
  add constraint business_lifecycle_audit_logs_entity_type_check check (
    entity_type in (
      'custom_product', 'custom_product_version', 'transfer', 'allocation',
      'shipment', 'return', 'closure'
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
    'shipment', 'return', 'closure'
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
-- 3. 净发货口径与底层不变量
-- -----------------------------------------------------------------------------
create or replace function public.business_order_item_net_shipped(p_order_item_id uuid)
returns numeric
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(sum(si.quantity), 0)
         - coalesce((
             select sum(ri.quantity)
             from public.business_order_return_items ri
             join public.business_order_returns r on r.id = ri.return_id
             join public.business_order_shipment_items source_si
               on source_si.id = ri.shipment_item_id
             join public.business_order_shipments source_s
               on source_s.id = source_si.shipment_id
             where ri.order_item_id = p_order_item_id
               and r.voided_at is null
               and source_s.voided_at is null
           ), 0)
  from public.business_order_shipment_items si
  join public.business_order_shipments s on s.id = si.shipment_id
  where si.order_item_id = p_order_item_id
    and s.voided_at is null;
$$;
revoke all on function public.business_order_item_net_shipped(uuid)
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
begin
  if not exists (select 1 from public.business_orders where id = p_order_id) then
    raise exception 'Business order does not exist';
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

drop trigger if exists trg_protect_business_order_item_invariants
  on public.business_order_items;
create trigger trg_protect_business_order_item_invariants
  before insert or update or delete on public.business_order_items
  for each row execute function public.protect_business_order_item_invariants();

create or replace function public.protect_business_order_closure()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_is_admin boolean;
begin
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
    if new.closed_at is distinct from old.closed_at
       or new.closed_by is distinct from old.closed_by
       or new.close_reason is distinct from old.close_reason then
      raise exception 'Business order closure is immutable';
    end if;
    -- total_cny 是存储生成列，在 BEFORE 触发器中 NEW 尚未重算；排除后仍由数据库生成规则保护。
    -- 关闭后只允许乐观锁版本和自动维护时间变化；其余现有及未来业务字段均冻结。
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

drop trigger if exists trg_protect_business_order_closure on public.business_orders;
create trigger trg_protect_business_order_closure
  before update on public.business_orders
  for each row execute function public.protect_business_order_closure();

create or replace function public.validate_business_order_return_item()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_return public.business_order_returns%rowtype;
  v_shipment_voided_at public.business_order_shipments.voided_at%type;
  v_shipped_at public.business_order_shipments.shipped_at%type;
  v_source_quantity numeric;
  v_returned numeric;
begin
  select * into v_return
  from public.business_order_returns
  where id = new.return_id and order_id = new.order_id;
  if not found or v_return.voided_at is not null then
    raise exception 'Active business order return does not exist';
  end if;

  select s.voided_at, s.shipped_at, si.quantity
  into v_shipment_voided_at, v_shipped_at, v_source_quantity
  from public.business_order_shipment_items si
  join public.business_order_shipments s on s.id = si.shipment_id
  where si.id = new.shipment_item_id
    and si.order_item_id = new.order_item_id
    and s.order_id = new.order_id;
  if not found or v_shipment_voided_at is not null then
    raise exception 'Return source shipment is invalid or voided';
  end if;
  if v_return.returned_at > now() then
    raise exception 'Returned time cannot be later than current time';
  end if;
  if v_return.returned_at < v_shipped_at then
    raise exception 'Returned time cannot be earlier than source shipment time';
  end if;

  select coalesce(sum(ri.quantity), 0) into v_returned
  from public.business_order_return_items ri
  join public.business_order_returns r on r.id = ri.return_id
  where ri.shipment_item_id = new.shipment_item_id
    and r.voided_at is null;
  if v_returned + new.quantity > v_source_quantity then
    raise exception 'Return quantity exceeds source shipment item quantity';
  end if;
  return new;
end;
$$;
revoke all on function public.validate_business_order_return_item()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_validate_business_order_return_item
  on public.business_order_return_items;
create trigger trg_validate_business_order_return_item
  before insert on public.business_order_return_items
  for each row execute function public.validate_business_order_return_item();

create or replace function public.prevent_business_order_return_item_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Business order return items are immutable';
end;
$$;
revoke all on function public.prevent_business_order_return_item_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_business_order_return_items_immutable
  on public.business_order_return_items;
create trigger trg_business_order_return_items_immutable
  before update or delete on public.business_order_return_items
  for each row execute function public.prevent_business_order_return_item_mutation();

create or replace function public.protect_business_order_return_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_item record;
  v_net numeric;
  v_order_quantity numeric;
begin
  if new.order_id is distinct from old.order_id
     or new.returned_at is distinct from old.returned_at
     or new.notes is distinct from old.notes
     or new.idempotency_key is distinct from old.idempotency_key
     or new.payload_hash is distinct from old.payload_hash
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Business order return header is immutable';
  end if;
  if old.voided_at is not null then
    raise exception 'Voided business order return is immutable';
  end if;
  if new.voided_at is null then
    raise exception 'Business order return can only be voided';
  end if;

  for v_item in
    select ri.order_item_id, sum(ri.quantity) as quantity
    from public.business_order_return_items ri
    where ri.return_id = old.id
    group by ri.order_item_id
  loop
    select i.quantity, public.business_order_item_net_shipped(i.id)
      into v_order_quantity, v_net
    from public.business_order_items i
    where i.id = v_item.order_item_id
    for update;
    if v_net + v_item.quantity > v_order_quantity then
      raise exception 'Voiding return would make net shipped quantity exceed ordered quantity';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function public.protect_business_order_return_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_protect_business_order_return_mutation
  on public.business_order_returns;
create trigger trg_protect_business_order_return_mutation
  before update on public.business_order_returns
  for each row execute function public.protect_business_order_return_mutation();

create or replace function public.protect_shipment_void_with_returns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.voided_at is null and new.voided_at is not null and exists (
    select 1
    from public.business_order_shipment_items si
    join public.business_order_return_items ri on ri.shipment_item_id = si.id
    join public.business_order_returns r on r.id = ri.return_id
    where si.shipment_id = old.id and r.voided_at is null
  ) then
    raise exception 'Shipment with active returns cannot be voided';
  end if;
  return new;
end;
$$;
revoke all on function public.protect_shipment_void_with_returns()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_protect_shipment_void_with_returns
  on public.business_order_shipments;
create trigger trg_protect_shipment_void_with_returns
  before update of voided_at on public.business_order_shipments
  for each row execute function public.protect_shipment_void_with_returns();

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

drop trigger if exists trg_prevent_closed_order_allocation_insert
  on public.business_order_payment_allocations;
create trigger trg_prevent_closed_order_allocation_insert
  before insert on public.business_order_payment_allocations
  for each row execute function public.prevent_closed_order_new_lifecycle_rows();

drop trigger if exists trg_prevent_closed_order_shipment_insert
  on public.business_order_shipments;
create trigger trg_prevent_closed_order_shipment_insert
  before insert on public.business_order_shipments
  for each row execute function public.prevent_closed_order_new_lifecycle_rows();

create or replace function public.protect_transfer_void_for_locked_orders()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_role text;
begin
  if old.voided_at is null and new.voided_at is not null then
    if exists (
      select 1
      from public.business_order_payment_allocations a
      join public.business_orders bo on bo.id = a.order_id
      where a.transfer_id = old.id and a.voided_at is null
        and bo.status::text = 'completed'
    ) then
      raise exception 'Transfer allocated to a completed order cannot be voided';
    end if;
    if exists (
      select 1
      from public.business_order_payment_allocations a
      join public.business_orders bo on bo.id = a.order_id
      where a.transfer_id = old.id and a.voided_at is null
        and bo.closed_at is not null
    ) then
      select p.role::text into v_role
      from public.profiles p
      where p.id = v_uid and p.status::text = 'approved';
      if v_role not in ('admin', 'finance') then
        raise exception 'Only administrators or finance can void a transfer allocated to a closed order';
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.protect_transfer_void_for_locked_orders()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_protect_transfer_void_for_locked_orders
  on public.business_customer_transfers;
create trigger trg_protect_transfer_void_for_locked_orders
  before update of voided_at on public.business_customer_transfers
  for each row execute function public.protect_transfer_void_for_locked_orders();

-- -----------------------------------------------------------------------------
-- 4. 行替换：保留已存在行 UUID，让发货/退货可追溯；触发器提供第二层兜底
-- -----------------------------------------------------------------------------
create or replace function public.replace_business_order_items(
  p_order_id uuid,
  p_items jsonb
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_order public.business_orders%rowtype;
  v_existing public.business_order_items%rowtype;
  v_product public.products%rowtype;
  v_custom_product public.business_custom_products%rowtype;
  v_custom_version public.business_custom_product_versions%rowtype;
  v_source_type text;
  v_requested_id uuid;
  v_product_id uuid;
  v_custom_product_id uuid;
  v_custom_version_id uuid;
  v_quantity numeric;
  v_unit_price numeric;
  v_sort_order int := 0;
  v_subtotal numeric(18,2) := 0;
  v_matched_ids uuid[] := array[]::uuid[];
  v_is_existing boolean;
begin
  select * into v_order from public.business_orders bo where bo.id = p_order_id for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if v_order.status::text = 'completed' or v_order.closed_at is not null then
    raise exception 'Completed or closed order items cannot be replaced';
  end if;
  if v_order.customer_id is null then raise exception 'Business order customer is required'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 500 then
    raise exception 'Order items count must be between 1 and 500';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_items) as x(id uuid)
    where x.id is not null
    group by x.id having count(*) > 1
  ) then
    raise exception 'Each order item id must be unique';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) <> 'object' then raise exception 'Each item must be an object'; end if;
    v_requested_id := nullif(v_item->>'id', '')::uuid;
    v_product_id := nullif(v_item->>'product_id', '')::uuid;
    v_custom_product_id := nullif(v_item->>'custom_product_id', '')::uuid;
    v_custom_version_id := nullif(v_item->>'custom_product_version_id', '')::uuid;
    v_source_type := coalesce(nullif(v_item->>'source_type', ''),
      case when v_custom_product_id is not null or v_custom_version_id is not null
           then 'custom' else 'catalog' end);
    v_quantity := round((v_item->>'quantity')::numeric, 4);
    v_unit_price := round((v_item->>'unit_price')::numeric, 2);
    if v_quantity is null or v_quantity <= 0 or v_quantity > 999999999999 then
      raise exception 'Quantity is invalid';
    end if;
    if v_unit_price is null or v_unit_price < 0 or v_unit_price > 999999999999 then
      raise exception 'Unit price is invalid';
    end if;

    v_existing := null;
    if v_requested_id is not null then
      select * into v_existing from public.business_order_items
      where id = v_requested_id and order_id = p_order_id;
      if not found then raise exception 'Order item id does not belong to order'; end if;
    elsif v_source_type = 'catalog' then
      select * into v_existing from public.business_order_items
      where order_id = p_order_id and source_type = 'catalog'
        and product_id = v_product_id and not (id = any(v_matched_ids))
      order by sort_order, id limit 1;
    elsif v_source_type = 'custom' then
      select * into v_existing from public.business_order_items
      where order_id = p_order_id and source_type = 'custom'
        and custom_product_id = v_custom_product_id
        and custom_product_version_id = v_custom_version_id
        and not (id = any(v_matched_ids))
      order by sort_order, id limit 1;
    end if;
    v_is_existing := v_existing.id is not null;

    if v_source_type = 'catalog' then
      if v_product_id is null or v_custom_product_id is not null or v_custom_version_id is not null then
        raise exception 'Catalog item requires only product_id';
      end if;
      select * into v_product from public.products where id = v_product_id;
      if not found or (
        not v_product.is_active and (
          not v_is_existing
          or v_existing.source_type <> 'catalog'
          or v_existing.product_id is distinct from v_product_id
        )
      ) then
        raise exception 'Product does not exist or is inactive';
      end if;

      if v_is_existing then
        update public.business_order_items set
          source_type = 'catalog', product_id = v_product.id,
          custom_product_id = null, custom_product_version_id = null,
          sku_snapshot = v_product.sku, name_snapshot = v_product.name,
          description_snapshot = v_product.description,
          specification_snapshot = v_product.specification,
          unit_snapshot = v_product.unit, image_url_snapshot = v_product.image_url,
          quantity = v_quantity, unit_price = v_unit_price, sort_order = v_sort_order
        where id = v_existing.id returning * into v_existing;
      else
        insert into public.business_order_items (
          order_id, source_type, product_id, sku_snapshot, name_snapshot,
          description_snapshot, specification_snapshot, unit_snapshot,
          image_url_snapshot, quantity, unit_price, sort_order
        ) values (
          p_order_id, 'catalog', v_product.id, v_product.sku, v_product.name,
          v_product.description, v_product.specification, v_product.unit,
          v_product.image_url, v_quantity, v_unit_price, v_sort_order
        ) returning * into v_existing;
      end if;
    elsif v_source_type = 'custom' then
      if v_product_id is not null or v_custom_product_id is null or v_custom_version_id is null then
        raise exception 'Custom item requires only custom_product_id and custom_product_version_id';
      end if;
      select * into v_custom_product from public.business_custom_products
      where id = v_custom_product_id;
      if not found then raise exception 'Custom product does not exist'; end if;
      select * into v_custom_version from public.business_custom_product_versions
      where id = v_custom_version_id and custom_product_id = v_custom_product.id;
      if not found then raise exception 'Custom product version does not belong to custom product'; end if;
      if v_custom_product.is_archived and (
        not v_is_existing
        or v_existing.source_type <> 'custom'
        or v_existing.custom_product_id is distinct from v_custom_product_id
        or v_existing.custom_product_version_id is distinct from v_custom_version_id
      ) then
        raise exception 'Custom product is archived';
      end if;
      if v_custom_product.customer_id <> v_order.customer_id
         and not v_custom_product.is_shared
         and (
           not v_is_existing
           or v_existing.source_type <> 'custom'
           or v_existing.custom_product_id is distinct from v_custom_product_id
           or v_existing.custom_product_version_id is distinct from v_custom_version_id
         ) then
        raise exception 'Custom product is not available for this order customer';
      end if;

      if v_is_existing then
        update public.business_order_items set
          source_type = 'custom', product_id = null,
          custom_product_id = v_custom_product.id,
          custom_product_version_id = v_custom_version.id,
          sku_snapshot = v_custom_version.code, name_snapshot = v_custom_version.name,
          description_snapshot = v_custom_version.description,
          specification_snapshot = v_custom_version.specification,
          unit_snapshot = v_custom_version.unit, image_url_snapshot = v_custom_version.image_url,
          quantity = v_quantity, unit_price = v_unit_price, sort_order = v_sort_order
        where id = v_existing.id returning * into v_existing;
      else
        insert into public.business_order_items (
          order_id, source_type, custom_product_id, custom_product_version_id,
          sku_snapshot, name_snapshot, description_snapshot, specification_snapshot,
          unit_snapshot, image_url_snapshot, quantity, unit_price, sort_order
        ) values (
          p_order_id, 'custom', v_custom_product.id, v_custom_version.id,
          v_custom_version.code, v_custom_version.name, v_custom_version.description,
          v_custom_version.specification, v_custom_version.unit, v_custom_version.image_url,
          v_quantity, v_unit_price, v_sort_order
        ) returning * into v_existing;
      end if;
    else
      raise exception 'Invalid order item source_type';
    end if;

    v_matched_ids := array_append(v_matched_ids, v_existing.id);
    v_subtotal := v_subtotal + round(v_quantity * v_unit_price, 2);
    v_sort_order := v_sort_order + 1;
  end loop;

  delete from public.business_order_items
  where order_id = p_order_id and not (id = any(v_matched_ids));
  return v_subtotal;
end;
$$;
revoke all on function public.replace_business_order_items(uuid, jsonb)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. 创建/编辑/状态机：管理员可建单，财务不可；closed/completed 不可编辑
-- -----------------------------------------------------------------------------
create or replace function public.create_business_order(
  p_customer_id uuid,
  p_order_date date,
  p_fulfillment_type public.business_fulfillment_type,
  p_currency public.currency_code,
  p_exchange_rate_to_cny numeric,
  p_shipping_fee numeric,
  p_tracking_number text,
  p_sales_notes text,
  p_items jsonb
)
returns table (id uuid, order_number text, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_customer public.customers%rowtype;
  v_order public.business_orders%rowtype;
  v_subtotal numeric(18,2);
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin') then
    raise exception 'Only approved sales, supervisor, or admin users can create business orders';
  end if;
  if p_order_date is null then raise exception 'Order date is required'; end if;
  if p_exchange_rate_to_cny is null or p_exchange_rate_to_cny <= 0
     or p_exchange_rate_to_cny > 1000000 then raise exception 'Exchange rate is invalid'; end if;
  if p_currency::text = 'CNY' and p_exchange_rate_to_cny <> 1 then
    raise exception 'CNY exchange rate must equal one';
  end if;
  if p_shipping_fee is null or p_shipping_fee < 0 or p_shipping_fee > 999999999999 then
    raise exception 'Shipping fee is invalid';
  end if;
  if char_length(coalesce(p_tracking_number, '')) > 200
     or char_length(coalesce(p_sales_notes, '')) > 2000 then
    raise exception 'Business order text exceeds maximum length';
  end if;

  select * into v_customer from public.customers c where c.id = p_customer_id;
  if not found or (
    v_actor.role::text in ('sales', 'supervisor') and v_customer.created_by is distinct from v_uid
  ) then
    raise exception 'Customer does not exist or is not manageable by current user';
  end if;

  insert into public.business_orders (
    order_number, customer_id, customer_snapshot, salesperson_id,
    salesperson_name_snapshot, order_date, fulfillment_type, currency,
    exchange_rate_to_cny, items_subtotal, shipping_fee, total_amount,
    tracking_number, sales_notes
  ) values (
    public.next_business_order_number(), v_customer.id,
    jsonb_build_object(
      'name', v_customer.name, 'company', v_customer.company,
      'email', v_customer.email, 'phone', v_customer.phone,
      'address', v_customer.address, 'city', v_customer.city,
      'state', v_customer.state, 'postal_code', v_customer.postal_code,
      'country', v_customer.country, 'contact_person', v_customer.contact_person
    ),
    v_uid, coalesce(
      nullif(btrim(v_actor.chinese_name), ''),
      nullif(btrim(v_actor.full_name), ''),
      v_actor.email
    ),
    p_order_date, p_fulfillment_type, p_currency, p_exchange_rate_to_cny,
    0, p_shipping_fee, p_shipping_fee,
    nullif(btrim(p_tracking_number), ''), nullif(btrim(p_sales_notes), '')
  ) returning * into v_order;

  v_subtotal := public.replace_business_order_items(v_order.id, p_items);
  update public.business_orders bo
  set items_subtotal = v_subtotal, total_amount = v_subtotal + p_shipping_fee
  where bo.id = v_order.id returning * into v_order;

  perform public.write_business_order_audit(
    v_order.id, 'order', v_order.id, 'create', null, v_order.status, null,
    jsonb_build_object(
      'order', to_jsonb(v_order),
      'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order)
                         from public.business_order_items i
                         where i.order_id = v_order.id), '[]'::jsonb)
    ), null, v_uid
  );
  return query select v_order.id, v_order.order_number, v_order.version;
end;
$$;
revoke all on function public.create_business_order(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.create_business_order(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb
) to authenticated;

create or replace function public.update_business_order(
  p_order_id uuid,
  p_expected_version int,
  p_customer_id uuid,
  p_order_date date,
  p_fulfillment_type public.business_fulfillment_type,
  p_currency public.currency_code,
  p_exchange_rate_to_cny numeric,
  p_shipping_fee numeric,
  p_tracking_number text,
  p_sales_notes text,
  p_items jsonb,
  p_reason text
)
returns table (id uuid, order_number text, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_customer public.customers%rowtype;
  v_old jsonb;
  v_subtotal numeric(18,2);
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin') then
    raise exception 'Approved sales, supervisor, or admin account required';
  end if;
  select * into v_order from public.business_orders bo where bo.id = p_order_id for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if v_order.version <> p_expected_version then raise exception 'Business order version conflict'; end if;
  if v_order.status::text = 'completed' or v_order.closed_at is not null then
    raise exception 'Completed or closed business order cannot be edited';
  end if;
  if v_order.status::text not in ('draft', 'rejected') then
    raise exception 'Business order cannot be edited in current status';
  end if;
  if v_actor.role::text in ('sales', 'supervisor') and v_order.salesperson_id is distinct from v_uid then
    raise exception 'Sales user cannot edit another owner business order';
  end if;
  if p_order_date is null then raise exception 'Order date is required'; end if;
  if p_exchange_rate_to_cny is null or p_exchange_rate_to_cny <= 0
     or p_exchange_rate_to_cny > 1000000 then raise exception 'Exchange rate is invalid'; end if;
  if p_currency::text = 'CNY' and p_exchange_rate_to_cny <> 1 then
    raise exception 'CNY exchange rate must equal one';
  end if;
  if p_shipping_fee is null or p_shipping_fee < 0 or p_shipping_fee > 999999999999 then
    raise exception 'Shipping fee is invalid';
  end if;
  if char_length(coalesce(p_tracking_number, '')) > 200
     or char_length(coalesce(p_sales_notes, '')) > 2000
     or char_length(coalesce(p_reason, '')) > 1000 then
    raise exception 'Business order text exceeds maximum length';
  end if;

  select * into v_customer from public.customers c where c.id = p_customer_id;
  if not found or (
    v_actor.role::text in ('sales', 'supervisor') and v_customer.created_by is distinct from v_uid
  ) then raise exception 'Customer does not exist or is not manageable by current user'; end if;

  v_old := jsonb_build_object(
    'order', to_jsonb(v_order),
    'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order)
                       from public.business_order_items i
                       where i.order_id = v_order.id), '[]'::jsonb)
  );

  -- 先在同一事务更新客户上下文，使新增定制行按目标客户校验；失败会整体回滚。
  update public.business_orders bo set
    customer_id = v_customer.id,
    customer_snapshot = jsonb_build_object(
      'name', v_customer.name, 'company', v_customer.company,
      'email', v_customer.email, 'phone', v_customer.phone,
      'address', v_customer.address, 'city', v_customer.city,
      'state', v_customer.state, 'postal_code', v_customer.postal_code,
      'country', v_customer.country, 'contact_person', v_customer.contact_person
    )
  where bo.id = v_order.id;

  v_subtotal := public.replace_business_order_items(v_order.id, p_items);

  update public.business_orders bo set
    customer_id = v_customer.id,
    customer_snapshot = jsonb_build_object(
      'name', v_customer.name, 'company', v_customer.company,
      'email', v_customer.email, 'phone', v_customer.phone,
      'address', v_customer.address, 'city', v_customer.city,
      'state', v_customer.state, 'postal_code', v_customer.postal_code,
      'country', v_customer.country, 'contact_person', v_customer.contact_person
    ),
    order_date = p_order_date, fulfillment_type = p_fulfillment_type,
    currency = p_currency, exchange_rate_to_cny = p_exchange_rate_to_cny,
    items_subtotal = v_subtotal, shipping_fee = p_shipping_fee,
    total_amount = v_subtotal + p_shipping_fee,
    tracking_number = nullif(btrim(p_tracking_number), ''),
    sales_notes = nullif(btrim(p_sales_notes), ''), version = bo.version + 1
  where bo.id = v_order.id returning * into v_order;

  perform public.write_business_order_audit(
    v_order.id, 'order', v_order.id, 'update', v_order.status, v_order.status,
    v_old,
    jsonb_build_object(
      'order', to_jsonb(v_order),
      'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order)
                         from public.business_order_items i
                         where i.order_id = v_order.id), '[]'::jsonb)
    ), p_reason, v_uid
  );
  return query select v_order.id, v_order.order_number, v_order.version;
end;
$$;
revoke all on function public.update_business_order(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, text
) from public, anon, authenticated, service_role;
-- 旧编辑入口只供 V2 包装器调用，不直接授权客户端。

create or replace function public.update_business_order_v2(
  p_order_id uuid,
  p_expected_version int,
  p_customer_id uuid,
  p_order_date date,
  p_fulfillment_type public.business_fulfillment_type,
  p_currency public.currency_code,
  p_exchange_rate_to_cny numeric,
  p_shipping_fee numeric,
  p_tracking_number text,
  p_sales_notes text,
  p_items jsonb,
  p_payment_due_date date,
  p_reason text
)
returns table (id uuid, order_number text, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_order public.business_orders%rowtype;
  v_updated record;
  v_old_due_date date;
begin
  select * into v_order from public.business_orders bo where bo.id = p_order_id for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if v_order.version <> p_expected_version then raise exception 'Business order version conflict'; end if;
  if v_order.status::text = 'completed' or v_order.closed_at is not null then
    raise exception 'Completed or closed business order cannot be edited';
  end if;
  if p_payment_due_date is not null and p_order_date is not null
     and p_payment_due_date < p_order_date then
    raise exception 'Payment due date cannot be earlier than order date';
  end if;
  v_old_due_date := v_order.payment_due_date;
  if v_old_due_date is not null then
    update public.business_orders set payment_due_date = null where business_orders.id = p_order_id;
  end if;

  select * into v_updated from public.update_business_order(
    p_order_id, p_expected_version, p_customer_id, p_order_date,
    p_fulfillment_type, p_currency, p_exchange_rate_to_cny, p_shipping_fee,
    p_tracking_number, p_sales_notes, p_items, p_reason
  );
  update public.business_orders
  set payment_due_date = p_payment_due_date
  where business_orders.id = v_updated.id returning * into v_order;

  perform public.business_refresh_order_payment_status(v_order.id);
  perform public.business_refresh_order_fulfillment_status(v_order.id);
  if v_old_due_date is distinct from p_payment_due_date then
    perform public.write_business_order_audit(
      v_order.id, 'order', v_order.id, 'update', v_order.status, v_order.status,
      jsonb_build_object('payment_due_date', v_old_due_date),
      jsonb_build_object('payment_due_date', p_payment_due_date), p_reason, v_uid
    );
  end if;
  select * into v_order from public.business_orders where business_orders.id = v_updated.id;
  return query select v_order.id, v_order.order_number, v_order.version;
end;
$$;
revoke all on function public.update_business_order_v2(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text
) from public, anon, authenticated, service_role;
grant execute on function public.update_business_order_v2(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text
) to authenticated;

create or replace function public.transition_business_order(
  p_order_id uuid,
  p_target public.business_order_status,
  p_note text
)
returns public.business_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_old jsonb;
  v_action public.business_audit_action;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved' then raise exception 'Approved account required'; end if;
  select * into v_order from public.business_orders bo where bo.id = p_order_id for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if v_order.closed_at is not null then raise exception 'Closed business order cannot be transitioned'; end if;
  if v_order.status::text = 'completed' then raise exception 'Completed business order is immutable'; end if;
  if char_length(coalesce(p_note, '')) > 1000 then raise exception 'Note cannot exceed 1000 characters'; end if;
  v_old := to_jsonb(v_order);

  if v_actor.role::text in ('sales', 'supervisor', 'admin')
     and (v_actor.role::text = 'admin' or v_order.salesperson_id = v_uid)
     and v_order.status::text in ('draft', 'rejected')
     and p_target::text = 'submitted' then
    if not exists (select 1 from public.business_order_items where order_id = v_order.id) then
      raise exception 'At least one order item is required before submission';
    end if;
    update public.business_orders set
      status = 'submitted', approval_status = 'submitted', submitted_by = v_uid,
      submitted_at = now(), version = version + 1
    where id = v_order.id returning * into v_order;
    v_action := 'submit';
  elsif v_actor.role::text = 'admin' and v_order.status::text = 'submitted'
        and p_target::text in ('approved', 'rejected') then
    if p_target::text = 'rejected' and nullif(btrim(p_note), '') is null then
      raise exception 'Rejection note is required';
    end if;
    update public.business_orders set
      status = p_target,
      approval_status = case when p_target::text = 'approved' then 'approved' else 'rejected' end,
      review_note = nullif(btrim(p_note), ''), reviewed_by = v_uid,
      reviewed_at = now(), version = version + 1
    where id = v_order.id returning * into v_order;
    v_action := case when p_target::text = 'approved' then 'approve' else 'reject' end;
  elsif v_actor.role::text = 'finance' and v_order.status::text = 'approved'
        and p_target::text = 'completed' then
    perform public.business_refresh_order_payment_status(v_order.id);
    perform public.business_refresh_order_fulfillment_status(v_order.id);
    select * into v_order from public.business_orders bo where bo.id = p_order_id;
    if v_order.approval_status <> 'approved'
       or v_order.payment_status <> 'fully_paid'
       or v_order.fulfillment_status <> 'fully_shipped' then
      raise exception 'Completion requires approved, fully paid, and fully shipped order';
    end if;
    if not exists (
      select 1 from public.business_order_finance_details f
      where f.order_id = v_order.id and f.wage_amount_cny >= 0
        and nullif(btrim(f.calculation_notes), '') is not null
    ) then raise exception 'Wage amount and calculation notes are required before completion'; end if;
    update public.business_orders set
      status = 'completed', completed_by = v_uid, completed_at = now(), version = version + 1
    where id = v_order.id returning * into v_order;
    v_action := 'complete';
  else
    raise exception 'Invalid business order transition for current role';
  end if;

  perform public.write_business_order_audit(
    v_order.id, 'order', v_order.id, v_action,
    (v_old->>'status')::public.business_order_status, v_order.status,
    v_old, to_jsonb(v_order), p_note, v_uid
  );
  return v_order;
end;
$$;
revoke all on function public.transition_business_order(
  uuid, public.business_order_status, text
) from public, anon, authenticated, service_role;
grant execute on function public.transition_business_order(
  uuid, public.business_order_status, text
) to authenticated;

create or replace function public.save_business_order_finance(
  p_order_id uuid,
  p_wage_amount_cny numeric,
  p_calculation_notes text,
  p_reason text
)
returns public.business_order_finance_details
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_finance public.business_order_finance_details%rowtype;
  v_old jsonb;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved' or v_actor.role::text <> 'finance' then
    raise exception 'Only approved finance users can edit order finance fields';
  end if;
  select * into v_order from public.business_orders bo where bo.id = p_order_id for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if v_order.closed_at is not null or v_order.status::text = 'completed' then
    raise exception 'Completed or closed business order finance fields are immutable';
  end if;
  if v_order.status::text <> 'approved' then
    raise exception 'Finance fields can only be edited for approved orders';
  end if;
  if p_wage_amount_cny is null or p_wage_amount_cny < 0
     or p_wage_amount_cny > 999999999999 then raise exception 'Wage amount is invalid'; end if;
  if nullif(btrim(p_calculation_notes), '') is null
     or char_length(btrim(p_calculation_notes)) > 4000 then
    raise exception 'Calculation notes are required and cannot exceed 4000 characters';
  end if;
  if char_length(coalesce(p_reason, '')) > 1000 then raise exception 'Reason cannot exceed 1000 characters'; end if;

  select to_jsonb(f) into v_old from public.business_order_finance_details f where f.order_id = p_order_id;
  insert into public.business_order_finance_details (
    order_id, wage_amount_cny, calculation_notes, updated_by
  ) values (p_order_id, p_wage_amount_cny, btrim(p_calculation_notes), v_uid)
  on conflict (order_id) do update set
    wage_amount_cny = excluded.wage_amount_cny,
    calculation_notes = excluded.calculation_notes,
    updated_by = excluded.updated_by
  returning * into v_finance;
  update public.business_orders set version = version + 1 where id = p_order_id;
  perform public.write_business_order_audit(
    p_order_id, 'order', p_order_id, 'finance_update',
    v_order.status, v_order.status, v_old, to_jsonb(v_finance), p_reason, v_uid
  );
  return v_finance;
end;
$$;
revoke all on function public.save_business_order_finance(uuid, numeric, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.save_business_order_finance(uuid, numeric, text, text)
  to authenticated;

-- -----------------------------------------------------------------------------
-- 6. 发货、作废分摊与作废发货
-- -----------------------------------------------------------------------------
create or replace function public.create_business_order_shipment(
  p_order_id uuid,
  p_shipped_at timestamptz,
  p_tracking_number text,
  p_notes text,
  p_items jsonb,
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
  v_order public.business_orders%rowtype;
  v_shipment public.business_order_shipments%rowtype;
  v_shipment_item public.business_order_shipment_items%rowtype;
  v_idempotency public.business_rpc_idempotency%rowtype;
  v_item jsonb;
  v_order_item public.business_order_items%rowtype;
  v_order_item_id uuid;
  v_quantity numeric;
  v_net_shipped numeric;
  v_hash text;
  v_created jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved' then raise exception 'Approved account required'; end if;
  select * into v_order from public.business_orders bo where bo.id = p_order_id for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if v_order.closed_at is not null then raise exception 'Closed business order cannot receive new shipments'; end if;
  if v_order.status::text = 'completed' then raise exception 'Completed business order is immutable'; end if;
  if v_actor.role::text in ('sales', 'supervisor') then
    if v_order.salesperson_id is distinct from v_uid then raise exception 'Sales user cannot ship another owner order'; end if;
  elsif v_actor.role::text not in ('admin', 'finance') then raise exception 'Role cannot create shipments'; end if;
  if v_order.status::text <> 'approved' or v_order.approval_status <> 'approved' then
    raise exception 'Only approved orders can be shipped';
  end if;
  if p_shipped_at is null then raise exception 'Shipped time is required'; end if;
  if p_shipped_at > now() then raise exception 'Shipped time cannot be in the future'; end if;
  if char_length(coalesce(p_tracking_number, '')) > 200
     or char_length(coalesce(p_notes, '')) > 1000 then raise exception 'Shipment text exceeds maximum length'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 500 then
    raise exception 'Shipment items count must be between 1 and 500';
  end if;
  if nullif(btrim(p_idempotency_key), '') is null
     or char_length(btrim(p_idempotency_key)) > 200 then raise exception 'Idempotency key is invalid'; end if;
  if exists (
    select 1 from jsonb_to_recordset(p_items) as x(order_item_id uuid, quantity numeric)
    group by x.order_item_id having x.order_item_id is null or count(*) > 1
  ) then raise exception 'Each shipment order_item_id must be unique'; end if;

  v_hash := encode(digest(jsonb_build_object(
    'order_id', p_order_id, 'shipped_at', p_shipped_at,
    'tracking_number', nullif(btrim(p_tracking_number), ''),
    'notes', nullif(btrim(p_notes), ''), 'items', p_items
  )::text, 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    v_uid::text || ':create_business_order_shipment:' || btrim(p_idempotency_key), 0));
  select * into v_idempotency from public.business_rpc_idempotency
  where actor_id = v_uid and operation = 'create_business_order_shipment'
    and idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_idempotency.payload_hash <> v_hash then
      raise exception 'Idempotency key was already used with a different payload';
    end if;
    return v_idempotency.result;
  end if;

  perform i.id from public.business_order_items i
  join (select x.order_item_id from jsonb_to_recordset(p_items)
        as x(order_item_id uuid, quantity numeric)) r on r.order_item_id = i.id
  where i.order_id = p_order_id order by i.id for update of i;
  if (select count(*) from jsonb_to_recordset(p_items) as x(order_item_id uuid, quantity numeric))
     <> (select count(*) from public.business_order_items i
         join (select x.order_item_id from jsonb_to_recordset(p_items)
               as x(order_item_id uuid, quantity numeric)) r on r.order_item_id = i.id
         where i.order_id = p_order_id) then
    raise exception 'One or more shipment items do not belong to order';
  end if;

  insert into public.business_order_shipments (
    order_id, shipped_at, tracking_number, notes, created_by
  ) values (
    p_order_id, p_shipped_at, nullif(btrim(p_tracking_number), ''),
    nullif(btrim(p_notes), ''), v_uid
  ) returning * into v_shipment;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_order_item_id := nullif(v_item->>'order_item_id', '')::uuid;
    v_quantity := round((v_item->>'quantity')::numeric, 4);
    if v_quantity is null or v_quantity <= 0 or v_quantity > 999999999999 then
      raise exception 'Shipment quantity is invalid';
    end if;
    select * into v_order_item from public.business_order_items
    where id = v_order_item_id and order_id = p_order_id;
    v_net_shipped := public.business_order_item_net_shipped(v_order_item.id);
    if v_net_shipped + v_quantity > v_order_item.quantity then
      raise exception 'Shipment quantity exceeds remaining net order item quantity';
    end if;
    insert into public.business_order_shipment_items (shipment_id, order_item_id, quantity)
    values (v_shipment.id, v_order_item.id, v_quantity)
    returning * into v_shipment_item;
    v_created := v_created || jsonb_build_array(to_jsonb(v_shipment_item));
  end loop;

  perform public.business_refresh_order_fulfillment_status(p_order_id);
  update public.business_orders set version = version + 1 where id = p_order_id;
  v_result := jsonb_build_object('shipment', to_jsonb(v_shipment), 'items', v_created);
  perform public.write_business_lifecycle_audit(
    p_order_id, v_order.customer_id, 'shipment', v_shipment.id,
    'create', null, v_result, null, v_uid
  );
  insert into public.business_rpc_idempotency (
    actor_id, operation, idempotency_key, payload_hash, result
  ) values (v_uid, 'create_business_order_shipment', btrim(p_idempotency_key), v_hash, v_result);
  return v_result;
end;
$$;
revoke all on function public.create_business_order_shipment(
  uuid, timestamptz, text, text, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_business_order_shipment(
  uuid, timestamptz, text, text, jsonb, text
) to authenticated;

create or replace function public.void_business_order_payment_allocation(
  p_allocation_id uuid,
  p_reason text
)
returns public.business_order_payment_allocations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_allocation public.business_order_payment_allocations%rowtype;
  v_order public.business_orders%rowtype;
  v_transfer public.business_customer_transfers%rowtype;
  v_old jsonb;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved' then raise exception 'Approved account required'; end if;
  if nullif(btrim(p_reason), '') is null or char_length(btrim(p_reason)) > 1000 then
    raise exception 'Void reason is required and cannot exceed 1000 characters';
  end if;
  select * into v_allocation from public.business_order_payment_allocations where id = p_allocation_id;
  if not found then raise exception 'Active allocation does not exist'; end if;
  select * into v_transfer from public.business_customer_transfers
  where id = v_allocation.transfer_id for update;
  select * into v_order from public.business_orders where id = v_allocation.order_id for update;
  select * into v_allocation from public.business_order_payment_allocations
  where id = p_allocation_id for update;
  if not found or v_allocation.voided_at is not null then raise exception 'Active allocation does not exist'; end if;
  if v_order.status::text = 'completed' then raise exception 'Completed business order is immutable'; end if;
  if v_order.closed_at is not null then raise exception 'Closed business order is immutable'; end if;

  if v_actor.role::text in ('sales', 'supervisor') then
    if v_order.salesperson_id is distinct from v_uid then
      raise exception 'Sales user cannot void another owner allocation';
    end if;
  elsif v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Role cannot void payment allocations';
  end if;

  v_old := to_jsonb(v_allocation);
  update public.business_order_payment_allocations set
    voided_at = now(), voided_by = v_uid, void_reason = btrim(p_reason)
  where id = p_allocation_id returning * into v_allocation;
  perform public.business_refresh_order_payment_status(v_order.id);
  update public.business_orders set version = version + 1 where id = v_order.id;
  perform public.write_business_lifecycle_audit(
    v_order.id, v_transfer.customer_id, 'allocation', v_allocation.id,
    'void', v_old, to_jsonb(v_allocation), p_reason, v_uid
  );
  return v_allocation;
end;
$$;
revoke all on function public.void_business_order_payment_allocation(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.void_business_order_payment_allocation(uuid, text)
  to authenticated;

-- 覆盖 0028 旧入口：整笔转账若关联任一特殊关闭订单，必须保持不可变。
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
  if not public.can_manage_business_customer(v_transfer.customer_id) then
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
    null, v_transfer.customer_id, 'transfer', v_transfer.id,
    'void', v_old, to_jsonb(v_transfer), p_reason, v_uid
  );
  return v_transfer;
end;
$$;
revoke all on function public.void_business_customer_transfer(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.void_business_customer_transfer(uuid, text) to authenticated;

create or replace function public.void_business_order_shipment(
  p_shipment_id uuid,
  p_reason text
)
returns public.business_order_shipments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_shipment public.business_order_shipments%rowtype;
  v_old jsonb;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved' then raise exception 'Approved account required'; end if;
  if nullif(btrim(p_reason), '') is null or char_length(btrim(p_reason)) > 1000 then
    raise exception 'Void reason is required and cannot exceed 1000 characters';
  end if;
  select * into v_shipment from public.business_order_shipments
  where id = p_shipment_id for update;
  if not found or v_shipment.voided_at is not null then raise exception 'Active shipment does not exist'; end if;
  select * into v_order from public.business_orders where id = v_shipment.order_id for update;
  if v_order.status::text = 'completed' then raise exception 'Completed business order is immutable'; end if;
  if v_order.closed_at is not null then raise exception 'Closed business order is immutable'; end if;
  if exists (
    select 1 from public.business_order_shipment_items si
    join public.business_order_return_items ri on ri.shipment_item_id = si.id
    join public.business_order_returns r on r.id = ri.return_id
    where si.shipment_id = v_shipment.id and r.voided_at is null
  ) then raise exception 'Shipment with active returns cannot be voided'; end if;

  if v_actor.role::text in ('sales', 'supervisor') then
    if v_order.salesperson_id is distinct from v_uid then
      raise exception 'Sales user cannot void another owner shipment';
    end if;
  elsif v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Role cannot void shipments';
  end if;

  v_old := to_jsonb(v_shipment);
  update public.business_order_shipments set
    voided_at = now(), voided_by = v_uid, void_reason = btrim(p_reason)
  where id = p_shipment_id returning * into v_shipment;
  perform public.business_refresh_order_fulfillment_status(v_order.id);
  update public.business_orders set version = version + 1 where id = v_order.id;
  perform public.write_business_lifecycle_audit(
    v_order.id, v_order.customer_id, 'shipment', v_shipment.id,
    'void', v_old, to_jsonb(v_shipment), p_reason, v_uid
  );
  return v_shipment;
end;
$$;
revoke all on function public.void_business_order_shipment(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.void_business_order_shipment(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 7. 新增敏感 RPC：退货、特殊关闭、编辑约束、产品库管理列表
-- -----------------------------------------------------------------------------
create or replace function public.create_business_order_return(
  p_order_id uuid,
  p_returned_at timestamptz,
  p_notes text,
  p_items jsonb,
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
  v_order public.business_orders%rowtype;
  v_return public.business_order_returns%rowtype;
  v_return_item public.business_order_return_items%rowtype;
  v_source_item_id uuid;
  v_source_order_item_id uuid;
  v_source_order_id uuid;
  v_source_shipped_at timestamptz;
  v_item jsonb;
  v_shipment_item_id uuid;
  v_quantity numeric;
  v_hash text;
  v_idempotency public.business_rpc_idempotency%rowtype;
  v_created jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Only approved administrators or finance users can register returns';
  end if;
  select * into v_order from public.business_orders bo where bo.id = p_order_id for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if v_order.status::text = 'completed' then raise exception 'Completed business order is immutable'; end if;
  if v_order.closed_at is not null then raise exception 'Closed business order cannot receive new returns'; end if;
  if p_returned_at is null then raise exception 'Returned time is required'; end if;
  if p_returned_at > now() then raise exception 'Returned time cannot be later than current time'; end if;
  if char_length(coalesce(p_notes, '')) > 1000 then raise exception 'Return notes cannot exceed 1000 characters'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 500 then
    raise exception 'Return items count must be between 1 and 500';
  end if;
  if nullif(btrim(p_idempotency_key), '') is null
     or char_length(btrim(p_idempotency_key)) > 200 then raise exception 'Idempotency key is invalid'; end if;
  if exists (
    select 1 from jsonb_to_recordset(p_items) as x(shipment_item_id uuid, quantity numeric)
    group by x.shipment_item_id having x.shipment_item_id is null or count(*) > 1
  ) then raise exception 'Each return shipment_item_id must be unique'; end if;

  v_hash := encode(digest(jsonb_build_object(
    'order_id', p_order_id, 'returned_at', p_returned_at,
    'notes', nullif(btrim(p_notes), ''), 'items', p_items
  )::text, 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    v_uid::text || ':create_business_order_return:' || btrim(p_idempotency_key), 0));
  select * into v_idempotency from public.business_rpc_idempotency
  where actor_id = v_uid and operation = 'create_business_order_return'
    and idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_idempotency.payload_hash <> v_hash then
      raise exception 'Idempotency key was already used with a different payload';
    end if;
    return v_idempotency.result;
  end if;

  perform si.id
  from public.business_order_shipment_items si
  join (select x.shipment_item_id from jsonb_to_recordset(p_items)
        as x(shipment_item_id uuid, quantity numeric)) requested
    on requested.shipment_item_id = si.id
  order by si.id for update of si;

  insert into public.business_order_returns (
    order_id, returned_at, notes, idempotency_key, payload_hash, created_by
  ) values (
    p_order_id, p_returned_at, nullif(btrim(p_notes), ''),
    btrim(p_idempotency_key), v_hash, v_uid
  ) returning * into v_return;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_shipment_item_id := nullif(v_item->>'shipment_item_id', '')::uuid;
    v_quantity := round((v_item->>'quantity')::numeric, 4);
    if v_quantity is null or v_quantity <= 0 or v_quantity > 999999999999 then
      raise exception 'Return quantity is invalid';
    end if;
    select si.id, si.order_item_id, s.order_id, s.shipped_at
      into v_source_item_id, v_source_order_item_id, v_source_order_id, v_source_shipped_at
    from public.business_order_shipment_items si
    join public.business_order_shipments s on s.id = si.shipment_id
    where si.id = v_shipment_item_id and s.voided_at is null;
    if not found or v_source_order_id is distinct from p_order_id then
      raise exception 'Return shipment item does not belong to an active shipment of order';
    end if;
    if p_returned_at < v_source_shipped_at then
      raise exception 'Returned time cannot be earlier than source shipment time';
    end if;

    insert into public.business_order_return_items (
      return_id, order_id, shipment_item_id, order_item_id, quantity
    ) values (
      v_return.id, p_order_id, v_source_item_id, v_source_order_item_id, v_quantity
    ) returning * into v_return_item;
    v_created := v_created || jsonb_build_array(to_jsonb(v_return_item));
  end loop;

  perform public.business_refresh_order_fulfillment_status(p_order_id);
  update public.business_orders set version = version + 1 where id = p_order_id;
  v_result := jsonb_build_object('return', to_jsonb(v_return), 'items', v_created);
  perform public.write_business_lifecycle_audit(
    p_order_id, v_order.customer_id, 'return', v_return.id,
    'create', null, v_result, null, v_uid
  );
  insert into public.business_rpc_idempotency (
    actor_id, operation, idempotency_key, payload_hash, result
  ) values (v_uid, 'create_business_order_return', btrim(p_idempotency_key), v_hash, v_result);
  return v_result;
end;
$$;
revoke all on function public.create_business_order_return(
  uuid, timestamptz, text, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_business_order_return(
  uuid, timestamptz, text, jsonb, text
) to authenticated;

create or replace function public.void_business_order_return(
  p_return_id uuid,
  p_reason text
)
returns public.business_order_returns
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_return public.business_order_returns%rowtype;
  v_old jsonb;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Only approved administrators or finance users can void returns';
  end if;
  if nullif(btrim(p_reason), '') is null or char_length(btrim(p_reason)) > 1000 then
    raise exception 'Void reason is required and cannot exceed 1000 characters';
  end if;
  select * into v_return from public.business_order_returns
  where id = p_return_id for update;
  if not found or v_return.voided_at is not null then raise exception 'Active business order return does not exist'; end if;
  select * into v_order from public.business_orders where id = v_return.order_id for update;
  if v_order.status::text = 'completed' then raise exception 'Completed business order is immutable'; end if;
  if v_order.closed_at is not null then raise exception 'Closed business order returns are immutable'; end if;

  v_old := to_jsonb(v_return);
  update public.business_order_returns set
    voided_at = now(), voided_by = v_uid, void_reason = btrim(p_reason)
  where id = p_return_id returning * into v_return;
  perform public.business_refresh_order_fulfillment_status(v_order.id);
  update public.business_orders set version = version + 1 where id = v_order.id;
  perform public.write_business_lifecycle_audit(
    v_order.id, v_order.customer_id, 'return', v_return.id,
    'void', v_old, to_jsonb(v_return), p_reason, v_uid
  );
  return v_return;
end;
$$;
revoke all on function public.void_business_order_return(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.void_business_order_return(uuid, text) to authenticated;

create or replace function public.close_business_order_special(
  p_order_id uuid,
  p_expected_version int,
  p_reason text
)
returns public.business_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_old jsonb;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved' or v_actor.role::text <> 'admin' then
    raise exception 'Only an approved administrator can specially close a business order';
  end if;
  if nullif(btrim(p_reason), '') is null or char_length(btrim(p_reason)) > 1000 then
    raise exception 'Close reason is required and cannot exceed 1000 characters';
  end if;
  select * into v_order from public.business_orders bo where bo.id = p_order_id for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if v_order.version <> p_expected_version then raise exception 'Business order version conflict'; end if;
  if v_order.status::text = 'completed' then raise exception 'Completed business order cannot be specially closed'; end if;
  if v_order.closed_at is not null then raise exception 'Business order is already closed'; end if;

  v_old := to_jsonb(v_order);
  update public.business_orders set
    closed_at = now(), closed_by = v_uid, close_reason = btrim(p_reason),
    version = version + 1
  where id = p_order_id returning * into v_order;
  perform public.write_business_lifecycle_audit(
    v_order.id, v_order.customer_id, 'closure', v_order.id,
    'special_close', v_old, to_jsonb(v_order), p_reason, v_uid
  );
  return v_order;
end;
$$;
revoke all on function public.close_business_order_special(uuid, int, text)
  from public, anon, authenticated, service_role;
grant execute on function public.close_business_order_special(uuid, int, text)
  to authenticated;

create or replace function public.get_business_order_edit_constraints(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_order public.business_orders%rowtype;
  v_allocated numeric;
  v_items jsonb;
begin
  if not public.can_view_business_order(p_order_id) then
    raise exception 'Business order is not accessible';
  end if;
  select * into v_order from public.business_orders bo where bo.id = p_order_id;
  if not found then raise exception 'Business order does not exist'; end if;

  select coalesce(sum(a.amount), 0) into v_allocated
  from public.business_order_payment_allocations a
  join public.business_customer_transfers t on t.id = a.transfer_id
  where a.order_id = p_order_id and a.voided_at is null and t.voided_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
    'order_item_id', i.id,
    'source_type', i.source_type,
    'product_id', i.product_id,
    'custom_product_id', i.custom_product_id,
    'custom_product_version_id', i.custom_product_version_id,
    'ordered_quantity', i.quantity,
    'gross_shipped_quantity', coalesce(q.gross_shipped, 0),
    'returned_quantity', coalesce(q.returned, 0),
    'net_shipped_quantity', coalesce(q.gross_shipped, 0) - coalesce(q.returned, 0),
    'minimum_quantity', coalesce(q.gross_shipped, 0) - coalesce(q.returned, 0),
    'can_delete', v_order.status::text <> 'completed' and v_order.closed_at is null
                  and v_allocated = 0 and coalesce(q.gross_shipped, 0) = 0,
    'can_replace_product', v_order.status::text <> 'completed' and v_order.closed_at is null
                          and v_allocated = 0 and coalesce(q.gross_shipped, 0) = 0,
    'can_change_unit_price', v_order.status::text <> 'completed'
                             and v_order.closed_at is null and v_allocated = 0
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
    'has_active_allocation', v_allocated > 0,
    'active_allocated_amount', v_allocated,
    'can_edit_order', v_order.status::text in ('draft', 'rejected') and v_order.closed_at is null,
    'can_add_allocation', v_order.status::text <> 'completed' and v_order.closed_at is null,
    'can_add_shipment', v_order.status::text = 'approved' and v_order.approval_status = 'approved'
                        and v_order.closed_at is null,
    'items', v_items
  );
end;
$$;
revoke all on function public.get_business_order_edit_constraints(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_business_order_edit_constraints(uuid) to authenticated;

create index if not exists idx_business_custom_product_versions_search
  on public.business_custom_product_versions
  using gin ((coalesce(code, '') || ' ' || coalesce(name, '')) gin_trgm_ops);

create or replace function public.list_business_custom_products_library(
  p_search text,
  p_customer_id uuid,
  p_scope text,
  p_status text
)
returns table (
  custom_product_id uuid,
  customer_id uuid,
  customer_name text,
  is_shared boolean,
  is_archived boolean,
  created_by uuid,
  created_at timestamptz,
  updated_by uuid,
  updated_at timestamptz,
  latest_version_id uuid,
  latest_version_no int,
  version_count bigint,
  code text,
  name text,
  description text,
  specification text,
  unit text,
  image_url text,
  default_unit_price numeric,
  default_currency public.currency_code
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_scope text := coalesce(nullif(lower(btrim(p_scope)), ''), 'accessible');
  v_status text := coalesce(nullif(lower(btrim(p_status)), ''), 'active');
  v_search text := nullif(btrim(p_search), '');
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved business role required';
  end if;
  if v_scope not in ('accessible', 'owned', 'shared', 'customer', 'all') then
    raise exception 'Invalid custom product library scope';
  end if;
  if v_status not in ('active', 'archived', 'all') then
    raise exception 'Invalid custom product library status';
  end if;
  if v_scope = 'all' and v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Only administrators or finance can list all custom products';
  end if;
  if (v_scope = 'customer' or p_customer_id is not null)
     and p_customer_id is null then raise exception 'Customer scope requires customer_id'; end if;
  if p_customer_id is not null and v_actor.role::text not in ('admin', 'finance')
     and not public.can_access_business_customer(p_customer_id) then
    raise exception 'Customer is not accessible';
  end if;

  return query
  select cp.id, cp.customer_id,
         coalesce(nullif(btrim(c.company), ''), c.name),
         cp.is_shared, cp.is_archived, cp.created_by, cp.created_at,
         cp.updated_by, cp.updated_at,
         latest.id, latest.version_no, counts.version_count,
         latest.code, latest.name, latest.description, latest.specification,
         latest.unit, latest.image_url, latest.default_unit_price,
         latest.default_currency
  from public.business_custom_products cp
  join public.customers c on c.id = cp.customer_id
  left join lateral (
    select v.* from public.business_custom_product_versions v
    where v.custom_product_id = cp.id
    order by v.version_no desc limit 1
  ) latest on true
  cross join lateral (
    select count(*) as version_count
    from public.business_custom_product_versions v
    where v.custom_product_id = cp.id
  ) counts
  where
    (
      v_actor.role::text in ('admin', 'finance')
      or public.can_access_business_customer(cp.customer_id)
    )
    and (p_customer_id is null or cp.customer_id = p_customer_id)
    and (v_scope <> 'owned' or cp.created_by = v_uid)
    and (v_scope <> 'shared' or cp.is_shared)
    and (v_scope <> 'customer' or cp.customer_id = p_customer_id)
    and (v_status = 'all'
         or (v_status = 'active' and not cp.is_archived)
         or (v_status = 'archived' and cp.is_archived))
    and (v_search is null or concat_ws(' ', latest.code, latest.name,
          latest.description, latest.specification, c.name, c.company) ilike '%' || v_search || '%')
  order by cp.updated_at desc, cp.id;
end;
$$;
revoke all on function public.list_business_custom_products_library(text, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_business_custom_products_library(text, uuid, text, text)
  to authenticated;

-- -----------------------------------------------------------------------------
-- 8. 结算摘要改用净发货
-- -----------------------------------------------------------------------------
create or replace function public.get_business_order_settlement_summary(p_order_id uuid)
returns table (
  order_id uuid,
  currency public.currency_code,
  total_amount numeric,
  allocated_amount numeric,
  outstanding_amount numeric,
  payment_status text,
  payment_due_date date,
  item_quantity numeric,
  shipped_quantity numeric,
  fulfillment_status text
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.can_view_business_order(p_order_id) then
    raise exception 'Business order is not accessible';
  end if;
  return query
  select bo.id, bo.currency, bo.total_amount,
         coalesce(pay.amount, 0), greatest(bo.total_amount - coalesce(pay.amount, 0), 0),
         bo.payment_status, bo.payment_due_date,
         coalesce(items.quantity, 0), coalesce(items.net_shipped, 0), bo.fulfillment_status
  from public.business_orders bo
  left join lateral (
    select sum(a.amount) as amount
    from public.business_order_payment_allocations a
    join public.business_customer_transfers t on t.id = a.transfer_id
    where a.order_id = bo.id and a.voided_at is null and t.voided_at is null
  ) pay on true
  left join lateral (
    select sum(i.quantity) as quantity,
           sum(public.business_order_item_net_shipped(i.id)) as net_shipped
    from public.business_order_items i where i.order_id = bo.id
  ) items on true
  where bo.id = p_order_id;
end;
$$;
revoke all on function public.get_business_order_settlement_summary(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_business_order_settlement_summary(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 9. RLS 与最小权限
-- -----------------------------------------------------------------------------
alter table public.business_order_returns enable row level security;
alter table public.business_order_return_items enable row level security;

revoke all on table public.business_order_returns
  from public, anon, authenticated, service_role;
revoke all on table public.business_order_return_items
  from public, anon, authenticated, service_role;
grant select on table public.business_order_returns to authenticated;
grant select on table public.business_order_return_items to authenticated;

drop policy if exists "business_order_returns_select" on public.business_order_returns;
create policy "business_order_returns_select" on public.business_order_returns
  for select to authenticated
  using (public.can_view_business_order(order_id));

drop policy if exists "business_order_return_items_select" on public.business_order_return_items;
create policy "business_order_return_items_select" on public.business_order_return_items
  for select to authenticated
  using (public.can_view_business_order(order_id));

-- 新建订单 V2 仍是客户端入口；显式重做 grant，避免默认 EXECUTE 漂移。
revoke all on function public.create_business_order_v2(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb, date
) from public, anon, authenticated, service_role;
grant execute on function public.create_business_order_v2(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb, date
) to authenticated;

comment on function public.create_business_order_return(uuid, timestamptz, text, jsonb, text) is
  '管理员/财务按原发货明细登记产品级部分退货；items=[{shipment_item_id,quantity}]，支持幂等键';
comment on function public.void_business_order_return(uuid, text) is
  '管理员/财务作废退货；若作废后净发货超过订购数量则拒绝';
comment on function public.close_business_order_special(uuid, int, text) is
  '管理员以 expected_version 乐观锁特殊关闭未完成订单，原因必填';
comment on function public.get_business_order_edit_constraints(uuid) is
  '返回订单与逐行编辑约束，包括有效分摊、毛发货、有效退货和净发货数量';
comment on function public.list_business_custom_products_library(text, uuid, text, text) is
  '定制产品管理列表；scope=accessible|owned|shared|customer|all，status=active|archived|all';
