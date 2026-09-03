-- 0017_business_order_workflow.sql
-- 独立于 PI 与旧财务表的业务订单工作流、收款凭证、审计和安全 RPC。

-- 1) 枚举（CREATE TYPE 的值可在同一事务中直接使用；不使用 ALTER TYPE ADD VALUE）
do $$ begin
  create type public.business_order_status as enum (
    'draft', 'submitted', 'rejected', 'approved', 'completed'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.business_fulfillment_type as enum ('custom', 'stock');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.business_payment_type as enum ('full', 'deposit', 'balance');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.business_audit_action as enum (
    'create', 'update', 'payment_add', 'payment_update', 'payment_void',
    'submit', 'approve', 'reject', 'finance_update', 'complete', 'correct'
  );
exception when duplicate_object then null; end $$;

-- 2) 并发安全的年度订单编号
create table if not exists public.business_order_sequences (
  year int primary key,
  last_seq int not null default 0 check (last_seq >= 0)
);

revoke all on table public.business_order_sequences from anon, authenticated;

create or replace function public.next_business_order_number()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year int := extract(year from current_date)::int;
  v_seq int;
begin
  insert into public.business_order_sequences (year, last_seq)
  values (v_year, 1)
  on conflict (year)
  do update set last_seq = public.business_order_sequences.last_seq + 1
  returning last_seq into v_seq;

  return 'BO-' || v_year || '-' || lpad(v_seq::text, 4, '0');
end;
$$;

revoke all on function public.next_business_order_number() from public;

-- 3) 业务订单主表
create table if not exists public.business_orders (
  id                         uuid primary key default uuid_generate_v4(),
  order_number               text not null unique,
  status                     public.business_order_status not null default 'draft',
  version                    int not null default 1 check (version > 0),
  customer_id                uuid references public.customers(id) on delete set null,
  customer_snapshot          jsonb not null,
  salesperson_id             uuid references public.profiles(id) on delete set null,
  salesperson_name_snapshot  text,
  order_date                 date not null,
  fulfillment_type           public.business_fulfillment_type not null,
  currency                   public.currency_code not null,
  exchange_rate_to_cny       numeric(18,8) not null check (
    exchange_rate_to_cny > 0 and exchange_rate_to_cny <= 1000000
  ),
  items_subtotal             numeric(18,2) not null default 0 check (
    items_subtotal >= 0 and items_subtotal <= 999999999999
  ),
  shipping_fee               numeric(18,2) not null default 0 check (
    shipping_fee >= 0 and shipping_fee <= 999999999999
  ),
  total_amount               numeric(18,2) not null default 0 check (
    total_amount >= 0 and total_amount <= 999999999999
  ),
  total_cny                  numeric(18,2) generated always as (
    round(total_amount * exchange_rate_to_cny, 2)
  ) stored,
  tracking_number            text check (tracking_number is null or char_length(tracking_number) <= 200),
  sales_notes                text check (sales_notes is null or char_length(sales_notes) <= 2000),
  review_note                text check (review_note is null or char_length(review_note) <= 1000),
  submitted_by               uuid references public.profiles(id) on delete set null,
  submitted_at               timestamptz,
  reviewed_by                uuid references public.profiles(id) on delete set null,
  reviewed_at                timestamptz,
  completed_by               uuid references public.profiles(id) on delete set null,
  completed_at               timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint business_orders_total_matches check (
    total_amount = items_subtotal + shipping_fee
  ),
  constraint business_orders_cny_rate check (
    currency <> 'CNY' or exchange_rate_to_cny = 1
  )
);

comment on table public.business_orders is '独立业务订单工作流；金额、客户、业务员均保留订单时快照';
comment on column public.business_orders.version is '乐观锁版本，由数据库 RPC 在变更时递增';

create or replace function public.set_business_order_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.order_number is null or btrim(new.order_number) = '' then
    new.order_number := public.next_business_order_number();
  end if;
  return new;
end;
$$;

revoke all on function public.set_business_order_number() from public;

drop trigger if exists trg_set_business_order_number on public.business_orders;
create trigger trg_set_business_order_number
  before insert on public.business_orders
  for each row execute function public.set_business_order_number();

drop trigger if exists trg_business_orders_touch on public.business_orders;
create trigger trg_business_orders_touch
  before update on public.business_orders
  for each row execute function public.touch_updated_at();

-- 4) 订单明细：仅引用产品，业务字段全部快照
create table if not exists public.business_order_items (
  id                         uuid primary key default uuid_generate_v4(),
  order_id                   uuid not null references public.business_orders(id) on delete cascade,
  product_id                 uuid references public.products(id) on delete set null,
  sku_snapshot               text not null,
  name_snapshot              text not null,
  description_snapshot       text,
  specification_snapshot     text,
  unit_snapshot              text not null,
  image_url_snapshot         text,
  quantity                   numeric(18,4) not null check (
    quantity > 0 and quantity <= 999999999999
  ),
  unit_price                 numeric(18,2) not null check (
    unit_price >= 0 and unit_price <= 999999999999
  ),
  line_amount                numeric(18,2) generated always as (
    round(quantity * unit_price, 2)
  ) stored,
  sort_order                 int not null default 0 check (sort_order >= 0),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

comment on table public.business_order_items is '业务订单产品快照，价格与数量由 RPC 校验并重算';

drop trigger if exists trg_business_order_items_touch on public.business_order_items;
create trigger trg_business_order_items_touch
  before update on public.business_order_items
  for each row execute function public.touch_updated_at();

-- 5) 多次收款及私有凭证 object name
create table if not exists public.business_order_payments (
  id                         uuid primary key default uuid_generate_v4(),
  order_id                   uuid not null references public.business_orders(id) on delete cascade,
  payment_type               public.business_payment_type not null,
  amount                     numeric(18,2) not null check (
    amount > 0 and amount <= 999999999999
  ),
  currency                   public.currency_code not null,
  exchange_rate_to_cny       numeric(18,8) not null check (
    exchange_rate_to_cny > 0 and exchange_rate_to_cny <= 1000000
  ),
  received_at                timestamptz not null,
  proof_path                 text not null unique,
  notes                      text check (notes is null or char_length(notes) <= 1000),
  created_by                 uuid references public.profiles(id) on delete set null,
  updated_by                 uuid references public.profiles(id) on delete set null,
  voided_at                  timestamptz,
  voided_by                  uuid references public.profiles(id) on delete set null,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint business_payment_proof_object_name check (
    proof_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
  ),
  constraint business_payment_void_actor check (
    (voided_at is null and voided_by is null)
    or (voided_at is not null and voided_by is not null)
  )
);

comment on column public.business_order_payments.proof_path is 'business-payment-proofs 私有 bucket 内的 object name，不存公开 URL';

drop trigger if exists trg_business_order_payments_touch on public.business_order_payments;
create trigger trg_business_order_payments_touch
  before update on public.business_order_payments
  for each row execute function public.touch_updated_at();

-- 工资/提成与核算说明单独隔离，业务员不能通过业务订单 RLS 读取。
create table if not exists public.business_order_finance_details (
  order_id                    uuid primary key references public.business_orders(id) on delete restrict,
  wage_amount_cny             numeric(18,2) not null check (
    wage_amount_cny >= 0 and wage_amount_cny <= 999999999999
  ),
  calculation_notes           text not null check (
    char_length(btrim(calculation_notes)) between 1 and 4000
  ),
  updated_by                  uuid references public.profiles(id) on delete set null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

comment on table public.business_order_finance_details is '仅财务与管理员可见的业务订单工资/提成核算';

drop trigger if exists trg_business_order_finance_details_touch on public.business_order_finance_details;
create trigger trg_business_order_finance_details_touch
  before update on public.business_order_finance_details
  for each row execute function public.touch_updated_at();

-- 旧成本表兼容新业务订单；每条成本必须且只能关联一种订单。
alter table public.finance_order_costs
  alter column finance_order_id drop not null,
  add column if not exists business_order_id uuid
    references public.business_orders(id) on delete restrict;

alter table public.finance_order_costs
  drop constraint if exists finance_costs_exactly_one_order;
alter table public.finance_order_costs
  add constraint finance_costs_exactly_one_order
  check (num_nonnulls(finance_order_id, business_order_id) = 1);

create index if not exists idx_finance_costs_business_order
  on public.finance_order_costs (business_order_id);

create or replace function public.validate_finance_cost_order_reference()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.finance_order_id is not null and not exists (
    select 1
    from public.finance_orders fo
    where fo.id = new.finance_order_id
      and fo.status = 'active'
  ) then
    raise exception 'Legacy finance order does not exist or is inactive';
  end if;

  if new.business_order_id is not null and not exists (
    select 1
    from public.business_orders bo
    where bo.id = new.business_order_id
      and bo.status in ('approved', 'completed')
  ) then
    raise exception 'Business order must be approved or completed';
  end if;

  return new;
end;
$$;

revoke all on function public.validate_finance_cost_order_reference() from public;

drop trigger if exists trg_validate_finance_cost_order_reference on public.finance_order_costs;
create trigger trg_validate_finance_cost_order_reference
  before insert or update of finance_order_id, business_order_id
  on public.finance_order_costs
  for each row execute function public.validate_finance_cost_order_reference();

-- 6) 不可由客户端写入的追加式审计日志
create table if not exists public.business_order_audit_logs (
  id                         bigint generated always as identity primary key,
  order_id                   uuid not null references public.business_orders(id) on delete restrict,
  entity_type                text not null check (entity_type in ('order', 'item', 'payment')),
  entity_id                  uuid not null,
  action                     public.business_audit_action not null,
  from_status                public.business_order_status,
  to_status                  public.business_order_status,
  old_data                   jsonb,
  new_data                   jsonb,
  reason                     text check (reason is null or char_length(reason) <= 1000),
  actor_id                   uuid references public.profiles(id) on delete set null,
  actor_snapshot             jsonb not null,
  created_at                 timestamptz not null default now()
);

comment on table public.business_order_audit_logs is '业务订单追加式审计；客户端无写权限，订单禁止删除';

-- 7) FK、RLS、日期和状态查询索引
create index if not exists idx_business_orders_customer
  on public.business_orders (customer_id);
create index if not exists idx_business_orders_salesperson
  on public.business_orders (salesperson_id);
create index if not exists idx_business_orders_submitted_by
  on public.business_orders (submitted_by);
create index if not exists idx_business_orders_reviewed_by
  on public.business_orders (reviewed_by);
create index if not exists idx_business_orders_completed_by
  on public.business_orders (completed_by);
create index if not exists idx_business_orders_order_date
  on public.business_orders (order_date desc);
create index if not exists idx_business_orders_status_date
  on public.business_orders (status, order_date desc);
create index if not exists idx_business_orders_sales_status_date
  on public.business_orders (salesperson_id, status, order_date desc);

create index if not exists idx_business_order_items_order
  on public.business_order_items (order_id, sort_order);
create index if not exists idx_business_order_items_product
  on public.business_order_items (product_id);

create index if not exists idx_business_order_payments_order
  on public.business_order_payments (order_id);
create index if not exists idx_business_order_payments_order_active_date
  on public.business_order_payments (order_id, received_at desc) where voided_at is null;
create index if not exists idx_business_order_payments_created_by
  on public.business_order_payments (created_by);
create index if not exists idx_business_order_payments_updated_by
  on public.business_order_payments (updated_by);
create index if not exists idx_business_order_payments_voided_by
  on public.business_order_payments (voided_by);
create index if not exists idx_business_order_payments_received
  on public.business_order_payments (received_at desc);
create index if not exists idx_business_order_finance_updated_by
  on public.business_order_finance_details (updated_by);

create index if not exists idx_business_order_audit_order_created
  on public.business_order_audit_logs (order_id, created_at desc);
create index if not exists idx_business_order_audit_entity
  on public.business_order_audit_logs (entity_type, entity_id);
create index if not exists idx_business_order_audit_action_created
  on public.business_order_audit_logs (action, created_at desc);
create index if not exists idx_business_order_audit_actor
  on public.business_order_audit_logs (actor_id);

-- 8) 安全辅助函数
create or replace function public.can_view_business_order(p_order_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.business_orders bo
    join public.profiles p on p.id = (select auth.uid())
    where bo.id = p_order_id
      and p.status::text = 'approved'
      and (
        p.role::text in ('admin', 'finance')
        or (p.role::text = 'sales' and bo.salesperson_id = p.id)
      )
  );
$$;

revoke all on function public.can_view_business_order(uuid) from public;
grant execute on function public.can_view_business_order(uuid) to authenticated;

create or replace function public.write_business_order_audit(
  p_order_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_action public.business_audit_action,
  p_from_status public.business_order_status,
  p_to_status public.business_order_status,
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
  if p_entity_type not in ('order', 'item', 'payment') then
    raise exception 'Invalid audit entity type';
  end if;

  select * into v_actor
  from public.profiles
  where id = p_actor_id;

  if not found then
    raise exception 'Audit actor does not exist';
  end if;

  insert into public.business_order_audit_logs (
    order_id, entity_type, entity_id, action, from_status, to_status,
    old_data, new_data, reason, actor_id, actor_snapshot
  ) values (
    p_order_id, p_entity_type, p_entity_id, p_action, p_from_status, p_to_status,
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

revoke all on function public.write_business_order_audit(
  uuid, text, uuid, public.business_audit_action,
  public.business_order_status, public.business_order_status,
  jsonb, jsonb, text, uuid
) from public;

-- 仅供安全 RPC 调用：用 active 产品生成快照并返回服务端重算的小计。
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
  v_product public.products%rowtype;
  v_product_id uuid;
  v_quantity numeric;
  v_unit_price numeric;
  v_sort_order int := 0;
  v_subtotal numeric(18,2) := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Items must be a JSON array';
  end if;
  if jsonb_array_length(p_items) < 1 then
    raise exception 'At least one order item is required';
  end if;
  if jsonb_array_length(p_items) > 500 then
    raise exception 'Order items cannot exceed 500';
  end if;

  delete from public.business_order_items where order_id = p_order_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Each item must be an object';
    end if;

    v_product_id := nullif(v_item->>'product_id', '')::uuid;
    v_quantity := (v_item->>'quantity')::numeric;
    v_unit_price := (v_item->>'unit_price')::numeric;

    if v_product_id is null then
      raise exception 'Product is required';
    end if;
    if v_quantity is null or v_quantity <= 0 or v_quantity > 999999999999 then
      raise exception 'Quantity must be between zero and 999999999999';
    end if;
    if v_unit_price is null or v_unit_price < 0 or v_unit_price > 999999999999 then
      raise exception 'Unit price must be between zero and 999999999999';
    end if;

    select * into v_product
    from public.products
    where id = v_product_id
      and is_active = true;

    if not found then
      raise exception 'Product does not exist or is inactive';
    end if;

    insert into public.business_order_items (
      order_id, product_id, sku_snapshot, name_snapshot,
      description_snapshot, specification_snapshot, unit_snapshot,
      image_url_snapshot, quantity, unit_price, sort_order
    ) values (
      p_order_id, v_product.id, v_product.sku, v_product.name,
      v_product.description, v_product.specification, v_product.unit,
      v_product.image_url, v_quantity, v_unit_price, v_sort_order
    );

    v_subtotal := v_subtotal + round(v_quantity * v_unit_price, 2);
    v_sort_order := v_sort_order + 1;
  end loop;

  return v_subtotal;
end;
$$;

revoke all on function public.replace_business_order_items(uuid, jsonb) from public;

-- 9) 原子创建：只允许已审核 sales，客户必须属于本人，产品必须 active。
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
  select p.* into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved' or v_actor.role::text <> 'sales' then
    raise exception 'Only approved sales users can create business orders';
  end if;

  if p_order_date is null then
    raise exception 'Order date is required';
  end if;
  if p_exchange_rate_to_cny is null or p_exchange_rate_to_cny <= 0
     or p_exchange_rate_to_cny > 1000000
  then
    raise exception 'Exchange rate must be between zero and 1000000';
  end if;
  if p_currency::text = 'CNY' and p_exchange_rate_to_cny <> 1 then
    raise exception 'CNY exchange rate must equal one';
  end if;
  if p_shipping_fee is null or p_shipping_fee < 0 or p_shipping_fee > 999999999999 then
    raise exception 'Shipping fee must be between zero and 999999999999';
  end if;
  if char_length(coalesce(p_tracking_number, '')) > 200 then
    raise exception 'Tracking number cannot exceed 200 characters';
  end if;
  if char_length(coalesce(p_sales_notes, '')) > 2000 then
    raise exception 'Sales notes cannot exceed 2000 characters';
  end if;

  select c.* into v_customer
  from public.customers c
  where c.id = p_customer_id
    and c.created_by = v_uid;

  if not found then
    raise exception 'Customer does not exist or is not owned by salesperson';
  end if;

  insert into public.business_orders (
    order_number, customer_id, customer_snapshot,
    salesperson_id, salesperson_name_snapshot, order_date,
    fulfillment_type, currency, exchange_rate_to_cny,
    items_subtotal, shipping_fee, total_amount,
    tracking_number, sales_notes
  ) values (
    public.next_business_order_number(),
    v_customer.id,
    jsonb_build_object(
      'name', v_customer.name,
      'company', v_customer.company,
      'email', v_customer.email,
      'phone', v_customer.phone,
      'address', v_customer.address,
      'city', v_customer.city,
      'state', v_customer.state,
      'postal_code', v_customer.postal_code,
      'country', v_customer.country,
      'contact_person', v_customer.contact_person
    ),
    v_uid,
    coalesce(nullif(btrim(v_actor.full_name), ''), v_actor.email),
    p_order_date,
    p_fulfillment_type,
    p_currency,
    p_exchange_rate_to_cny,
    0,
    p_shipping_fee,
    p_shipping_fee,
    nullif(btrim(p_tracking_number), ''),
    nullif(btrim(p_sales_notes), '')
  ) returning * into v_order;

  v_subtotal := public.replace_business_order_items(v_order.id, p_items);

  update public.business_orders bo
  set items_subtotal = v_subtotal,
      total_amount = v_subtotal + p_shipping_fee
  where bo.id = v_order.id
  returning * into v_order;

  perform public.write_business_order_audit(
    v_order.id, 'order', v_order.id, 'create', null, v_order.status,
    null,
    jsonb_build_object(
      'order', to_jsonb(v_order),
      'items', coalesce((
        select jsonb_agg(to_jsonb(boi) order by boi.sort_order)
        from public.business_order_items boi
        where boi.order_id = v_order.id
      ), '[]'::jsonb)
    ),
    null, v_uid
  );

  return query select v_order.id, v_order.order_number, v_order.version;
end;
$$;

revoke all on function public.create_business_order(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb
) from public;
grant execute on function public.create_business_order(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb
) to authenticated;

-- 10) 编辑：sales 仅本人 draft/rejected；admin/finance 仅 completed 且必须写修正原因。
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
  v_existing_items jsonb;
  v_is_correction boolean := false;
begin
  select p.* into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Approved account required';
  end if;

  select bo.* into v_order
  from public.business_orders bo
  where bo.id = p_order_id
  for update;

  if not found then
    raise exception 'Business order does not exist';
  end if;
  if v_order.version <> p_expected_version then
    raise exception 'Business order version conflict';
  end if;

  if v_actor.role::text = 'sales' then
    if v_order.salesperson_id <> v_uid or v_order.status::text not in ('draft', 'rejected') then
      raise exception 'Salesperson cannot edit this business order';
    end if;
  elsif v_actor.role::text in ('admin', 'finance') then
    if v_order.status::text <> 'completed' then
      raise exception 'Administrators and finance can only correct completed orders';
    end if;
    if nullif(btrim(p_reason), '') is null then
      raise exception 'Correction reason is required';
    end if;
    v_is_correction := true;
  else
    raise exception 'Role cannot edit business orders';
  end if;

  if p_order_date is null then
    raise exception 'Order date is required';
  end if;
  if p_exchange_rate_to_cny is null or p_exchange_rate_to_cny <= 0
     or p_exchange_rate_to_cny > 1000000
  then
    raise exception 'Exchange rate must be between zero and 1000000';
  end if;
  if p_currency::text = 'CNY' and p_exchange_rate_to_cny <> 1 then
    raise exception 'CNY exchange rate must equal one';
  end if;
  if p_shipping_fee is null or p_shipping_fee < 0 or p_shipping_fee > 999999999999 then
    raise exception 'Shipping fee must be between zero and 999999999999';
  end if;
  if char_length(coalesce(p_tracking_number, '')) > 200 then
    raise exception 'Tracking number cannot exceed 200 characters';
  end if;
  if char_length(coalesce(p_sales_notes, '')) > 2000 then
    raise exception 'Sales notes cannot exceed 2000 characters';
  end if;

  select c.* into v_customer
  from public.customers c
  where c.id = p_customer_id
    and c.created_by = v_order.salesperson_id;

  if not found then
    raise exception 'Customer does not exist or is not owned by salesperson';
  end if;

  v_old := jsonb_build_object(
    'order', to_jsonb(v_order),
    'items', coalesce((
      select jsonb_agg(to_jsonb(boi) order by boi.sort_order)
      from public.business_order_items boi
      where boi.order_id = v_order.id
    ), '[]'::jsonb)
  );

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'product_id', boi.product_id,
        'quantity', boi.quantity,
        'unit_price', boi.unit_price
      ) order by boi.sort_order
    ),
    '[]'::jsonb
  ) into v_existing_items
  from public.business_order_items boi
  where boi.order_id = v_order.id;

  if p_items = v_existing_items then
    v_subtotal := v_order.items_subtotal;
  else
    v_subtotal := public.replace_business_order_items(v_order.id, p_items);
  end if;

  update public.business_orders bo
  set customer_id = v_customer.id,
      customer_snapshot = jsonb_build_object(
        'name', v_customer.name,
        'company', v_customer.company,
        'email', v_customer.email,
        'phone', v_customer.phone,
        'address', v_customer.address,
        'city', v_customer.city,
        'state', v_customer.state,
        'postal_code', v_customer.postal_code,
        'country', v_customer.country,
        'contact_person', v_customer.contact_person
      ),
      order_date = p_order_date,
      fulfillment_type = p_fulfillment_type,
      currency = p_currency,
      exchange_rate_to_cny = p_exchange_rate_to_cny,
      items_subtotal = v_subtotal,
      shipping_fee = p_shipping_fee,
      total_amount = v_subtotal + p_shipping_fee,
      tracking_number = nullif(btrim(p_tracking_number), ''),
      sales_notes = nullif(btrim(p_sales_notes), ''),
      version = bo.version + 1
  where bo.id = v_order.id
  returning * into v_order;

  perform public.write_business_order_audit(
    v_order.id, 'order', v_order.id,
    case when v_is_correction then 'correct'::public.business_audit_action
         else 'update'::public.business_audit_action end,
    v_order.status, v_order.status, v_old,
    jsonb_build_object(
      'order', to_jsonb(v_order),
      'items', coalesce((
        select jsonb_agg(to_jsonb(boi) order by boi.sort_order)
        from public.business_order_items boi
        where boi.order_id = v_order.id
      ), '[]'::jsonb)
    ),
    p_reason, v_uid
  );

  return query select v_order.id, v_order.order_number, v_order.version;
end;
$$;

revoke all on function public.update_business_order(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, text
) from public;
grant execute on function public.update_business_order(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, text
) to authenticated;

-- 11) 新增多次收款：sales 仅本人 draft/rejected；admin/finance 仅 completed 且带原因。
create or replace function public.add_business_order_payment(
  p_order_id uuid,
  p_payment_type public.business_payment_type,
  p_amount numeric,
  p_received_at timestamptz,
  p_proof_path text,
  p_notes text,
  p_reason text
)
returns public.business_order_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_payment public.business_order_payments%rowtype;
begin
  select * into v_actor from public.profiles where id = v_uid;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Approved account required';
  end if;

  select * into v_order
  from public.business_orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Business order does not exist';
  end if;

  if v_actor.role::text = 'sales' then
    if v_order.salesperson_id <> v_uid or v_order.status::text not in ('draft', 'rejected') then
      raise exception 'Salesperson cannot add payment to this order';
    end if;
  elsif v_actor.role::text in ('admin', 'finance') then
    if v_order.status::text <> 'completed' then
      raise exception 'Administrators and finance can only correct completed orders';
    end if;
    if nullif(btrim(p_reason), '') is null then
      raise exception 'Correction reason is required';
    end if;
  else
    raise exception 'Role cannot add business order payments';
  end if;

  if p_amount is null or p_amount <= 0 or p_amount > 999999999999 then
    raise exception 'Payment amount must be between zero and 999999999999';
  end if;
  if p_received_at is null then
    raise exception 'Payment received time is required';
  end if;
  if char_length(coalesce(p_notes, '')) > 1000 then
    raise exception 'Payment notes cannot exceed 1000 characters';
  end if;
  if char_length(coalesce(p_reason, '')) > 1000 then
    raise exception 'Reason cannot exceed 1000 characters';
  end if;
  if nullif(btrim(p_proof_path), '') is null
     or p_proof_path !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
     or split_part(p_proof_path, '/', 1) <> v_uid::text
     or split_part(p_proof_path, '/', 2) <> p_order_id::text
  then
    raise exception 'Invalid payment proof path';
  end if;
  if not exists (
    select 1
    from storage.objects so
    where so.bucket_id = 'business-payment-proofs'
      and so.name = p_proof_path
  ) then
    raise exception 'Payment proof object does not exist';
  end if;

  insert into public.business_order_payments (
    order_id, payment_type, amount, currency, exchange_rate_to_cny,
    received_at, proof_path, notes, created_by, updated_by
  ) values (
    p_order_id, p_payment_type, p_amount, v_order.currency, v_order.exchange_rate_to_cny,
    p_received_at, p_proof_path, nullif(btrim(p_notes), ''), v_uid, v_uid
  ) returning * into v_payment;

  update public.business_orders
  set version = version + 1
  where id = p_order_id;

  perform public.write_business_order_audit(
    p_order_id, 'payment', v_payment.id, 'payment_add',
    v_order.status, v_order.status, null, to_jsonb(v_payment), p_reason, v_uid
  );

  return v_payment;
end;
$$;

revoke all on function public.add_business_order_payment(
  uuid, public.business_payment_type, numeric, timestamptz, text, text, text
) from public;
grant execute on function public.add_business_order_payment(
  uuid, public.business_payment_type, numeric, timestamptz, text, text, text
) to authenticated;

-- 12) 更新收款：原凭证可保留；替换凭证时必须使用当前操作者的新 object name。
create or replace function public.update_business_order_payment(
  p_payment_id uuid,
  p_payment_type public.business_payment_type,
  p_amount numeric,
  p_received_at timestamptz,
  p_proof_path text,
  p_notes text,
  p_reason text
)
returns public.business_order_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_payment public.business_order_payments%rowtype;
  v_old jsonb;
begin
  select * into v_actor from public.profiles where id = v_uid;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Approved account required';
  end if;

  select bo.* into v_order
  from public.business_orders bo
  join public.business_order_payments bp on bp.order_id = bo.id
  where bp.id = p_payment_id
  for update of bo;

  if not found then
    raise exception 'Payment does not exist';
  end if;

  select * into v_payment
  from public.business_order_payments
  where id = p_payment_id
  for update;

  if v_payment.voided_at is not null then
    raise exception 'Payment is already voided';
  end if;

  if v_actor.role::text = 'sales' then
    if v_order.salesperson_id <> v_uid or v_order.status::text not in ('draft', 'rejected') then
      raise exception 'Salesperson cannot update payment for this order';
    end if;
  elsif v_actor.role::text in ('admin', 'finance') then
    if v_order.status::text <> 'completed' then
      raise exception 'Administrators and finance can only correct completed orders';
    end if;
    if nullif(btrim(p_reason), '') is null then
      raise exception 'Correction reason is required';
    end if;
  else
    raise exception 'Role cannot update business order payments';
  end if;

  if p_payment_type is null then
    raise exception 'Payment type is required';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 999999999999 then
    raise exception 'Payment amount must be between zero and 999999999999';
  end if;
  if p_received_at is null then
    raise exception 'Payment received time is required';
  end if;
  if char_length(coalesce(p_notes, '')) > 1000 then
    raise exception 'Payment notes cannot exceed 1000 characters';
  end if;
  if char_length(coalesce(p_reason, '')) > 1000 then
    raise exception 'Reason cannot exceed 1000 characters';
  end if;
  if nullif(btrim(p_proof_path), '') is null then
    raise exception 'Invalid payment proof path';
  end if;
  if p_proof_path <> v_payment.proof_path
     and (
       p_proof_path !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
       or split_part(p_proof_path, '/', 1) <> v_uid::text
       or split_part(p_proof_path, '/', 2) <> v_order.id::text
     )
  then
    raise exception 'Invalid payment proof path';
  end if;
  if not exists (
    select 1
    from storage.objects so
    where so.bucket_id = 'business-payment-proofs'
      and so.name = p_proof_path
  ) then
    raise exception 'Payment proof object does not exist';
  end if;

  v_old := to_jsonb(v_payment);

  update public.business_order_payments
  set payment_type = p_payment_type,
      amount = p_amount,
      received_at = p_received_at,
      proof_path = p_proof_path,
      notes = nullif(btrim(p_notes), ''),
      updated_by = v_uid
  where id = p_payment_id
  returning * into v_payment;

  update public.business_orders
  set version = version + 1
  where id = v_order.id;

  perform public.write_business_order_audit(
    v_order.id, 'payment', v_payment.id, 'payment_update',
    v_order.status, v_order.status, v_old, to_jsonb(v_payment), p_reason, v_uid
  );

  return v_payment;
end;
$$;

revoke all on function public.update_business_order_payment(
  uuid, public.business_payment_type, numeric, timestamptz, text, text, text
) from public;
grant execute on function public.update_business_order_payment(
  uuid, public.business_payment_type, numeric, timestamptz, text, text, text
) to authenticated;

-- 13) 收款作废（软删除）
create or replace function public.void_business_order_payment(
  p_payment_id uuid,
  p_reason text
)
returns public.business_order_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_payment public.business_order_payments%rowtype;
  v_old jsonb;
begin
  select * into v_actor from public.profiles where id = v_uid;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Approved account required';
  end if;

  select bo.* into v_order
  from public.business_orders bo
  join public.business_order_payments bp on bp.order_id = bo.id
  where bp.id = p_payment_id
  for update of bo;

  if not found then
    raise exception 'Payment does not exist';
  end if;

  select * into v_payment
  from public.business_order_payments
  where id = p_payment_id
  for update;

  if v_payment.voided_at is not null then
    raise exception 'Payment is already voided';
  end if;

  if v_actor.role::text = 'sales' then
    if v_order.salesperson_id <> v_uid or v_order.status::text not in ('draft', 'rejected') then
      raise exception 'Salesperson cannot void payment for this order';
    end if;
  elsif v_actor.role::text in ('admin', 'finance') then
    if v_order.status::text <> 'completed' then
      raise exception 'Administrators and finance can only correct completed orders';
    end if;
    if nullif(btrim(p_reason), '') is null then
      raise exception 'Correction reason is required';
    end if;
  else
    raise exception 'Role cannot void business order payments';
  end if;

  if char_length(coalesce(p_reason, '')) > 1000 then
    raise exception 'Reason cannot exceed 1000 characters';
  end if;
  if v_order.status::text = 'completed' and (
    select count(*)
    from public.business_order_payments bp
    where bp.order_id = v_order.id
      and bp.voided_at is null
  ) <= 1 then
    raise exception 'Completed order must keep at least one active payment';
  end if;

  v_old := to_jsonb(v_payment);

  update public.business_order_payments
  set voided_at = now(),
      voided_by = v_uid,
      updated_by = v_uid
  where id = p_payment_id
  returning * into v_payment;

  update public.business_orders
  set version = version + 1
  where id = v_order.id;

  perform public.write_business_order_audit(
    v_order.id, 'payment', v_payment.id, 'payment_void',
    v_order.status, v_order.status, v_old, to_jsonb(v_payment), p_reason, v_uid
  );

  return v_payment;
end;
$$;

revoke all on function public.void_business_order_payment(uuid, text) from public;
grant execute on function public.void_business_order_payment(uuid, text) to authenticated;

-- 13) 状态机：sales 提交；admin 审批/驳回；finance 完成。
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

  select * into v_order
  from public.business_orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Business order does not exist';
  end if;

  v_old := to_jsonb(v_order);

  if char_length(coalesce(p_note, '')) > 1000 then
    raise exception 'Note cannot exceed 1000 characters';
  end if;

  if v_actor.role::text = 'sales'
     and v_order.salesperson_id = v_uid
     and v_order.status::text in ('draft', 'rejected')
     and p_target::text = 'submitted'
  then
    if not exists (
      select 1 from public.business_order_items where order_id = v_order.id
    ) then
      raise exception 'At least one order item is required before submission';
    end if;
    if not exists (
      select 1
      from public.business_order_payments
      where order_id = v_order.id and voided_at is null
    ) then
      raise exception 'At least one active payment is required before submission';
    end if;
    if exists (
      select 1
      from public.business_order_payments bp
      where bp.order_id = v_order.id
        and bp.voided_at is null
        and (
          nullif(btrim(bp.proof_path), '') is null
          or not exists (
            select 1
            from storage.objects so
            where so.bucket_id = 'business-payment-proofs'
              and so.name = bp.proof_path
          )
        )
    ) then
      raise exception 'Every active payment must have an uploaded proof';
    end if;

    update public.business_orders
    set status = 'submitted',
        submitted_by = v_uid,
        submitted_at = now(),
        version = version + 1
    where id = v_order.id
    returning * into v_order;
    v_action := 'submit';

  elsif v_actor.role::text = 'admin'
        and v_order.status::text = 'submitted'
        and p_target::text in ('approved', 'rejected')
  then
    if p_target::text = 'rejected' and nullif(btrim(p_note), '') is null then
      raise exception 'Rejection note is required';
    end if;

    update public.business_orders
    set status = p_target,
        review_note = nullif(btrim(p_note), ''),
        reviewed_by = v_uid,
        reviewed_at = now(),
        version = version + 1
    where id = v_order.id
    returning * into v_order;
    v_action := case when p_target::text = 'approved' then 'approve' else 'reject' end;

  elsif v_actor.role::text = 'finance'
        and v_order.status::text = 'approved'
        and p_target::text = 'completed'
  then
    if not exists (
      select 1
      from public.business_order_finance_details bofd
      where bofd.order_id = v_order.id
        and bofd.wage_amount_cny >= 0
        and nullif(btrim(bofd.calculation_notes), '') is not null
    ) then
      raise exception 'Wage amount and calculation notes are required before completion';
    end if;

    update public.business_orders
    set status = 'completed',
        completed_by = v_uid,
        completed_at = now(),
        version = version + 1
    where id = v_order.id
    returning * into v_order;
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
) from public;
grant execute on function public.transition_business_order(
  uuid, public.business_order_status, text
) to authenticated;

-- 14) 财务详情：finance 可维护 approved；completed 仅 admin/finance 带原因修正。
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
  v_action public.business_audit_action;
begin
  select p.* into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Approved account required';
  end if;

  select bo.* into v_order
  from public.business_orders bo
  where bo.id = p_order_id
  for update;

  if not found then
    raise exception 'Business order does not exist';
  end if;

  if p_wage_amount_cny is null or p_wage_amount_cny < 0
     or p_wage_amount_cny > 999999999999
  then
    raise exception 'Wage amount must be between zero and 999999999999';
  end if;
  if nullif(btrim(p_calculation_notes), '') is null then
    raise exception 'Calculation notes are required';
  end if;
  if char_length(btrim(p_calculation_notes)) > 4000 then
    raise exception 'Calculation notes cannot exceed 4000 characters';
  end if;
  if char_length(coalesce(p_reason, '')) > 1000 then
    raise exception 'Reason cannot exceed 1000 characters';
  end if;

  if v_order.status::text = 'approved' then
    if v_actor.role::text <> 'finance' then
      raise exception 'Only finance can edit approved order finance fields';
    end if;
    v_action := 'finance_update';
  elsif v_order.status::text = 'completed' then
    if v_actor.role::text not in ('admin', 'finance') then
      raise exception 'Role cannot correct completed order finance fields';
    end if;
    if nullif(btrim(p_reason), '') is null then
      raise exception 'Correction reason is required';
    end if;
    v_action := 'correct';
  else
    raise exception 'Finance fields cannot be edited in current status';
  end if;

  select to_jsonb(bofd) into v_old
  from public.business_order_finance_details bofd
  where bofd.order_id = v_order.id;

  insert into public.business_order_finance_details (
    order_id, wage_amount_cny, calculation_notes, updated_by
  ) values (
    v_order.id, p_wage_amount_cny, btrim(p_calculation_notes), v_uid
  )
  on conflict (order_id) do update
  set wage_amount_cny = excluded.wage_amount_cny,
      calculation_notes = excluded.calculation_notes,
      updated_by = excluded.updated_by
  returning * into v_finance;

  update public.business_orders bo
  set version = bo.version + 1
  where bo.id = v_order.id;

  perform public.write_business_order_audit(
    v_order.id, 'order', v_order.id, v_action,
    v_order.status, v_order.status, v_old, to_jsonb(v_finance), p_reason, v_uid
  );

  return v_finance;
end;
$$;

revoke all on function public.save_business_order_finance(uuid, numeric, text, text) from public;
grant execute on function public.save_business_order_finance(uuid, numeric, text, text) to authenticated;

-- 15) RLS：客户端只读，所有写入必须经上述 SECURITY DEFINER RPC。
alter table public.business_orders enable row level security;
alter table public.business_order_items enable row level security;
alter table public.business_order_payments enable row level security;
alter table public.business_order_finance_details enable row level security;
alter table public.business_order_audit_logs enable row level security;

revoke all on table public.business_orders from anon, authenticated;
revoke all on table public.business_order_items from anon, authenticated;
revoke all on table public.business_order_payments from anon, authenticated;
revoke all on table public.business_order_finance_details from anon, authenticated;
revoke all on table public.business_order_audit_logs from anon, authenticated;

grant select on table public.business_orders to authenticated;
grant select on table public.business_order_items to authenticated;
grant select on table public.business_order_payments to authenticated;
grant select on table public.business_order_finance_details to authenticated;
grant select on table public.business_order_audit_logs to authenticated;

drop policy if exists "business_orders_select" on public.business_orders;
create policy "business_orders_select" on public.business_orders
  for select to authenticated
  using (public.can_view_business_order(id));

drop policy if exists "business_order_items_select" on public.business_order_items;
create policy "business_order_items_select" on public.business_order_items
  for select to authenticated
  using (public.can_view_business_order(order_id));

drop policy if exists "business_order_payments_select" on public.business_order_payments;
create policy "business_order_payments_select" on public.business_order_payments
  for select to authenticated
  using (public.can_view_business_order(order_id));

drop policy if exists "business_order_finance_select" on public.business_order_finance_details;
create policy "business_order_finance_select" on public.business_order_finance_details
  for select to authenticated
  using (public.is_finance_or_admin());

drop policy if exists "business_order_audit_select" on public.business_order_audit_logs;
create policy "business_order_audit_select" on public.business_order_audit_logs
  for select to authenticated
  using (public.is_finance_or_admin());

-- 冻结旧 PI 业绩新增入口，仅保留历史读取与财务维护。
drop policy if exists "finance_orders_insert" on public.finance_orders;
revoke insert on table public.finance_orders from authenticated;

-- 新业务订单的客户收款必须从订单详情登记，禁止再次写入旧流水造成双计。
create or replace function public.reject_duplicate_business_receipt()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_category text := regexp_replace(lower(btrim(new.category)), '[[:space:]]+', '', 'g');
begin
  if new.transaction_type::text = 'income'
     and v_category in (
       '客户回款', '客户收款', '订单回款',
       'customerpayment', 'customerpaymentreceipt', 'orderpayment'
     )
  then
    raise exception 'Business order customer receipts must be recorded on the order';
  end if;
  return new;
end;
$$;

revoke all on function public.reject_duplicate_business_receipt() from public;

drop trigger if exists trg_reject_duplicate_business_receipt on public.finance_transactions;
create trigger trg_reject_duplicate_business_receipt
  before insert or update of transaction_type, category on public.finance_transactions
  for each row execute function public.reject_duplicate_business_receipt();

-- 16) 私有收款凭证 bucket 与 Storage RLS。
insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) values (
  'business-payment-proofs',
  'business-payment-proofs',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "business_payment_proofs_insert" on storage.objects;
create policy "business_payment_proofs_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'business-payment-proofs'
    and case
      when array_length(storage.foldername(name), 1) = 2
       and (storage.foldername(name))[1] = (select auth.uid())::text
       and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
      then exists (
        select 1
        from public.profiles p
        join public.business_orders bo
          on bo.id = ((storage.foldername(name))[2])::uuid
        where p.id = (select auth.uid())
          and p.status::text = 'approved'
          and (
            (p.role::text = 'sales'
             and bo.salesperson_id = p.id
             and bo.status::text in ('draft', 'rejected'))
            or (p.role::text in ('admin', 'finance')
                and bo.status::text = 'completed')
          )
      )
      else false
    end
  );

drop policy if exists "business_payment_proofs_select" on storage.objects;
create policy "business_payment_proofs_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'business-payment-proofs'
    and case
      when array_length(storage.foldername(name), 1) = 2
       and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
      then public.can_view_business_order(((storage.foldername(name))[2])::uuid)
      else false
    end
  );

-- 不创建 Storage UPDATE/DELETE policy：客户端不能覆盖或删除审计凭证。

-- 17) 财务总览兼容旧财务记录与新业务订单，保持 0016 的返回结构不变。
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
    from public.finance_orders
    where status = 'active'
  ),
  business_order_summary as (
    select coalesce(sum(total_cny), 0) as amount
    from public.business_orders
    where status = 'completed'
  ),
  transaction_summary as (
    select
      coalesce(sum(amount_cny) filter (where transaction_type = 'income'), 0) as income,
      coalesce(sum(amount_cny) filter (where transaction_type = 'expense'), 0) as expense
    from public.finance_transactions
    where status = 'active'
  ),
  business_payment_summary as (
    select coalesce(sum(round(bp.amount * bp.exchange_rate_to_cny, 2)), 0) as income
    from public.business_order_payments bp
    where bp.voided_at is null
  ),
  legacy_cost_summary as (
    select coalesce(sum(foc.amount_cny), 0) as amount
    from public.finance_order_costs foc
    where foc.finance_order_id is not null
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
    lo.amount + bo.amount as order_revenue,
    ts.income + bp.income as income,
    ts.expense as expense,
    lc.amount + bc.amount + bw.amount as order_costs,
    (lo.amount + bo.amount) - (lc.amount + bc.amount + bw.amount) as gross_profit,
    (ts.income + bp.income) - ts.expense as cash_balance
  from legacy_order_summary lo
  cross join business_order_summary bo
  cross join transaction_summary ts
  cross join business_payment_summary bp
  cross join legacy_cost_summary lc
  cross join business_cost_summary bc
  cross join business_wage_summary bw;
$$;

revoke all on function public.get_finance_summary() from public;
grant execute on function public.get_finance_summary() to authenticated;
