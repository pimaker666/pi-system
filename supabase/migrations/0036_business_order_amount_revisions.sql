-- 0036: 已审批订单的追加明细（加单）与发货超发，以及应收变更留痕。
--
-- 业务背景：同一订单会分批发货、中途加单，实际发货量也可能略高于下单量。
-- 0030 之前只有 draft/rejected 可编辑明细，且发货量硬性不得超过下单量，
-- 因此「加单」只能新建订单、「超发」只能改单前撤回付款，两者都与真实流程不符。
--
-- 本迁移新增两条受控写入路径，并把「应收为什么变了」落到独立台账：
--   1) adjust_business_order_items  —— 已审批订单追加新行或上调已有行数量（即时生效 + 留痕）
--   2) create_business_order_shipment(8 参) —— 发货时一步确认超发，同事务上调下单量
--   3) business_order_amount_revisions —— 应收变更时间轴，订单详情页独立展示
--
-- 与 0035 应收实收差额约束的关系（本迁移唯一改动的既有对象）：
--   业务上每张订单都经 create_business_order_v4 建立，因此 total_sales_amount（实收）总是有值。
--   加单或超发把 total_amount（应收）抬高后必然与实收产生差额，而 0035 的延迟约束触发器要求
--   差额必须有 receivable_received_difference_reason；该字段一旦有付款或发货就被
--   trg_protect_business_order_daily_fields 冻结，两个不变式因此互相锁死。
--   解法：本迁移放宽 validate_business_order_receivable_received_gap，让本台账里的结构化变更行
--   同样算作「差额已解释」。金额与自由文本原因仍然冻结，差额仍然必须有解释，只是解释来自
--   台账的前后金额、变更明细、操作人与时间；reason 仅作为可选的补充说明。
--
-- 边界（刻意不动）：
--   * 不写 total_sales_amount / daily_* / receivable_received_difference_reason。
--   * 数量下调、删除行、改价、换产品仍由 protect_business_order_item_invariants 拦截，本迁移不重复实现。
--   * completed / closed_at 订单仍然完全不可变。
--   * 不使用 ALTER TYPE ADD VALUE：审计沿用既有 business_audit_action 的 'update'。
--
-- 整个迁移放在一个显式事务里：deploy/nas/apply-migrations.sh 以 autocommit 方式喂给 psql，
-- 否则中途失败会留下「有表没函数」或「函数已换签名但台账表缺失」的半成品状态。

begin;

-- -----------------------------------------------------------------------------
-- 1. 应收变更台账
-- -----------------------------------------------------------------------------
create table if not exists public.business_order_amount_revisions (
  id                                uuid primary key default uuid_generate_v4(),
  order_id                          uuid not null references public.business_orders(id) on delete cascade,
  revision_no                       int not null check (revision_no > 0),
  reason_type                       text not null check (
    reason_type in ('add_on', 'quantity_fix', 'over_shipment')
  ),
  items_subtotal_before             numeric(18,2) not null,
  items_subtotal_after              numeric(18,2) not null,
  total_amount_before               numeric(18,2) not null,
  total_amount_after                numeric(18,2) not null,
  detail                            jsonb not null default '{}'::jsonb,
  reason                            text check (reason is null or char_length(reason) <= 1000),
  created_by                        uuid references public.profiles(id) on delete set null,
  creator_display_name_snapshot     text,
  created_at                        timestamptz not null default now(),
  constraint business_order_amount_revisions_no_unique unique (order_id, revision_no)
);

comment on table public.business_order_amount_revisions is
  '已审批订单的应收变更时间轴：加单、数量修正、超发各留一行，订单详情页按 revision_no 展示';
comment on column public.business_order_amount_revisions.detail is
  '本次变更涉及的明细行快照（kind/quantity_before/quantity_after/unit_price），仅供展示与追溯';

create index if not exists idx_business_order_amount_revisions_order
  on public.business_order_amount_revisions (order_id, revision_no desc);
create index if not exists idx_business_order_amount_revisions_created_by
  on public.business_order_amount_revisions (created_by) where created_by is not null;

alter table public.business_order_amount_revisions enable row level security;
revoke all on table public.business_order_amount_revisions
  from public, anon, authenticated, service_role;
grant select on table public.business_order_amount_revisions to authenticated;

drop policy if exists "business_order_amount_revisions_select"
  on public.business_order_amount_revisions;
create policy "business_order_amount_revisions_select"
  on public.business_order_amount_revisions
  for select to authenticated
  using (public.can_view_business_order(order_id));

-- 与其它业务表一致：任何写语句都必须由已审批账号发起，并与账号交接互斥。
drop trigger if exists trg_000_guard_approved_write on public.business_order_amount_revisions;
create trigger trg_000_guard_approved_write
  before insert or update or delete on public.business_order_amount_revisions
  for each statement execute function public.guard_approved_actor_statement();

-- -----------------------------------------------------------------------------
-- 2. 台账写入助手：只允许 RPC 内部调用
-- -----------------------------------------------------------------------------
create or replace function public.business_write_order_amount_revision(
  p_order_id uuid,
  p_reason_type text,
  p_items_subtotal_before numeric,
  p_items_subtotal_after numeric,
  p_total_amount_before numeric,
  p_total_amount_after numeric,
  p_detail jsonb,
  p_reason text,
  p_actor_id uuid
)
returns public.business_order_amount_revisions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_revision public.business_order_amount_revisions%rowtype;
begin
  if p_reason_type not in ('add_on', 'quantity_fix', 'over_shipment') then
    raise exception 'Invalid amount revision reason type';
  end if;
  if char_length(coalesce(p_reason, '')) > 1000 then
    raise exception 'Amount revision reason cannot exceed 1000 characters';
  end if;
  select * into v_actor from public.profiles where id = p_actor_id;
  if not found then raise exception 'Amount revision actor does not exist'; end if;

  -- 调用方已持有 business_orders 行的 FOR UPDATE 锁，因此这里取号不会并发重复。
  insert into public.business_order_amount_revisions (
    order_id, revision_no, reason_type,
    items_subtotal_before, items_subtotal_after,
    total_amount_before, total_amount_after,
    detail, reason, created_by, creator_display_name_snapshot
  ) values (
    p_order_id,
    coalesce((select max(r.revision_no) from public.business_order_amount_revisions r
              where r.order_id = p_order_id), 0) + 1,
    p_reason_type,
    round(p_items_subtotal_before, 2), round(p_items_subtotal_after, 2),
    round(p_total_amount_before, 2), round(p_total_amount_after, 2),
    coalesce(p_detail, '{}'::jsonb),
    nullif(btrim(p_reason), ''),
    p_actor_id,
    coalesce(nullif(btrim(v_actor.chinese_name), ''), v_actor.full_name)
  ) returning * into v_revision;

  return v_revision;
end;
$$;
revoke all on function public.business_write_order_amount_revision(
  uuid, text, numeric, numeric, numeric, numeric, jsonb, text, uuid
) from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. 追加明细：已审批订单加单 / 上调数量
-- -----------------------------------------------------------------------------
-- p_items 是增量而非全量：带 id 表示上调已有行数量，不带 id 表示新增一行。
-- 同一产品允许出现在多行上（加单批次天然独立，便于按批追溯发货）。
create or replace function public.adjust_business_order_items(
  p_order_id uuid,
  p_expected_version int,
  p_items jsonb,
  p_reason_type text,
  p_reason text,
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
  v_idempotency public.business_rpc_idempotency%rowtype;
  v_item jsonb;
  v_existing public.business_order_items%rowtype;
  v_product public.products%rowtype;
  v_custom_product public.business_custom_products%rowtype;
  v_custom_version public.business_custom_product_versions%rowtype;
  v_requested_id uuid;
  v_source_type text;
  v_product_id uuid;
  v_custom_product_id uuid;
  v_custom_version_id uuid;
  v_quantity numeric;
  v_quantity_before numeric;
  v_unit_price numeric;
  v_sort_order int;
  v_changes jsonb := '[]'::jsonb;
  v_subtotal_before numeric(18,2);
  v_total_before numeric(18,2);
  v_subtotal_after numeric(18,2);
  v_revision public.business_order_amount_revisions%rowtype;
  v_hash text;
  v_old jsonb;
  v_new jsonb;
  v_result jsonb;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin') then
    raise exception 'Approved sales, supervisor, or admin account required';
  end if;
  if p_reason_type not in ('add_on', 'quantity_fix') then
    raise exception 'Adjustment reason type must be add_on or quantity_fix';
  end if;
  if char_length(coalesce(p_reason, '')) > 1000 then
    raise exception 'Adjustment reason cannot exceed 1000 characters';
  end if;
  if nullif(btrim(coalesce(p_idempotency_key, '')), '') is null
     or char_length(btrim(p_idempotency_key)) > 200 then
    raise exception 'Idempotency key is invalid';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 500 then
    raise exception 'Adjustment items count must be between 1 and 500';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_items) as x(id uuid)
    where x.id is not null
    group by x.id having count(*) > 1
  ) then
    raise exception 'Each adjustment order item id must be unique';
  end if;

  select * into v_order from public.business_orders bo where bo.id = p_order_id for update;
  if not found then raise exception 'Business order does not exist'; end if;

  -- 幂等查询必须先于版本闸门：一次已提交的调整被重试时，客户端手上的 expected_version
  -- 已经过期，若先判版本就只会得到「版本冲突」，幂等键形同虚设。
  v_hash := encode(digest(jsonb_build_object(
    'order_id', p_order_id,
    'expected_version', p_expected_version,
    'items', p_items,
    'reason_type', p_reason_type,
    'reason', nullif(btrim(p_reason), '')
  )::text, 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    v_uid::text || ':adjust_business_order_items:' || btrim(p_idempotency_key), 0));
  select * into v_idempotency from public.business_rpc_idempotency
  where actor_id = v_uid and operation = 'adjust_business_order_items'
    and idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_idempotency.payload_hash <> v_hash then
      raise exception 'Idempotency key was already used with a different payload';
    end if;
    return v_idempotency.result;
  end if;

  if v_order.version <> p_expected_version then
    raise exception 'Business order version conflict';
  end if;
  if v_order.closed_at is not null then
    raise exception 'Closed business order cannot be adjusted';
  end if;
  if v_order.status::text = 'completed' then
    raise exception 'Completed business order is immutable';
  end if;
  if v_order.status::text <> 'approved' or v_order.approval_status <> 'approved' then
    raise exception 'Only approved orders can be adjusted; edit the draft instead';
  end if;
  if v_order.customer_id is null then raise exception 'Business order customer is required'; end if;
  if v_actor.role::text in ('sales', 'supervisor')
     and v_order.salesperson_id is distinct from v_uid then
    raise exception 'Sales user cannot adjust another owner business order';
  end if;

  v_old := jsonb_build_object(
    'order', to_jsonb(v_order),
    'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order, i.id)
                       from public.business_order_items i
                       where i.order_id = v_order.id), '[]'::jsonb)
  );
  v_subtotal_before := v_order.items_subtotal;
  v_total_before := v_order.total_amount;
  select coalesce(max(i.sort_order), -1) + 1 into v_sort_order
  from public.business_order_items i where i.order_id = p_order_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) <> 'object' then raise exception 'Each item must be an object'; end if;
    v_requested_id := nullif(v_item->>'id', '')::uuid;
    v_product_id := nullif(v_item->>'product_id', '')::uuid;
    v_custom_product_id := nullif(v_item->>'custom_product_id', '')::uuid;
    v_custom_version_id := nullif(v_item->>'custom_product_version_id', '')::uuid;
    v_quantity := round((v_item->>'quantity')::numeric, 4);
    if v_quantity is null or v_quantity <= 0 or v_quantity > 999999999999 then
      raise exception 'Quantity is invalid';
    end if;

    if v_requested_id is not null then
      -- 上调已有行：只允许数量变大，其余字段一律不动（换产品/改价由触发器拦截，此处直接拒绝）。
      select * into v_existing from public.business_order_items
      where id = v_requested_id and order_id = p_order_id for update;
      if not found then raise exception 'Order item id does not belong to order'; end if;
      if v_quantity <= v_existing.quantity then
        raise exception 'Adjustment can only increase an existing order item quantity';
      end if;
      if v_item ? 'unit_price'
         and round((v_item->>'unit_price')::numeric, 2) is distinct from v_existing.unit_price then
        raise exception 'Order item unit price cannot be changed by an adjustment';
      end if;
      if (v_product_id is not null and v_product_id is distinct from v_existing.product_id)
         or (v_custom_product_id is not null
             and v_custom_product_id is distinct from v_existing.custom_product_id)
         or (v_custom_version_id is not null
             and v_custom_version_id is distinct from v_existing.custom_product_version_id) then
        raise exception 'Order item product cannot be replaced by an adjustment';
      end if;

      v_quantity_before := v_existing.quantity;
      update public.business_order_items set quantity = v_quantity
      where id = v_existing.id
      returning * into v_existing;

      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'kind', 'quantity_increased',
        'order_item_id', v_existing.id,
        'name_snapshot', v_existing.name_snapshot,
        'unit_snapshot', v_existing.unit_snapshot,
        'unit_price', v_existing.unit_price,
        'quantity_before', v_quantity_before,
        'quantity_after', v_existing.quantity
      ));
    else
      v_unit_price := round((v_item->>'unit_price')::numeric, 2);
      if v_unit_price is null or v_unit_price < 0 or v_unit_price > 999999999999 then
        raise exception 'Unit price is invalid';
      end if;
      v_source_type := coalesce(nullif(v_item->>'source_type', ''),
        case when v_custom_product_id is not null or v_custom_version_id is not null
             then 'custom' else 'catalog' end);

      if v_source_type = 'catalog' then
        if v_product_id is null or v_custom_product_id is not null
           or v_custom_version_id is not null then
          raise exception 'Catalog item requires only product_id';
        end if;
        select * into v_product from public.products where id = v_product_id;
        if not found or not v_product.is_active then
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
        ) returning * into v_existing;
      elsif v_source_type = 'custom' then
        if v_product_id is not null or v_custom_product_id is null
           or v_custom_version_id is null then
          raise exception 'Custom item requires only custom_product_id and custom_product_version_id';
        end if;
        select * into v_custom_product from public.business_custom_products
        where id = v_custom_product_id;
        if not found then raise exception 'Custom product does not exist'; end if;
        select * into v_custom_version from public.business_custom_product_versions
        where id = v_custom_version_id and custom_product_id = v_custom_product.id;
        if not found then
          raise exception 'Custom product version does not belong to custom product';
        end if;
        if v_custom_product.is_archived then raise exception 'Custom product is archived'; end if;
        if v_custom_product.customer_id <> v_order.customer_id
           and not v_custom_product.is_shared then
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
        ) returning * into v_existing;
      else
        raise exception 'Invalid order item source_type';
      end if;

      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'kind', 'appended',
        'order_item_id', v_existing.id,
        'name_snapshot', v_existing.name_snapshot,
        'unit_snapshot', v_existing.unit_snapshot,
        'unit_price', v_existing.unit_price,
        'quantity_before', 0,
        'quantity_after', v_existing.quantity
      ));
      v_sort_order := v_sort_order + 1;
    end if;
  end loop;

  select coalesce(sum(i.line_amount), 0) into v_subtotal_after
  from public.business_order_items i where i.order_id = p_order_id;
  if round(v_subtotal_after, 2) = round(v_subtotal_before, 2) then
    raise exception 'Adjustment does not change the order amount';
  end if;

  update public.business_orders bo set
    items_subtotal = v_subtotal_after,
    total_amount = v_subtotal_after + bo.shipping_fee,
    version = bo.version + 1
  where bo.id = p_order_id;

  -- 上调数量后订单可能从 fully_shipped 退回 partially_shipped；该函数每次从零重算。
  perform public.business_refresh_order_fulfillment_status(p_order_id);
  select * into v_order from public.business_orders where id = p_order_id;

  v_revision := public.business_write_order_amount_revision(
    p_order_id,
    p_reason_type,
    v_subtotal_before, v_order.items_subtotal,
    v_total_before, v_order.total_amount,
    jsonb_build_object('lines', v_changes),
    p_reason,
    v_uid
  );

  v_new := jsonb_build_object(
    'order', to_jsonb(v_order),
    'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order, i.id)
                       from public.business_order_items i
                       where i.order_id = v_order.id), '[]'::jsonb)
  );
  perform public.write_business_order_audit(
    v_order.id, 'order', v_order.id, 'update', v_order.status, v_order.status,
    v_old, v_new, p_reason, v_uid
  );

  v_result := jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'version', v_order.version,
    'items_subtotal', v_order.items_subtotal,
    'total_amount', v_order.total_amount,
    'fulfillment_status', v_order.fulfillment_status,
    'revision', to_jsonb(v_revision)
  );
  insert into public.business_rpc_idempotency (
    actor_id, operation, idempotency_key, payload_hash, result
  ) values (
    v_uid, 'adjust_business_order_items', btrim(p_idempotency_key), v_hash, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.adjust_business_order_items(uuid, int, jsonb, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.adjust_business_order_items(uuid, int, jsonb, text, text, text)
  to authenticated;

-- -----------------------------------------------------------------------------
-- 4. 发货：允许一步确认超发，同事务上调下单量
-- -----------------------------------------------------------------------------
-- 新增 8 参重载；旧 6 参入口保留为不允许超发的包装器，老调用方无需同步发版。
-- 两者共用 operation = 'create_business_order_shipment' 的幂等键空间，
-- 且未启用超发时的 payload 哈希与 0030 完全一致，避免上线后旧幂等键被判为「同键不同载荷」。
create or replace function public.create_business_order_shipment(
  p_order_id uuid,
  p_shipped_at timestamptz,
  p_tracking_number text,
  p_notes text,
  p_items jsonb,
  p_idempotency_key text,
  p_allow_overship boolean,
  p_overship_reason text
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
  v_quantity_before numeric;
  v_net_shipped numeric;
  v_allow_overship boolean := coalesce(p_allow_overship, false);
  v_overship jsonb := '[]'::jsonb;
  v_subtotal_before numeric(18,2);
  v_total_before numeric(18,2);
  v_subtotal_after numeric(18,2);
  v_revision public.business_order_amount_revisions%rowtype;
  v_payload jsonb;
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
  if char_length(coalesce(p_overship_reason, '')) > 1000 then
    raise exception 'Over-shipment reason cannot exceed 1000 characters';
  end if;
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

  v_payload := jsonb_build_object(
    'order_id', p_order_id, 'shipped_at', p_shipped_at,
    'tracking_number', nullif(btrim(p_tracking_number), ''),
    'notes', nullif(btrim(p_notes), ''), 'items', p_items
  );
  if v_allow_overship then
    v_payload := v_payload || jsonb_build_object(
      'allow_overship', true,
      'overship_reason', nullif(btrim(p_overship_reason), '')
    );
  end if;
  v_hash := encode(digest(v_payload::text, 'sha256'), 'hex');
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

  v_subtotal_before := v_order.items_subtotal;
  v_total_before := v_order.total_amount;

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
      if not v_allow_overship then
        raise exception 'Shipment quantity exceeds remaining net order item quantity';
      end if;
      -- 超发：同事务把下单量提到实发量，应收随之上调，并在台账留一行。
      v_quantity_before := v_order_item.quantity;
      update public.business_order_items set quantity = v_net_shipped + v_quantity
      where id = v_order_item.id
      returning * into v_order_item;
      v_overship := v_overship || jsonb_build_array(jsonb_build_object(
        'kind', 'over_shipped',
        'order_item_id', v_order_item.id,
        'name_snapshot', v_order_item.name_snapshot,
        'unit_snapshot', v_order_item.unit_snapshot,
        'unit_price', v_order_item.unit_price,
        'quantity_before', v_quantity_before,
        'quantity_after', v_order_item.quantity,
        'shipped_quantity', v_quantity
      ));
    end if;
    insert into public.business_order_shipment_items (shipment_id, order_item_id, quantity)
    values (v_shipment.id, v_order_item.id, v_quantity)
    returning * into v_shipment_item;
    v_created := v_created || jsonb_build_array(to_jsonb(v_shipment_item));
  end loop;

  if jsonb_array_length(v_overship) > 0 then
    select coalesce(sum(i.line_amount), 0) into v_subtotal_after
    from public.business_order_items i where i.order_id = p_order_id;
    update public.business_orders bo set
      items_subtotal = v_subtotal_after,
      total_amount = v_subtotal_after + bo.shipping_fee
    where bo.id = p_order_id;
  end if;

  perform public.business_refresh_order_fulfillment_status(p_order_id);
  update public.business_orders set version = version + 1 where id = p_order_id;
  select * into v_order from public.business_orders where id = p_order_id;

  if jsonb_array_length(v_overship) > 0 then
    v_revision := public.business_write_order_amount_revision(
      p_order_id, 'over_shipment',
      v_subtotal_before, v_order.items_subtotal,
      v_total_before, v_order.total_amount,
      jsonb_build_object('lines', v_overship, 'shipment_id', v_shipment.id),
      p_overship_reason, v_uid
    );
  end if;

  v_result := jsonb_build_object(
    'shipment', to_jsonb(v_shipment),
    'items', v_created,
    'items_subtotal', v_order.items_subtotal,
    'total_amount', v_order.total_amount,
    'version', v_order.version,
    'revision', case when v_revision.id is null then null else to_jsonb(v_revision) end
  );
  perform public.write_business_lifecycle_audit(
    p_order_id, v_order.customer_id, 'shipment', v_shipment.id,
    'create', null, v_result, nullif(btrim(p_overship_reason), ''), v_uid
  );
  insert into public.business_rpc_idempotency (
    actor_id, operation, idempotency_key, payload_hash, result
  ) values (v_uid, 'create_business_order_shipment', btrim(p_idempotency_key), v_hash, v_result);
  return v_result;
end;
$$;
revoke all on function public.create_business_order_shipment(
  uuid, timestamptz, text, text, jsonb, text, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_business_order_shipment(
  uuid, timestamptz, text, text, jsonb, text, boolean, text
) to authenticated;

-- 旧签名保持「超发不可用」的语义；不设默认值，避免 6 参调用产生重载歧义。
create or replace function public.create_business_order_shipment(
  p_order_id uuid,
  p_shipped_at timestamptz,
  p_tracking_number text,
  p_notes text,
  p_items jsonb,
  p_idempotency_key text
)
returns jsonb
language sql
security definer
set search_path = public, extensions
as $$
  select public.create_business_order_shipment(
    p_order_id, p_shipped_at, p_tracking_number, p_notes,
    p_items, p_idempotency_key, false, null::text
  );
$$;
revoke all on function public.create_business_order_shipment(
  uuid, timestamptz, text, text, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_business_order_shipment(
  uuid, timestamptz, text, text, jsonb, text
) to authenticated;

-- -----------------------------------------------------------------------------
-- 5. 前端约束视图：补可用余额与追加明细能力
-- -----------------------------------------------------------------------------
-- 可用余额 = 有效已收 − 已发货货值。客户口中的「定金还剩多少」就是这个数，
-- 它只在 50% 定金惯例下才恰好等于未收尾款，因此单独给出而不复用应收/已收字段。
-- 「已收」这里取本模块的口径：有效转账分配额（与 get_business_order_settlement_summary 一致）。
-- 每日台账另有一套实收字段（total_sales_amount），由不同录入路径写入，两者不可相加，
-- 因此原样以 daily_received_amount 一并返回，由前端决定展示哪一个。
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
  v_shipped_value numeric;
  v_can_adjust boolean;
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

  select coalesce(sum(round(public.business_order_item_net_shipped(i.id) * i.unit_price, 2)), 0)
    into v_shipped_value
  from public.business_order_items i
  where i.order_id = p_order_id;

  v_can_adjust := v_order.status::text = 'approved'
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
    'can_delete', v_order.status::text <> 'completed' and v_order.closed_at is null
                  and v_allocated = 0 and coalesce(q.gross_shipped, 0) = 0,
    'can_replace_product', v_order.status::text <> 'completed' and v_order.closed_at is null
                          and v_allocated = 0 and coalesce(q.gross_shipped, 0) = 0,
    'can_change_unit_price', v_order.status::text <> 'completed'
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
    'has_active_allocation', v_allocated > 0,
    'active_allocated_amount', v_allocated,
    'daily_received_amount', v_order.total_sales_amount,
    'items_subtotal', v_order.items_subtotal,
    'shipping_fee', v_order.shipping_fee,
    'total_amount', v_order.total_amount,
    'shipped_value', v_shipped_value,
    'available_balance', round(v_allocated - v_shipped_value, 2),
    'can_edit_order', v_order.status::text in ('draft', 'rejected') and v_order.closed_at is null,
    'can_adjust_items', v_can_adjust,
    'can_overship', v_can_adjust,
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

-- -----------------------------------------------------------------------------
-- 6. 让台账行成为 0035 差额约束认可的解释
-- -----------------------------------------------------------------------------
-- 0035 要求应收与实收不等时必须有 receivable_received_difference_reason，而该字段在有
-- 收付款或发货之后被 protect_business_order_daily_fields 冻结。加单与超发正好发生在冻结之后，
-- 于是「必须解释」和「不许改解释」互相锁死。这里放宽为：本订单存在应收变更台账行时，
-- 差额已由台账解释（台账行带前后金额、变更明细、操作人与时间；reason 是可选补充）。
-- 其余行为与 0035 完全一致：长度上限、行已被删除时提前返回、约束触发器返回 null。
create or replace function public.validate_business_order_receivable_received_gap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total_amount numeric;
  v_total_sales_amount numeric;
  v_reason text;
begin
  select bo.total_amount, bo.total_sales_amount, bo.receivable_received_difference_reason
    into v_total_amount, v_total_sales_amount, v_reason
  from public.business_orders bo
  where bo.id = new.id;

  -- The row may have been removed later in the same transaction.
  if not found then return null; end if;

  if char_length(coalesce(v_reason, '')) > 1000 then
    raise exception 'Receivable and received amount difference reason cannot exceed 1000 characters';
  end if;

  if v_total_sales_amount is not null
     and round(v_total_amount, 2) <> round(v_total_sales_amount, 2)
     and nullif(regexp_replace(coalesce(v_reason, ''), '[[:space:]]', '', 'g'), '') is null
     and not exists (
       select 1 from public.business_order_amount_revisions r where r.order_id = new.id
     ) then
    raise exception 'Receivable and received amount difference reason is required';
  end if;

  return null;
end;
$$;
revoke all on function public.validate_business_order_receivable_received_gap()
  from public, anon, authenticated, service_role;

commit;
