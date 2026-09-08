-- 0028_business_order_custom_lifecycle.sql
-- 定制产品版本、客户转账/订单分摊、分批发货和订单款货生命周期。
-- 本迁移仅使用既有枚举值，兼容 psql --single-transaction。

-- -----------------------------------------------------------------------------
-- 1. 定制产品与不可变版本
-- -----------------------------------------------------------------------------
create table public.business_custom_products (
  id           uuid primary key default uuid_generate_v4(),
  customer_id  uuid not null references public.customers(id) on delete restrict,
  is_shared    boolean not null default false,
  is_archived  boolean not null default false,
  created_by   uuid references public.profiles(id) on delete set null,
  updated_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.business_custom_product_versions (
  id                    uuid primary key default uuid_generate_v4(),
  custom_product_id     uuid not null references public.business_custom_products(id) on delete restrict,
  version_no            int not null check (version_no > 0),
  code                  text not null check (char_length(btrim(code)) between 1 and 100),
  name                  text not null check (char_length(btrim(name)) between 1 and 300),
  description           text check (description is null or char_length(description) <= 4000),
  specification         text check (specification is null or char_length(specification) <= 2000),
  unit                  text not null check (char_length(btrim(unit)) between 1 and 100),
  image_url             text check (image_url is null or char_length(image_url) <= 2000),
  default_unit_price    numeric(18,2) not null check (
    default_unit_price >= 0 and default_unit_price <= 999999999999
  ),
  default_currency      public.currency_code not null,
  created_by            uuid references public.profiles(id) on delete set null,
  created_at            timestamptz not null default now(),
  unique (custom_product_id, version_no),
  unique (id, custom_product_id)
);

comment on table public.business_custom_products is
  '客户归属的定制产品身份；默认私有，共享/归档仅由管理员或财务切换';
comment on table public.business_custom_product_versions is
  '定制产品不可变版本；业务订单只引用明确版本并保留行快照';

create index idx_business_custom_products_customer_active
  on public.business_custom_products (customer_id, is_archived, created_at desc);
create index idx_business_custom_products_shared_active
  on public.business_custom_products (is_shared, is_archived) where is_shared;
create index idx_business_custom_products_created_by
  on public.business_custom_products (created_by);
create index idx_business_custom_product_versions_product
  on public.business_custom_product_versions (custom_product_id, version_no desc);
create index idx_business_custom_product_versions_code
  on public.business_custom_product_versions (code);

create trigger trg_business_custom_products_touch
  before update on public.business_custom_products
  for each row execute function public.touch_updated_at();

create or replace function public.prevent_business_custom_product_version_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Business custom product versions are immutable';
end;
$$;
revoke all on function public.prevent_business_custom_product_version_mutation()
  from public, anon, authenticated, service_role;

create trigger trg_business_custom_product_versions_immutable
  before update or delete on public.business_custom_product_versions
  for each row execute function public.prevent_business_custom_product_version_mutation();

-- -----------------------------------------------------------------------------
-- 2. 订单行来源与定制版本合法组合
-- -----------------------------------------------------------------------------
alter table public.business_order_items
  add column source_type text not null default 'catalog',
  add column custom_product_id uuid,
  add column custom_product_version_id uuid;

-- 历史产品可能已被删除，旧 FK 会将 product_id 置空；保留快照并标记为 legacy，
-- 避免新增来源约束阻断生产迁移。临时禁用 touch 触发器，避免迁移伪造历史更新时间。
alter table public.business_order_items disable trigger trg_business_order_items_touch;

update public.business_order_items
set source_type = 'legacy'
where product_id is null;

alter table public.business_order_items enable trigger trg_business_order_items_touch;

alter table public.business_order_items alter column product_id drop not null;

alter table public.business_order_items
  add constraint business_order_items_source_type_check
    check (source_type in ('catalog', 'custom', 'legacy')),
  add constraint business_order_items_source_exclusive_check
    check (
      (source_type = 'catalog'
       and product_id is not null
       and custom_product_id is null
       and custom_product_version_id is null)
      or
      (source_type = 'custom'
       and product_id is null
       and custom_product_id is not null
       and custom_product_version_id is not null)
      or
      (source_type = 'legacy'
       and product_id is null
       and custom_product_id is null
       and custom_product_version_id is null)
    ),
  add constraint business_order_items_custom_product_fk
    foreign key (custom_product_id)
    references public.business_custom_products(id) on delete restrict,
  add constraint business_order_items_custom_version_product_fk
    foreign key (custom_product_version_id, custom_product_id)
    references public.business_custom_product_versions(id, custom_product_id) on delete restrict;

create index idx_business_order_items_custom_product
  on public.business_order_items (custom_product_id) where custom_product_id is not null;
create index idx_business_order_items_custom_version
  on public.business_order_items (custom_product_version_id) where custom_product_version_id is not null;

-- 产品删除时旧 FK 会把 product_id 置空；同步把 catalog 快照转成 legacy，
-- 避免 ON DELETE SET NULL 与来源互斥约束冲突。
create or replace function public.mark_business_order_item_legacy_on_product_delete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.source_type = 'catalog' and new.product_id is null then
    new.source_type := 'legacy';
  end if;
  return new;
end;
$$;
revoke all on function public.mark_business_order_item_legacy_on_product_delete()
  from public, anon, authenticated, service_role;

create trigger trg_business_order_item_product_legacy
  before update of product_id on public.business_order_items
  for each row execute function public.mark_business_order_item_legacy_on_product_delete();

-- -----------------------------------------------------------------------------
-- 3. 正交生命周期字段；历史 completed 使用 gate=1，其余及新订单使用 gate=2
-- -----------------------------------------------------------------------------
alter table public.business_orders
  add column approval_status text not null default 'draft'
    check (approval_status in ('draft', 'submitted', 'rejected', 'approved')),
  add column payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid', 'partially_paid', 'fully_paid')),
  add column fulfillment_status text not null default 'unshipped'
    check (fulfillment_status in ('unshipped', 'partially_shipped', 'fully_shipped')),
  add column payment_due_date date,
  add column completion_gate_version int not null default 2
    check (completion_gate_version in (1, 2)),
  add constraint business_orders_payment_due_date_check
    check (payment_due_date is null or payment_due_date >= order_date);

-- 生命周期历史回填不应伪造业务订单最后修改时间。
alter table public.business_orders disable trigger trg_business_orders_touch;

update public.business_orders
set approval_status = case status::text
  when 'draft' then 'draft'
  when 'submitted' then 'submitted'
  when 'rejected' then 'rejected'
  when 'approved' then 'approved'
  when 'completed' then 'approved'
end,
completion_gate_version = case when status::text = 'completed' then 1 else 2 end;

create index idx_business_orders_approval_status_date
  on public.business_orders (approval_status, order_date desc);
create index idx_business_orders_payment_status_due
  on public.business_orders (payment_status, payment_due_date)
  where payment_status <> 'fully_paid';
create index idx_business_orders_fulfillment_status
  on public.business_orders (fulfillment_status, order_date desc);

-- -----------------------------------------------------------------------------
-- 4. 客户转账、订单分摊和幂等记录
-- -----------------------------------------------------------------------------
create table public.business_customer_transfers (
  id                    uuid primary key default uuid_generate_v4(),
  customer_id           uuid not null references public.customers(id) on delete restrict,
  currency              public.currency_code not null,
  amount                numeric(18,2) not null check (amount > 0 and amount <= 999999999999),
  exchange_rate_to_cny  numeric(18,8) not null check (
    exchange_rate_to_cny > 0 and exchange_rate_to_cny <= 1000000
  ),
  received_at           timestamptz not null,
  payment_type          public.business_payment_type not null,
  proof_path            text not null unique,
  notes                 text check (notes is null or char_length(notes) <= 1000),
  idempotency_key       text check (
    idempotency_key is null or char_length(btrim(idempotency_key)) between 1 and 200
  ),
  payload_hash          text,
  created_by            uuid references public.profiles(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_by            uuid references public.profiles(id) on delete set null,
  updated_at            timestamptz not null default now(),
  voided_at             timestamptz,
  voided_by             uuid references public.profiles(id) on delete set null,
  void_reason           text check (void_reason is null or char_length(void_reason) <= 1000),
  legacy_payment_id     uuid unique references public.business_order_payments(id) on delete restrict,
  constraint business_customer_transfer_cny_rate check (
    currency <> 'CNY' or exchange_rate_to_cny = 1
  ),
  constraint business_customer_transfer_proof_path check (
    -- 旧收款保留 uid/order_id/file；新客户转账固定使用 uid/customer/customer_id/file，
    -- 用显式命名空间消除客户 UUID 与订单 UUID 碰撞时的越权读取。
    proof_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
    or proof_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/customer/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
  ),
  constraint business_customer_transfer_void_actor check (
    (voided_at is null and voided_by is null)
    or (voided_at is not null and voided_by is not null)
  )
);

create unique index idx_business_customer_transfers_idempotency
  on public.business_customer_transfers (created_by, idempotency_key)
  where idempotency_key is not null;
create index idx_business_customer_transfers_customer_currency
  on public.business_customer_transfers (customer_id, currency, received_at desc);
create index idx_business_customer_transfers_active
  on public.business_customer_transfers (customer_id, currency)
  where voided_at is null;
create index idx_business_customer_transfers_created_by
  on public.business_customer_transfers (created_by);
create index idx_business_customer_transfers_updated_by
  on public.business_customer_transfers (updated_by);
create index idx_business_customer_transfers_voided_by
  on public.business_customer_transfers (voided_by);

create table public.business_order_payment_allocations (
  id              uuid primary key default uuid_generate_v4(),
  transfer_id     uuid not null references public.business_customer_transfers(id) on delete restrict,
  order_id        uuid not null references public.business_orders(id) on delete restrict,
  amount          numeric(18,2) not null check (amount > 0 and amount <= 999999999999),
  payment_type    public.business_payment_type not null,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  voided_at       timestamptz,
  voided_by       uuid references public.profiles(id) on delete set null,
  void_reason     text check (void_reason is null or char_length(void_reason) <= 1000),
  legacy_payment_id uuid unique references public.business_order_payments(id) on delete restrict,
  constraint business_order_payment_allocation_void_actor check (
    (voided_at is null and voided_by is null)
    or (voided_at is not null and voided_by is not null)
  )
);

create index idx_business_order_allocations_transfer_active
  on public.business_order_payment_allocations (transfer_id) where voided_at is null;
create index idx_business_order_allocations_order_active
  on public.business_order_payment_allocations (order_id) where voided_at is null;
create index idx_business_order_allocations_created_by
  on public.business_order_payment_allocations (created_by);
create index idx_business_order_allocations_voided_by
  on public.business_order_payment_allocations (voided_by);

create table public.business_rpc_idempotency (
  actor_id       uuid not null references public.profiles(id) on delete restrict,
  operation      text not null check (char_length(operation) between 1 and 100),
  idempotency_key text not null check (char_length(btrim(idempotency_key)) between 1 and 200),
  payload_hash   text not null,
  result         jsonb not null,
  created_at     timestamptz not null default now(),
  primary key (actor_id, operation, idempotency_key)
);

-- 旧支付必须有订单客户，且支付币种必须与订单币种一致；不猜测客户或汇率。
do $$
begin
  if exists (
    select 1
    from public.business_order_payments bp
    join public.business_orders bo on bo.id = bp.order_id
    where bo.customer_id is null
  ) then
    raise exception 'Cannot migrate legacy business payment: order customer is null';
  end if;

  if exists (
    select 1
    from public.business_order_payments bp
    join public.business_orders bo on bo.id = bp.order_id
    where bp.currency is distinct from bo.currency
  ) then
    raise exception 'Cannot migrate legacy business payment: payment/order currency mismatch';
  end if;
end;
$$;

-- 每条旧支付确定性映射为同 UUID 的客户转账。有效旧支付只分摊到当时尚欠金额，
-- 超出订单总额的部分保留为该客户同币种预收款；已作废旧支付保留作废分摊审计。
insert into public.business_customer_transfers (
  id, customer_id, currency, amount, exchange_rate_to_cny, received_at,
  payment_type, proof_path, notes, payload_hash, created_by, created_at,
  updated_by, updated_at, voided_at, voided_by, void_reason, legacy_payment_id
)
select
  bp.id, bo.customer_id, bp.currency, bp.amount, bp.exchange_rate_to_cny, bp.received_at,
  bp.payment_type, bp.proof_path, bp.notes, md5(to_jsonb(bp)::text), bp.created_by, bp.created_at,
  bp.updated_by, bp.updated_at, bp.voided_at, bp.voided_by,
  (select bal.reason
   from public.business_order_audit_logs bal
   where bal.entity_type = 'payment'
     and bal.entity_id = bp.id
     and bal.action::text = 'payment_void'
   order by bal.created_at desc
   limit 1),
  bp.id
from public.business_order_payments bp
join public.business_orders bo on bo.id = bp.order_id;

with legacy_payments as (
  select
    bp.*,
    bo.total_amount,
    coalesce(sum(bp.amount) filter (where bp.voided_at is null) over (
      partition by bp.order_id
      order by bp.received_at, bp.created_at, bp.id
      rows between unbounded preceding and 1 preceding
    ), 0) as prior_active_amount
  from public.business_order_payments bp
  join public.business_orders bo on bo.id = bp.order_id
)
insert into public.business_order_payment_allocations (
  id, transfer_id, order_id, amount, payment_type, created_by, created_at,
  voided_at, voided_by, void_reason, legacy_payment_id
)
select
  bp.id, bp.id, bp.order_id,
  case
    when bp.voided_at is not null then bp.amount
    else least(bp.amount, greatest(bp.total_amount - bp.prior_active_amount, 0))
  end,
  bp.payment_type, bp.created_by, bp.created_at,
  bp.voided_at, bp.voided_by,
  (select bal.reason
   from public.business_order_audit_logs bal
   where bal.entity_type = 'payment'
     and bal.entity_id = bp.id
     and bal.action::text = 'payment_void'
   order by bal.created_at desc
   limit 1),
  bp.id
from legacy_payments bp
where bp.voided_at is not null
   or bp.total_amount > bp.prior_active_amount;

-- 旧表保留只读兼容，并关闭所有旧写 RPC。
revoke insert, update, delete on table public.business_order_payments from authenticated;
revoke all on function public.add_business_order_payment(
  uuid, public.business_payment_type, numeric, timestamptz, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.update_business_order_payment(
  uuid, public.business_payment_type, numeric, timestamptz, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.void_business_order_payment(uuid, text)
  from public, anon, authenticated, service_role;

-- 0017 创建这些内部 helper 时只撤销了 PUBLIC；Supabase default privileges 还可能
-- 显式授予 anon/authenticated/service_role。它们只能由受控 SECURITY DEFINER RPC 调用。
revoke all on function public.next_business_order_number()
  from public, anon, authenticated, service_role;
revoke all on function public.write_business_order_audit(
  uuid, text, uuid, public.business_audit_action,
  public.business_order_status, public.business_order_status,
  jsonb, jsonb, text, uuid
) from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. 发货批次
-- -----------------------------------------------------------------------------
create table public.business_order_shipments (
  id              uuid primary key default uuid_generate_v4(),
  order_id        uuid not null references public.business_orders(id) on delete restrict,
  shipped_at      timestamptz not null,
  tracking_number text check (tracking_number is null or char_length(tracking_number) <= 200),
  notes           text check (notes is null or char_length(notes) <= 1000),
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  voided_at       timestamptz,
  voided_by       uuid references public.profiles(id) on delete set null,
  void_reason     text check (void_reason is null or char_length(void_reason) <= 1000),
  constraint business_order_shipment_void_actor check (
    (voided_at is null and voided_by is null)
    or (voided_at is not null and voided_by is not null)
  )
);

create table public.business_order_shipment_items (
  id             uuid primary key default uuid_generate_v4(),
  shipment_id    uuid not null references public.business_order_shipments(id) on delete restrict,
  order_item_id  uuid not null references public.business_order_items(id) on delete restrict,
  quantity       numeric(18,4) not null check (quantity > 0 and quantity <= 999999999999),
  created_at     timestamptz not null default now(),
  unique (shipment_id, order_item_id)
);

create index idx_business_order_shipments_order_active
  on public.business_order_shipments (order_id, shipped_at desc) where voided_at is null;
create index idx_business_order_shipments_created_by
  on public.business_order_shipments (created_by);
create index idx_business_order_shipments_voided_by
  on public.business_order_shipments (voided_by);
create index idx_business_order_shipment_items_item
  on public.business_order_shipment_items (order_item_id);

-- -----------------------------------------------------------------------------
-- 6. 文本审计（避免在同一事务中扩展并使用既有审计枚举）
-- -----------------------------------------------------------------------------
create table public.business_lifecycle_audit_logs (
  id             bigint generated always as identity primary key,
  order_id       uuid references public.business_orders(id) on delete restrict,
  customer_id    uuid references public.customers(id) on delete restrict,
  entity_type    text not null check (
    entity_type in ('custom_product', 'custom_product_version', 'transfer', 'allocation', 'shipment')
  ),
  entity_id      uuid not null,
  action         text not null check (char_length(action) between 1 and 100),
  old_data       jsonb,
  new_data       jsonb,
  reason         text check (reason is null or char_length(reason) <= 1000),
  actor_id       uuid references public.profiles(id) on delete set null,
  actor_snapshot jsonb not null,
  created_at     timestamptz not null default now()
);

create index idx_business_lifecycle_audit_order
  on public.business_lifecycle_audit_logs (order_id, created_at desc);
create index idx_business_lifecycle_audit_customer
  on public.business_lifecycle_audit_logs (customer_id, created_at desc);
create index idx_business_lifecycle_audit_entity
  on public.business_lifecycle_audit_logs (entity_type, entity_id, created_at desc);
create index idx_business_lifecycle_audit_actor
  on public.business_lifecycle_audit_logs (actor_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 7. 权限、审计与派生状态私有 helper
-- -----------------------------------------------------------------------------
create or replace function public.can_access_business_customer(p_customer_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.customers c
    join public.profiles p on p.id = (select auth.uid())
    where c.id = p_customer_id
      and p.status::text = 'approved'
      and (
        p.role::text in ('admin', 'finance')
        or c.created_by = p.id
        or (p.role::text = 'supervisor' and public.is_my_subordinate(c.created_by))
      )
  );
$$;
revoke all on function public.can_access_business_customer(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.can_access_business_customer(uuid) to authenticated;

create or replace function public.can_manage_business_customer(p_customer_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.customers c
    join public.profiles p on p.id = (select auth.uid())
    where c.id = p_customer_id
      and p.status::text = 'approved'
      and (
        p.role::text in ('admin', 'finance')
        or (p.role::text in ('sales', 'supervisor') and c.created_by = p.id)
      )
  );
$$;
revoke all on function public.can_manage_business_customer(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.can_manage_business_customer(uuid) to authenticated;

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
    'custom_product', 'custom_product_version', 'transfer', 'allocation', 'shipment'
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
      'full_name', v_actor.full_name,
      'role', v_actor.role::text
    )
  );
end;
$$;
revoke all on function public.write_business_lifecycle_audit(
  uuid, uuid, text, uuid, text, jsonb, jsonb, text, uuid
) from public, anon, authenticated, service_role;

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
begin
  select bo.total_amount,
         coalesce(sum(a.amount) filter (
           where a.voided_at is null and t.voided_at is null
         ), 0)
    into v_total, v_paid
  from public.business_orders bo
  left join public.business_order_payment_allocations a on a.order_id = bo.id
  left join public.business_customer_transfers t on t.id = a.transfer_id
  where bo.id = p_order_id
  group by bo.id, bo.total_amount;

  if not found then
    raise exception 'Business order does not exist';
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
  v_shipped numeric;
  v_status text;
begin
  select coalesce(sum(boi.quantity), 0),
         coalesce(sum(shipped.quantity), 0)
    into v_required, v_shipped
  from public.business_order_items boi
  left join lateral (
    select sum(bosi.quantity) as quantity
    from public.business_order_shipment_items bosi
    join public.business_order_shipments bos on bos.id = bosi.shipment_id
    where bosi.order_item_id = boi.id and bos.voided_at is null
  ) shipped on true
  where boi.order_id = p_order_id;

  if not exists (select 1 from public.business_orders where id = p_order_id) then
    raise exception 'Business order does not exist';
  end if;

  v_status := case
    when v_shipped <= 0 then 'unshipped'
    when v_required > 0 and v_shipped >= v_required then 'fully_shipped'
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

-- 历史支付迁移后统一从有效分摊推导支付状态；历史发货未知，按零有效批次推导。
do $$
declare
  v_id uuid;
begin
  for v_id in select id from public.business_orders loop
    perform public.business_refresh_order_payment_status(v_id);
    perform public.business_refresh_order_fulfillment_status(v_id);
  end loop;
end;
$$;

alter table public.business_orders enable trigger trg_business_orders_touch;

-- 已有有效分摊后，不允许旧编辑入口改变客户/币种或把订单总额降至已分摊以下。
create or replace function public.protect_business_order_allocation_invariants()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_paid numeric;
begin
  select coalesce(sum(a.amount), 0) into v_paid
  from public.business_order_payment_allocations a
  join public.business_customer_transfers t on t.id = a.transfer_id
  where a.order_id = old.id
    and a.voided_at is null
    and t.voided_at is null;

  if (v_paid > 0 or (old.status::text = 'completed' and old.completion_gate_version >= 2))
     and new.customer_id is distinct from old.customer_id then
    raise exception 'Cannot change customer after payment allocation or completion';
  end if;
  if (v_paid > 0 or (old.status::text = 'completed' and old.completion_gate_version >= 2))
     and new.currency is distinct from old.currency then
    raise exception 'Cannot change currency after payment allocation or completion';
  end if;
  if v_paid > new.total_amount then
    raise exception 'Order total cannot be less than active payment allocations';
  end if;
  return new;
end;
$$;
revoke all on function public.protect_business_order_allocation_invariants()
  from public, anon, authenticated, service_role;

create trigger trg_protect_business_order_allocation_invariants
  before update of customer_id, currency, total_amount on public.business_orders
  for each row execute function public.protect_business_order_allocation_invariants();

-- -----------------------------------------------------------------------------
-- 8. 定制产品安全 RPC 与上下文读取
-- -----------------------------------------------------------------------------
create or replace function public.add_business_custom_product_version(
  p_custom_product_id uuid,
  p_code text,
  p_name text,
  p_description text,
  p_specification text,
  p_unit text,
  p_image_url text,
  p_default_unit_price numeric,
  p_default_currency public.currency_code
)
returns public.business_custom_product_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_product public.business_custom_products%rowtype;
  v_version public.business_custom_product_versions%rowtype;
  v_version_no int;
begin
  select * into v_actor from public.profiles where id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved business role required to create custom product versions';
  end if;

  select * into v_product
  from public.business_custom_products
  where id = p_custom_product_id
  for update;
  if not found then
    raise exception 'Custom product does not exist';
  end if;
  if v_product.is_archived then
    raise exception 'Archived custom product cannot receive a new version';
  end if;
  if not public.can_manage_business_customer(v_product.customer_id) then
    raise exception 'Custom product customer is not manageable by current user';
  end if;

  if nullif(btrim(p_code), '') is null or char_length(btrim(p_code)) > 100 then
    raise exception 'Custom product code is required and cannot exceed 100 characters';
  end if;
  if nullif(btrim(p_name), '') is null or char_length(btrim(p_name)) > 300 then
    raise exception 'Custom product name is required and cannot exceed 300 characters';
  end if;
  if nullif(btrim(p_unit), '') is null or char_length(btrim(p_unit)) > 100 then
    raise exception 'Custom product unit is required and cannot exceed 100 characters';
  end if;
  if char_length(coalesce(p_description, '')) > 4000
     or char_length(coalesce(p_specification, '')) > 2000
     or char_length(coalesce(p_image_url, '')) > 2000 then
    raise exception 'Custom product version text exceeds maximum length';
  end if;
  if p_default_unit_price is null or p_default_unit_price < 0
     or p_default_unit_price > 999999999999 then
    raise exception 'Default unit price is invalid';
  end if;

  select coalesce(max(version_no), 0) + 1 into v_version_no
  from public.business_custom_product_versions
  where custom_product_id = v_product.id;

  insert into public.business_custom_product_versions (
    custom_product_id, version_no, code, name, description, specification,
    unit, image_url, default_unit_price, default_currency, created_by
  ) values (
    v_product.id, v_version_no, btrim(p_code), btrim(p_name),
    nullif(btrim(p_description), ''), nullif(btrim(p_specification), ''),
    btrim(p_unit), nullif(btrim(p_image_url), ''), p_default_unit_price,
    p_default_currency, v_uid
  ) returning * into v_version;

  update public.business_custom_products set updated_by = v_uid where id = v_product.id;

  perform public.write_business_lifecycle_audit(
    null, v_product.customer_id, 'custom_product_version', v_version.id,
    'version_create', null, to_jsonb(v_version), null, v_uid
  );
  return v_version;
end;
$$;
revoke all on function public.add_business_custom_product_version(
  uuid, text, text, text, text, text, text, numeric, public.currency_code
) from public, anon, authenticated, service_role;
grant execute on function public.add_business_custom_product_version(
  uuid, text, text, text, text, text, text, numeric, public.currency_code
) to authenticated;

create or replace function public.create_business_custom_product(
  p_customer_id uuid,
  p_initial_version jsonb,
  p_is_shared boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_product public.business_custom_products%rowtype;
  v_version public.business_custom_product_versions%rowtype;
begin
  select * into v_actor from public.profiles where id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved business role required to create custom products';
  end if;
  if not public.can_manage_business_customer(p_customer_id) then
    raise exception 'Customer does not exist or is not manageable by current user';
  end if;
  if p_initial_version is not null and jsonb_typeof(p_initial_version) <> 'object' then
    raise exception 'Initial version must be a JSON object or null';
  end if;
  if p_is_shared is null then
    raise exception 'Shared flag is required';
  end if;
  if p_is_shared and v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Only administrators or finance users can share custom products';
  end if;

  insert into public.business_custom_products (
    customer_id, is_shared, created_by, updated_by
  ) values (
    p_customer_id, p_is_shared, v_uid, v_uid
  )
  returning * into v_product;

  perform public.write_business_lifecycle_audit(
    null, p_customer_id, 'custom_product', v_product.id,
    'create', null, to_jsonb(v_product), null, v_uid
  );

  if p_initial_version is not null then
    v_version := public.add_business_custom_product_version(
      v_product.id,
      p_initial_version->>'code',
      p_initial_version->>'name',
      p_initial_version->>'description',
      p_initial_version->>'specification',
      p_initial_version->>'unit',
      p_initial_version->>'image_url',
      (p_initial_version->>'default_unit_price')::numeric,
      (p_initial_version->>'default_currency')::public.currency_code
    );
  end if;

  return jsonb_build_object('product', to_jsonb(v_product), 'version', to_jsonb(v_version));
end;
$$;
revoke all on function public.create_business_custom_product(uuid, jsonb, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.create_business_custom_product(uuid, jsonb, boolean)
  to authenticated;

create or replace function public.set_business_custom_product_state(
  p_custom_product_id uuid,
  p_is_shared boolean,
  p_is_archived boolean,
  p_reason text
)
returns public.business_custom_products
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_old public.business_custom_products%rowtype;
  v_new public.business_custom_products%rowtype;
begin
  select * into v_actor from public.profiles where id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Only approved administrators or finance users can change custom product state';
  end if;
  if p_is_shared is null or p_is_archived is null then
    raise exception 'Shared and archived flags are required';
  end if;
  if char_length(coalesce(p_reason, '')) > 1000 then
    raise exception 'Reason cannot exceed 1000 characters';
  end if;

  select * into v_old from public.business_custom_products
  where id = p_custom_product_id for update;
  if not found then
    raise exception 'Custom product does not exist';
  end if;

  update public.business_custom_products
  set is_shared = p_is_shared,
      is_archived = p_is_archived,
      updated_by = v_uid
  where id = p_custom_product_id
  returning * into v_new;

  perform public.write_business_lifecycle_audit(
    null, v_new.customer_id, 'custom_product', v_new.id,
    'state_change', to_jsonb(v_old), to_jsonb(v_new), p_reason, v_uid
  );
  return v_new;
end;
$$;
revoke all on function public.set_business_custom_product_state(uuid, boolean, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.set_business_custom_product_state(uuid, boolean, boolean, text)
  to authenticated;

-- 共享产品不通过直接表 SELECT 泄露；必须带一个调用者有权客户作为建单上下文。
create or replace function public.list_business_custom_products_for_customer(p_customer_id uuid)
returns table (
  custom_product_id uuid,
  owner_customer_id uuid,
  is_shared boolean,
  is_archived boolean,
  version_id uuid,
  version_no int,
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
begin
  if not public.can_access_business_customer(p_customer_id) then
    raise exception 'Customer context is not accessible';
  end if;

  return query
  select cp.id, cp.customer_id, cp.is_shared, cp.is_archived,
         cv.id, cv.version_no, cv.code, cv.name, cv.description,
         cv.specification, cv.unit, cv.image_url,
         cv.default_unit_price, cv.default_currency
  from public.business_custom_products cp
  join public.business_custom_product_versions cv on cv.custom_product_id = cp.id
  where not cp.is_archived
    and (cp.customer_id = p_customer_id or cp.is_shared)
  order by cv.name, cp.id, cv.version_no desc;
end;
$$;
revoke all on function public.list_business_custom_products_for_customer(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_business_custom_products_for_customer(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 9. 订单行替换支持 catalog/custom；旧 catalog JSON 保持兼容
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
  v_product public.products%rowtype;
  v_custom_product public.business_custom_products%rowtype;
  v_custom_version public.business_custom_product_versions%rowtype;
  v_source_type text;
  v_product_id uuid;
  v_custom_product_id uuid;
  v_custom_version_id uuid;
  v_quantity numeric;
  v_unit_price numeric;
  v_sort_order int := 0;
  v_subtotal numeric(18,2) := 0;
begin
  select * into v_order from public.business_orders where id = p_order_id;
  if not found then
    raise exception 'Business order does not exist';
  end if;
  if v_order.customer_id is null then
    raise exception 'Business order customer is required';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Items must be a JSON array';
  end if;
  if jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 500 then
    raise exception 'Order items count must be between 1 and 500';
  end if;

  delete from public.business_order_items where order_id = p_order_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Each item must be an object';
    end if;

    v_product_id := nullif(v_item->>'product_id', '')::uuid;
    v_custom_product_id := nullif(v_item->>'custom_product_id', '')::uuid;
    v_custom_version_id := nullif(v_item->>'custom_product_version_id', '')::uuid;
    v_source_type := coalesce(
      nullif(v_item->>'source_type', ''),
      case when v_custom_product_id is not null or v_custom_version_id is not null
           then 'custom' else 'catalog' end
    );
    v_quantity := round((v_item->>'quantity')::numeric, 4);
    v_unit_price := round((v_item->>'unit_price')::numeric, 2);

    if v_quantity is null or v_quantity <= 0 or v_quantity > 999999999999 then
      raise exception 'Quantity must be greater than zero and at most 999999999999';
    end if;
    if v_unit_price is null or v_unit_price < 0 or v_unit_price > 999999999999 then
      raise exception 'Unit price must be between zero and 999999999999';
    end if;

    if v_source_type = 'catalog' then
      if v_product_id is null or v_custom_product_id is not null or v_custom_version_id is not null then
        raise exception 'Catalog item requires only product_id';
      end if;
      select * into v_product from public.products
      where id = v_product_id and is_active = true;
      if not found then
        raise exception 'Product does not exist or is inactive';
      end if;

      insert into public.business_order_items (
        order_id, source_type, product_id, sku_snapshot, name_snapshot,
        description_snapshot, specification_snapshot, unit_snapshot,
        image_url_snapshot, quantity, unit_price, sort_order
      ) values (
        p_order_id, 'catalog', v_product.id, v_product.sku, v_product.name,
        v_product.description, v_product.specification, v_product.unit,
        v_product.image_url, v_quantity, v_unit_price, v_sort_order
      );
    elsif v_source_type = 'custom' then
      if v_product_id is not null or v_custom_product_id is null or v_custom_version_id is null then
        raise exception 'Custom item requires only custom_product_id and custom_product_version_id';
      end if;

      select * into v_custom_product
      from public.business_custom_products cp
      where cp.id = v_custom_product_id;
      if not found then
        raise exception 'Custom product does not exist';
      end if;
      select * into v_custom_version
      from public.business_custom_product_versions cv
      where cv.id = v_custom_version_id
        and cv.custom_product_id = v_custom_product.id;
      if not found then
        raise exception 'Custom product version does not belong to custom product';
      end if;
      if v_custom_product.is_archived then
        raise exception 'Custom product is archived';
      end if;
      if v_custom_product.customer_id <> v_order.customer_id and not v_custom_product.is_shared then
        raise exception 'Custom product is not available for this order customer';
      end if;

      insert into public.business_order_items (
        order_id, source_type, custom_product_id, custom_product_version_id,
        sku_snapshot, name_snapshot, description_snapshot, specification_snapshot,
        unit_snapshot, image_url_snapshot, quantity, unit_price, sort_order
      ) values (
        p_order_id, 'custom', v_custom_product.id, v_custom_version.id,
        v_custom_version.code, v_custom_version.name, v_custom_version.description,
        v_custom_version.specification, v_custom_version.unit, v_custom_version.image_url,
        v_quantity, v_unit_price, v_sort_order
      );
    else
      raise exception 'Invalid order item source_type';
    end if;

    v_subtotal := v_subtotal + round(v_quantity * v_unit_price, 2);
    v_sort_order := v_sort_order + 1;
  end loop;

  return v_subtotal;
end;
$$;
revoke all on function public.replace_business_order_items(uuid, jsonb)
  from public, anon, authenticated, service_role;

-- V2 使用独立名称，避免 PostgREST 与旧签名因默认参数产生重载歧义。
create or replace function public.create_business_order_v2(
  p_customer_id uuid,
  p_order_date date,
  p_fulfillment_type public.business_fulfillment_type,
  p_currency public.currency_code,
  p_exchange_rate_to_cny numeric,
  p_shipping_fee numeric,
  p_tracking_number text,
  p_sales_notes text,
  p_items jsonb,
  p_payment_due_date date
)
returns table (id uuid, order_number text, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_created record;
  v_order public.business_orders%rowtype;
begin
  select * into v_created
  from public.create_business_order(
    p_customer_id, p_order_date, p_fulfillment_type, p_currency,
    p_exchange_rate_to_cny, p_shipping_fee, p_tracking_number,
    p_sales_notes, p_items
  );

  update public.business_orders bo
  set payment_due_date = p_payment_due_date,
      completion_gate_version = 2
  where bo.id = v_created.id
  returning * into v_order;

  perform public.write_business_order_audit(
    v_order.id, 'order', v_order.id, 'update', v_order.status, v_order.status,
    jsonb_build_object('payment_due_date', null::date),
    jsonb_build_object('payment_due_date', v_order.payment_due_date),
    'Set payment due date during V2 creation', v_uid
  );
  return query select v_order.id, v_order.order_number, v_order.version;
end;
$$;
revoke all on function public.create_business_order_v2(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb, date
) from public, anon, authenticated, service_role;
grant execute on function public.create_business_order_v2(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb, date
) to authenticated;

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
  v_updated record;
  v_order public.business_orders%rowtype;
  v_old_due_date date;
  v_delegate_items jsonb := p_items;
  v_existing_items jsonb;
  v_requested_items jsonb;
begin
  select * into v_order
  from public.business_orders
  where business_orders.id = p_order_id
  for update;
  if not found then
    raise exception 'Business order does not exist';
  end if;
  v_old_due_date := v_order.payment_due_date;

  if p_payment_due_date is not null
     and p_order_date is not null
     and p_payment_due_date < p_order_date then
    raise exception 'Payment due date cannot be earlier than order date';
  end if;

  -- gate-v2 已完成订单已存在发货历史，产品行是发货流水的稳定锚点。
  -- 允许修正日期、备注、运费等，但禁止改变产品身份、数量或单价。
  if v_order.status::text = 'completed' and v_order.completion_gate_version >= 2 then
    if p_items is null or jsonb_typeof(p_items) <> 'array' then
      raise exception 'Items must be a JSON array';
    end if;

    select coalesce(jsonb_agg(jsonb_build_object(
      'source_type', boi.source_type,
      'product_id', boi.product_id,
      'custom_product_id', boi.custom_product_id,
      'custom_product_version_id', boi.custom_product_version_id,
      'quantity', boi.quantity,
      'unit_price', boi.unit_price
    ) order by boi.sort_order), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object(
      'product_id', boi.product_id,
      'quantity', boi.quantity,
      'unit_price', boi.unit_price
    ) order by boi.sort_order), '[]'::jsonb)
      into v_existing_items, v_delegate_items
    from public.business_order_items boi
    where boi.order_id = v_order.id;

    select coalesce(jsonb_agg(jsonb_build_object(
      'source_type', coalesce(
        nullif(item.value->>'source_type', ''),
        case when nullif(item.value->>'custom_product_id', '') is not null
                  or nullif(item.value->>'custom_product_version_id', '') is not null
             then 'custom' else 'catalog' end
      ),
      'product_id', nullif(item.value->>'product_id', '')::uuid,
      'custom_product_id', nullif(item.value->>'custom_product_id', '')::uuid,
      'custom_product_version_id', nullif(item.value->>'custom_product_version_id', '')::uuid,
      'quantity', (item.value->>'quantity')::numeric,
      'unit_price', (item.value->>'unit_price')::numeric
    ) order by item.ordinality), '[]'::jsonb)
      into v_requested_items
    from jsonb_array_elements(p_items) with ordinality as item(value, ordinality);

    if v_requested_items is distinct from v_existing_items then
      raise exception 'Completed order items cannot be changed after shipment';
    end if;
  end if;

  -- 旧 RPC 会先更新 order_date。先在同一事务内临时清空旧到期日，避免合法的
  -- “同时修改订单日期和到期日”因中间状态触发 CHECK；任一步失败都会整体回滚。
  if v_old_due_date is not null then
    update public.business_orders bo
    set payment_due_date = null
    where bo.id = v_order.id;
  end if;

  select * into v_updated
  from public.update_business_order(
    p_order_id, p_expected_version, p_customer_id, p_order_date,
    p_fulfillment_type, p_currency, p_exchange_rate_to_cny, p_shipping_fee,
    p_tracking_number, p_sales_notes, v_delegate_items, p_reason
  );

  update public.business_orders bo
  set payment_due_date = p_payment_due_date
  where bo.id = v_updated.id
  returning * into v_order;

  perform public.business_refresh_order_payment_status(v_updated.id);
  perform public.business_refresh_order_fulfillment_status(v_updated.id);
  select bo.* into v_order
  from public.business_orders bo
  where bo.id = v_updated.id;

  if v_order.status::text = 'completed'
     and v_order.completion_gate_version >= 2
     and (
       v_order.approval_status <> 'approved'
       or v_order.payment_status <> 'fully_paid'
       or v_order.fulfillment_status <> 'fully_shipped'
     ) then
    raise exception 'Completed order correction must preserve approval, payment, and fulfillment gates';
  end if;

  if v_old_due_date is distinct from p_payment_due_date then
    perform public.write_business_order_audit(
      v_order.id, 'order', v_order.id, 'update', v_order.status, v_order.status,
      jsonb_build_object('payment_due_date', v_old_due_date),
      jsonb_build_object('payment_due_date', p_payment_due_date),
      p_reason, v_uid
    );
  end if;

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

-- 旧建单/编辑签名继续兼容 catalog 调用，也因 replace helper 自动支持 custom；显式收紧执行角色。
revoke all on function public.create_business_order(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.create_business_order(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb
) to authenticated;
revoke all on function public.update_business_order(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, text
) from public, anon, authenticated, service_role;
-- 旧编辑 RPC 仅供 V2 包装器内部调用，不再向客户端授权，防止绕过款货门禁。

-- -----------------------------------------------------------------------------
-- 10. 转账分摊私有执行器与安全 RPC
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
  if not public.can_manage_business_customer(v_transfer.customer_id) then
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
    if v_order.customer_id is distinct from v_transfer.customer_id then
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
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
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
  if not public.can_manage_business_customer(p_customer_id) then
    raise exception 'Customer is not manageable by current user';
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
     or p_proof_path !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/customer/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
     or split_part(p_proof_path, '/', 1) <> v_uid::text
     or split_part(p_proof_path, '/', 2) <> 'customer'
     or split_part(p_proof_path, '/', 3) <> p_customer_id::text then
    raise exception 'Invalid transfer proof path';
  end if;
  if not exists (
    select 1 from storage.objects so
    where so.bucket_id = 'business-payment-proofs' and so.name = p_proof_path
  ) then
    raise exception 'Transfer proof object does not exist';
  end if;

  v_hash := encode(digest(jsonb_build_object(
    'customer_id', p_customer_id, 'currency', p_currency::text,
    'amount', round(p_amount, 2), 'exchange_rate_to_cny', round(p_exchange_rate_to_cny, 8),
    'received_at', p_received_at, 'payment_type', p_payment_type::text,
    'proof_path', p_proof_path, 'notes', nullif(btrim(p_notes), ''),
    'correction_reason', nullif(btrim(p_correction_reason), ''),
    'allocations', p_allocations
  )::text, 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    v_uid::text || ':record_business_customer_transfer:' || btrim(p_idempotency_key), 0
  ));

  select * into v_idempotency
  from public.business_rpc_idempotency
  where actor_id = v_uid
    and operation = 'record_business_customer_transfer'
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
    customer_id, currency, amount, exchange_rate_to_cny, received_at,
    payment_type, proof_path, notes, idempotency_key, payload_hash,
    created_by, updated_by
  ) values (
    p_customer_id, p_currency, round(p_amount, 2), round(p_exchange_rate_to_cny, 8), p_received_at,
    p_payment_type, p_proof_path, nullif(btrim(p_notes), ''),
    btrim(p_idempotency_key), v_hash, v_uid, v_uid
  ) returning * into v_transfer;

  v_allocations := public.business_apply_transfer_allocations(
    v_transfer.id, p_allocations, v_uid, p_correction_reason
  );
  perform public.write_business_lifecycle_audit(
    null, p_customer_id, 'transfer', v_transfer.id,
    'create', null, to_jsonb(v_transfer), null, v_uid
  );
  v_result := jsonb_build_object('transfer', to_jsonb(v_transfer), 'allocations', v_allocations);
  insert into public.business_rpc_idempotency (
    actor_id, operation, idempotency_key, payload_hash, result
  ) values (
    v_uid, 'record_business_customer_transfer', btrim(p_idempotency_key), v_hash, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.record_business_customer_transfer(
  uuid, public.currency_code, numeric, numeric, timestamptz,
  public.business_payment_type, text, text, text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.record_business_customer_transfer(
  uuid, public.currency_code, numeric, numeric, timestamptz,
  public.business_payment_type, text, text, text, text, jsonb
) to authenticated;

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
  if not public.can_manage_business_customer(v_transfer.customer_id) then
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
  v_old jsonb;
  v_order public.business_orders%rowtype;
  v_transfer public.business_customer_transfers%rowtype;
begin
  select * into v_actor from public.profiles where id = v_uid;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Approved account required';
  end if;
  if nullif(btrim(p_reason), '') is null or char_length(btrim(p_reason)) > 1000 then
    raise exception 'Void reason is required and cannot exceed 1000 characters';
  end if;

  -- 先只读取定位键，再统一按 transfer -> order -> allocation 的顺序加锁，
  -- 与新增分摊及整笔转账作废保持一致，避免并发时形成锁环。
  select * into v_allocation
  from public.business_order_payment_allocations
  where id = p_allocation_id;
  if not found then
    raise exception 'Active allocation does not exist';
  end if;
  select * into v_transfer from public.business_customer_transfers
  where id = v_allocation.transfer_id for update;
  select * into v_order from public.business_orders
  where id = v_allocation.order_id for update;
  select * into v_allocation
  from public.business_order_payment_allocations
  where id = p_allocation_id for update;
  if not found or v_allocation.voided_at is not null then
    raise exception 'Active allocation does not exist';
  end if;

  if v_actor.role::text in ('sales', 'supervisor') then
    if v_order.salesperson_id is distinct from v_uid then
      raise exception 'Sales user cannot void another salesperson allocation';
    end if;
  elsif v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Role cannot void payment allocations';
  end if;
  if v_order.status::text = 'completed'
     and (v_order.completion_gate_version >= 2
          or v_actor.role::text not in ('admin', 'finance')) then
    raise exception 'Completed order allocations require the legacy admin/finance correction path';
  end if;

  v_old := to_jsonb(v_allocation);
  update public.business_order_payment_allocations
  set voided_at = now(), voided_by = v_uid, void_reason = btrim(p_reason)
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
  select * into v_actor from public.profiles where id = v_uid;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Approved account required';
  end if;
  if nullif(btrim(p_reason), '') is null or char_length(btrim(p_reason)) > 1000 then
    raise exception 'Void reason is required and cannot exceed 1000 characters';
  end if;

  select * into v_transfer from public.business_customer_transfers
  where id = p_transfer_id for update;
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
      and bo.status::text = 'completed'
      and (
        bo.completion_gate_version >= 2
        or v_actor.role::text not in ('admin', 'finance')
      )
  ) then
    raise exception 'Completed order transfers require the legacy admin/finance correction path';
  end if;

  v_old := to_jsonb(v_transfer);
  update public.business_customer_transfers
  set voided_at = now(), voided_by = v_uid, void_reason = btrim(p_reason),
      updated_by = v_uid, updated_at = now()
  where id = p_transfer_id returning * into v_transfer;

  for v_order_id in
    select distinct a.order_id
    from public.business_order_payment_allocations a
    where a.transfer_id = v_transfer.id and a.voided_at is null
    order by a.order_id
  loop
    perform public.business_refresh_order_payment_status(v_order_id);
    update public.business_orders set version = version + 1 where id = v_order_id;
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

-- -----------------------------------------------------------------------------
-- 11. 发货安全 RPC
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
  v_shipped numeric;
  v_hash text;
  v_created jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  select * into v_actor from public.profiles where id = v_uid;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Approved account required';
  end if;
  select * into v_order from public.business_orders
  where id = p_order_id for update;
  if not found then
    raise exception 'Business order does not exist';
  end if;
  if v_actor.role::text in ('sales', 'supervisor') then
    if v_order.salesperson_id is distinct from v_uid then
      raise exception 'Sales user cannot ship another salesperson order';
    end if;
  elsif v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Role cannot create shipments';
  end if;
  if p_shipped_at is null then
    raise exception 'Shipped time is required';
  end if;
  if char_length(coalesce(p_tracking_number, '')) > 200
     or char_length(coalesce(p_notes, '')) > 1000 then
    raise exception 'Shipment text exceeds maximum length';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 500 then
    raise exception 'Shipment items count must be between 1 and 500';
  end if;
  if nullif(btrim(p_idempotency_key), '') is null
     or char_length(btrim(p_idempotency_key)) > 200 then
    raise exception 'Idempotency key is required and cannot exceed 200 characters';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_items) as x(order_item_id uuid, quantity numeric)
    group by x.order_item_id having x.order_item_id is null or count(*) > 1
  ) then
    raise exception 'Each shipment order_item_id must be unique';
  end if;

  v_hash := encode(digest(jsonb_build_object(
    'order_id', p_order_id,
    'shipped_at', p_shipped_at,
    'tracking_number', nullif(btrim(p_tracking_number), ''),
    'notes', nullif(btrim(p_notes), ''),
    'items', p_items
  )::text, 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    v_uid::text || ':create_business_order_shipment:' || btrim(p_idempotency_key), 0
  ));

  select * into v_idempotency
  from public.business_rpc_idempotency
  where actor_id = v_uid
    and operation = 'create_business_order_shipment'
    and idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_idempotency.payload_hash <> v_hash then
      raise exception 'Idempotency key was already used with a different payload';
    end if;
    return v_idempotency.result;
  end if;

  if v_order.status::text <> 'approved' or v_order.approval_status <> 'approved' then
    raise exception 'Only approved orders can be shipped';
  end if;

  perform boi.id
  from public.business_order_items boi
  join (select x.order_item_id from jsonb_to_recordset(p_items)
        as x(order_item_id uuid, quantity numeric)) r on r.order_item_id = boi.id
  where boi.order_id = v_order.id
  order by boi.id
  for update of boi;
  if (select count(*) from jsonb_to_recordset(p_items)
        as x(order_item_id uuid, quantity numeric))
     <> (select count(*) from public.business_order_items boi
         join (select x.order_item_id from jsonb_to_recordset(p_items)
               as x(order_item_id uuid, quantity numeric)) r
           on r.order_item_id = boi.id
         where boi.order_id = v_order.id) then
    raise exception 'One or more shipment items do not belong to order';
  end if;

  insert into public.business_order_shipments (
    order_id, shipped_at, tracking_number, notes, created_by
  ) values (
    v_order.id, p_shipped_at, nullif(btrim(p_tracking_number), ''),
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
    where id = v_order_item_id and order_id = v_order.id;

    select coalesce(sum(si.quantity), 0) into v_shipped
    from public.business_order_shipment_items si
    join public.business_order_shipments s on s.id = si.shipment_id
    where si.order_item_id = v_order_item.id and s.voided_at is null;
    if v_shipped + v_quantity > v_order_item.quantity then
      raise exception 'Shipment quantity exceeds remaining order item quantity';
    end if;

    insert into public.business_order_shipment_items (
      shipment_id, order_item_id, quantity
    ) values (
      v_shipment.id, v_order_item.id, v_quantity
    ) returning * into v_shipment_item;
    v_created := v_created || jsonb_build_array(to_jsonb(v_shipment_item));
  end loop;

  perform public.business_refresh_order_fulfillment_status(v_order.id);
  update public.business_orders set version = version + 1 where id = v_order.id;
  v_result := jsonb_build_object('shipment', to_jsonb(v_shipment), 'items', v_created);
  perform public.write_business_lifecycle_audit(
    v_order.id, v_order.customer_id, 'shipment', v_shipment.id,
    'create', null, v_result, null, v_uid
  );
  insert into public.business_rpc_idempotency (
    actor_id, operation, idempotency_key, payload_hash, result
  ) values (
    v_uid, 'create_business_order_shipment', btrim(p_idempotency_key), v_hash, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.create_business_order_shipment(
  uuid, timestamptz, text, text, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_business_order_shipment(
  uuid, timestamptz, text, text, jsonb, text
) to authenticated;

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
  select * into v_actor from public.profiles where id = v_uid;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Approved account required';
  end if;
  if nullif(btrim(p_reason), '') is null or char_length(btrim(p_reason)) > 1000 then
    raise exception 'Void reason is required and cannot exceed 1000 characters';
  end if;
  select * into v_shipment from public.business_order_shipments
  where id = p_shipment_id for update;
  if not found or v_shipment.voided_at is not null then
    raise exception 'Active shipment does not exist';
  end if;
  select * into v_order from public.business_orders
  where id = v_shipment.order_id for update;
  if v_order.status::text <> 'approved' then
    raise exception 'Only approved orders can have shipments voided';
  end if;
  if v_actor.role::text in ('sales', 'supervisor') then
    if v_order.salesperson_id is distinct from v_uid then
      raise exception 'Sales user cannot void another salesperson shipment';
    end if;
  elsif v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Role cannot void shipments';
  end if;

  v_old := to_jsonb(v_shipment);
  update public.business_order_shipments
  set voided_at = now(), voided_by = v_uid, void_reason = btrim(p_reason)
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
-- 12. 查询 RPC：预收余额与订单款货汇总
-- -----------------------------------------------------------------------------
create or replace function public.get_business_customer_prepayment(p_customer_id uuid)
returns table (
  currency public.currency_code,
  total_received numeric,
  total_allocated numeric,
  available_balance numeric
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.can_access_business_customer(p_customer_id) then
    raise exception 'Customer is not accessible';
  end if;
  return query
  with received as (
    select t.currency, sum(t.amount) as amount
    from public.business_customer_transfers t
    where t.customer_id = p_customer_id and t.voided_at is null
    group by t.currency
  ), allocated as (
    select t.currency, sum(a.amount) as amount
    from public.business_customer_transfers t
    join public.business_order_payment_allocations a on a.transfer_id = t.id
    where t.customer_id = p_customer_id
      and t.voided_at is null and a.voided_at is null
    group by t.currency
  )
  select r.currency, r.amount, coalesce(a.amount, 0), r.amount - coalesce(a.amount, 0)
  from received r left join allocated a using (currency)
  order by r.currency::text;
end;
$$;
revoke all on function public.get_business_customer_prepayment(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_business_customer_prepayment(uuid) to authenticated;

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
         coalesce(items.quantity, 0), coalesce(shipped.quantity, 0), bo.fulfillment_status
  from public.business_orders bo
  left join lateral (
    select sum(a.amount) as amount
    from public.business_order_payment_allocations a
    join public.business_customer_transfers t on t.id = a.transfer_id
    where a.order_id = bo.id and a.voided_at is null and t.voided_at is null
  ) pay on true
  left join lateral (
    select sum(i.quantity) as quantity
    from public.business_order_items i where i.order_id = bo.id
  ) items on true
  left join lateral (
    select sum(si.quantity) as quantity
    from public.business_order_shipments s
    join public.business_order_shipment_items si on si.shipment_id = s.id
    where s.order_id = bo.id and s.voided_at is null
  ) shipped on true
  where bo.id = p_order_id;
end;
$$;
revoke all on function public.get_business_order_settlement_summary(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_business_order_settlement_summary(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 13. 状态机：提交不再要求收款；新门禁完成必须审批、全额收款、全部发货
-- -----------------------------------------------------------------------------
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
  select * into v_actor from public.profiles where id = v_uid;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Approved account required';
  end if;
  select * into v_order from public.business_orders
  where id = p_order_id for update;
  if not found then
    raise exception 'Business order does not exist';
  end if;
  if char_length(coalesce(p_note, '')) > 1000 then
    raise exception 'Note cannot exceed 1000 characters';
  end if;
  v_old := to_jsonb(v_order);

  if v_actor.role::text in ('sales', 'supervisor')
     and v_order.salesperson_id = v_uid
     and v_order.status::text in ('draft', 'rejected')
     and p_target::text = 'submitted' then
    if not exists (select 1 from public.business_order_items where order_id = v_order.id) then
      raise exception 'At least one order item is required before submission';
    end if;
    update public.business_orders
    set status = 'submitted', approval_status = 'submitted',
        submitted_by = v_uid, submitted_at = now(), version = version + 1
    where id = v_order.id returning * into v_order;
    v_action := 'submit';

  elsif v_actor.role::text = 'admin'
        and v_order.status::text = 'submitted'
        and p_target::text in ('approved', 'rejected') then
    if p_target::text = 'rejected' and nullif(btrim(p_note), '') is null then
      raise exception 'Rejection note is required';
    end if;
    update public.business_orders
    set status = p_target,
        approval_status = case when p_target::text = 'approved' then 'approved' else 'rejected' end,
        review_note = nullif(btrim(p_note), ''), reviewed_by = v_uid,
        reviewed_at = now(), version = version + 1
    where id = v_order.id returning * into v_order;
    v_action := case when p_target::text = 'approved' then 'approve' else 'reject' end;

  elsif v_actor.role::text = 'finance'
        and v_order.status::text = 'approved'
        and p_target::text = 'completed' then
    perform public.business_refresh_order_payment_status(v_order.id);
    perform public.business_refresh_order_fulfillment_status(v_order.id);
    select * into v_order from public.business_orders where id = p_order_id;
    if v_order.approval_status <> 'approved'
       or v_order.payment_status <> 'fully_paid'
       or v_order.fulfillment_status <> 'fully_shipped' then
      raise exception 'Completion requires approved, fully paid, and fully shipped order';
    end if;
    if not exists (
      select 1 from public.business_order_finance_details bofd
      where bofd.order_id = v_order.id
        and bofd.wage_amount_cny >= 0
        and nullif(btrim(bofd.calculation_notes), '') is not null
    ) then
      raise exception 'Wage amount and calculation notes are required before completion';
    end if;
    update public.business_orders
    set status = 'completed', completed_by = v_uid,
        completed_at = now(), version = version + 1
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

-- -----------------------------------------------------------------------------
-- 14. RLS：authenticated 仅 SELECT，所有写入必须走 RPC
-- -----------------------------------------------------------------------------
alter table public.business_custom_products enable row level security;
alter table public.business_custom_product_versions enable row level security;
alter table public.business_customer_transfers enable row level security;
alter table public.business_order_payment_allocations enable row level security;
alter table public.business_rpc_idempotency enable row level security;
alter table public.business_order_shipments enable row level security;
alter table public.business_order_shipment_items enable row level security;
alter table public.business_lifecycle_audit_logs enable row level security;

revoke all on table public.business_custom_products from public, anon, authenticated;
revoke all on table public.business_custom_product_versions from public, anon, authenticated;
revoke all on table public.business_customer_transfers from public, anon, authenticated;
revoke all on table public.business_order_payment_allocations from public, anon, authenticated;
revoke all on table public.business_rpc_idempotency from public, anon, authenticated;
revoke all on table public.business_order_shipments from public, anon, authenticated;
revoke all on table public.business_order_shipment_items from public, anon, authenticated;
revoke all on table public.business_lifecycle_audit_logs from public, anon, authenticated;

grant select on table public.business_custom_products to authenticated;
grant select on table public.business_custom_product_versions to authenticated;
grant select on table public.business_customer_transfers to authenticated;
grant select on table public.business_order_payment_allocations to authenticated;
grant select on table public.business_order_shipments to authenticated;
grant select on table public.business_order_shipment_items to authenticated;
grant select on table public.business_lifecycle_audit_logs to authenticated;

create policy "business_custom_products_select" on public.business_custom_products
  for select to authenticated
  using (public.can_access_business_customer(customer_id));

create policy "business_custom_product_versions_select" on public.business_custom_product_versions
  for select to authenticated
  using (exists (
    select 1 from public.business_custom_products cp
    where cp.id = custom_product_id
      and public.can_access_business_customer(cp.customer_id)
  ));

create policy "business_customer_transfers_select" on public.business_customer_transfers
  for select to authenticated
  using (public.can_access_business_customer(customer_id));

create policy "business_order_payment_allocations_select" on public.business_order_payment_allocations
  for select to authenticated
  using (public.can_view_business_order(order_id));

create policy "business_order_shipments_select" on public.business_order_shipments
  for select to authenticated
  using (public.can_view_business_order(order_id));

create policy "business_order_shipment_items_select" on public.business_order_shipment_items
  for select to authenticated
  using (exists (
    select 1 from public.business_order_shipments s
    where s.id = shipment_id and public.can_view_business_order(s.order_id)
  ));

create policy "business_lifecycle_audit_select" on public.business_lifecycle_audit_logs
  for select to authenticated
  using (public.is_finance_or_admin());

-- business_rpc_idempotency 故意不授予 SELECT，也不创建策略。

-- -----------------------------------------------------------------------------
-- 15. Storage：旧订单凭证沿用 uid/order_id/file；新转账使用 uid/customer/customer_id/file
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
    )
  );

-- -----------------------------------------------------------------------------
-- 16. 财务总览保持旧返回签名，业务收款改为有效客户转账，避免迁移后双计
-- -----------------------------------------------------------------------------
create or replace function public.get_finance_summary()
returns table (
  order_revenue numeric,
  income numeric,
  expense numeric,
  order_costs numeric,
  gross_profit numeric,
  cash_balance numeric
)
language sql
security invoker
set search_path = public
stable
as $$
  with legacy_order_summary as (
    select coalesce(sum(amount_cny), 0) as amount
    from public.finance_orders where status = 'active'
  ),
  business_order_summary as (
    select coalesce(sum(total_cny), 0) as amount
    from public.business_orders where status = 'completed'
  ),
  transaction_summary as (
    select
      coalesce(sum(amount_cny) filter (where transaction_type = 'income'), 0) as income,
      coalesce(sum(amount_cny) filter (where transaction_type = 'expense'), 0) as expense
    from public.finance_transactions where status = 'active'
  ),
  business_transfer_summary as (
    select coalesce(sum(round(t.amount * t.exchange_rate_to_cny, 2)), 0) as income
    from public.business_customer_transfers t where t.voided_at is null
  ),
  legacy_cost_summary as (
    select coalesce(sum(foc.amount_cny), 0) as amount
    from public.finance_order_costs foc where foc.finance_order_id is not null
  ),
  business_cost_summary as (
    select coalesce(sum(foc.amount_cny), 0) as amount
    from public.finance_order_costs foc
    join public.business_orders bo on bo.id = foc.business_order_id
    where bo.status = 'completed'
  ),
  business_wage_summary as (
    select coalesce(sum(bofd.wage_amount_cny), 0) as amount
    from public.business_order_finance_details bofd
    join public.business_orders bo on bo.id = bofd.order_id
    where bo.status = 'completed'
  )
  select
    lo.amount + bo.amount,
    ts.income + bt.income,
    ts.expense,
    lc.amount + bc.amount + bw.amount,
    (lo.amount + bo.amount) - (lc.amount + bc.amount + bw.amount),
    (ts.income + bt.income) - ts.expense
  from legacy_order_summary lo
  cross join business_order_summary bo
  cross join transaction_summary ts
  cross join business_transfer_summary bt
  cross join legacy_cost_summary lc
  cross join business_cost_summary bc
  cross join business_wage_summary bw;
$$;
revoke all on function public.get_finance_summary()
  from public, anon, authenticated, service_role;
grant execute on function public.get_finance_summary() to authenticated;
