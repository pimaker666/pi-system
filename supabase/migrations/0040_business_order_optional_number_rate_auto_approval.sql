-- 0040 订单号与汇率非必填、管理员/财务建单免审核、收款口径合并订单实收
--
-- 业务背景：
--   1. 每日订单常常先落单后才拿到平台订单号；人民币订单也不该被迫填 1 以外的汇率占位值。
--      订单号与汇率一并放宽为非必填，留空落 NULL：汇率为 NULL 时 total_cny 自然为 NULL，
--      财务总览与业绩里该单不参与人民币折算，而不是被假汇率污染。
--   2. 管理员与财务自己录的单不再走审核：创建即 approved，并写一条 approve 审计说明来源。
--   3. 免审核带来的副作用是「订单一创建就不是 draft」，原先只允许 draft/rejected 的编辑、
--      截图绑定与截图上传都会被锁死。因此对管理员/财务放宽到 approved 且尚未收款、未发货，
--      收款与发货之后仍由 protect_business_order_daily_fields 与
--      protect_business_order_item_invariants 保护，不存在绕过资金/发货保护的路径。
--   4. 收款口径统一为「建单填写的实收总额 + 后续转账分配额」。payment_status 与完成门禁
--      同口径判断，避免卡片显示已收满而订单无法完成。

begin;

-- -----------------------------------------------------------------------------
-- 1. 订单号非必填：放宽 0034 的每日字段完整性约束
--    「未录入每日字段」分支保持要求订单号为空，只有「已录入」分支不再强制订单号。
-- -----------------------------------------------------------------------------
alter table public.business_orders
  drop constraint if exists business_orders_daily_fields_complete_check;

alter table public.business_orders
  add constraint business_orders_daily_fields_complete_check check (
    (
      shop_id is null
      and shop_name_snapshot is null
      and shop_group_id is null
      and shop_group_name_snapshot is null
      and external_order_number is null
      and daily_shipping_date is null
      and daily_shipping_number is null
      and daily_payment_category is null
      and total_product_received_amount is null
      and total_shipping_received_amount is null
      and total_sales_amount is null
      and not total_product_received_overridden
      and not total_shipping_received_overridden
      and not total_sales_overridden
    )
    or (
      shop_id is not null
      and shop_name_snapshot is not null
      and daily_shipping_date is not null
      and daily_payment_category is not null
      and total_product_received_amount is not null
      and total_shipping_received_amount is not null
      and total_sales_amount is not null
    )
  );

comment on column public.business_orders.external_order_number is
  '外部平台订单号，非必填；留空落 NULL';

-- -----------------------------------------------------------------------------
-- 2. 汇率非必填：仅去掉 NOT NULL
--    区间 CHECK 与 business_orders_cny_rate 对 NULL 均判定为 NULL（不为 false），无需重建。
--    total_cny 是 round(total_amount * exchange_rate_to_cny, 2) 的存储生成列，汇率为空即为空。
-- -----------------------------------------------------------------------------
alter table public.business_orders
  alter column exchange_rate_to_cny drop not null;

comment on column public.business_orders.exchange_rate_to_cny is
  '兑人民币汇率，非必填；为空时 total_cny 为空，该单不参与人民币折算';

-- -----------------------------------------------------------------------------
-- 2b. 录入期编辑门禁：免审核建单让订单一创建就是 approved，
--     管理员与财务在未收款、未发货且未关闭前仍需能修正自己刚录的单。
--     订单截图策略以调用者身份求值，故需 security definer 并授予 authenticated。
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
  select bo.closed_at is null and (
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

-- -----------------------------------------------------------------------------
-- 3. 建单/改单 RPC：汇率守卫允许 NULL；改单对管理员与财务放宽到已审核且未收款未发货
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
  v_customer_snapshot jsonb := '{}'::jsonb;
  v_order public.business_orders%rowtype;
  v_subtotal numeric(18,2);
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Only approved sales, supervisor, admin, or finance users can create business orders';
  end if;
  if p_customer_id is null and v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Business order customer is required';
  end if;
  if p_order_date is null then raise exception 'Order date is required'; end if;
  if p_exchange_rate_to_cny is not null
     and (p_exchange_rate_to_cny <= 0 or p_exchange_rate_to_cny > 1000000) then
    raise exception 'Exchange rate is invalid';
  end if;
  if p_currency::text = 'CNY' and p_exchange_rate_to_cny is not null
     and p_exchange_rate_to_cny <> 1 then
    raise exception 'CNY exchange rate must equal one';
  end if;
  if p_shipping_fee is null or p_shipping_fee < 0 or p_shipping_fee > 999999999999 then
    raise exception 'Shipping fee is invalid';
  end if;
  if char_length(coalesce(p_tracking_number, '')) > 200
     or char_length(coalesce(p_sales_notes, '')) > 2000 then
    raise exception 'Business order text exceeds maximum length';
  end if;

  if p_customer_id is not null then
    select * into v_customer from public.customers c where c.id = p_customer_id;
    if not found or (
      v_actor.role::text in ('sales', 'supervisor') and v_customer.created_by is distinct from v_uid
    ) then
      raise exception 'Customer does not exist or is not manageable by current user';
    end if;
    v_customer_snapshot := jsonb_build_object(
      'name', v_customer.name, 'company', v_customer.company,
      'email', v_customer.email, 'phone', v_customer.phone,
      'address', v_customer.address, 'city', v_customer.city,
      'state', v_customer.state, 'postal_code', v_customer.postal_code,
      'country', v_customer.country, 'contact_person', v_customer.contact_person
    );
  end if;

  insert into public.business_orders (
    order_number, customer_id, customer_snapshot, salesperson_id,
    salesperson_name_snapshot, order_date, fulfillment_type, currency,
    exchange_rate_to_cny, items_subtotal, shipping_fee, total_amount,
    tracking_number, sales_notes
  ) values (
    public.next_business_order_number(), p_customer_id, v_customer_snapshot,
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
  v_customer_snapshot jsonb := '{}'::jsonb;
  v_old jsonb;
  v_subtotal numeric(18,2);
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved sales, supervisor, admin, or finance account required';
  end if;
  select * into v_order from public.business_orders bo where bo.id = p_order_id for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if v_order.version <> p_expected_version then raise exception 'Business order version conflict'; end if;
  if v_order.status::text = 'completed' or v_order.closed_at is not null then
    raise exception 'Completed or closed business order cannot be edited';
  end if;
  if v_order.status::text not in ('draft', 'rejected') then
    -- 免审核建单让订单一创建就是 approved，管理员与财务仍需能修正自己刚录的单。
    if v_actor.role::text not in ('admin', 'finance')
       or v_order.status::text <> 'approved'
       or exists (
         select 1
         from public.business_order_payment_allocations a
         join public.business_customer_transfers t on t.id = a.transfer_id
         where a.order_id = v_order.id and a.voided_at is null and t.voided_at is null
       )
       or exists (
         select 1 from public.business_order_shipments s
         where s.order_id = v_order.id and s.voided_at is null
       ) then
      raise exception 'Business order cannot be edited in current status';
    end if;
  end if;
  if v_actor.role::text in ('sales', 'supervisor') and v_order.salesperson_id is distinct from v_uid then
    raise exception 'Sales user cannot edit another owner business order';
  end if;
  if p_customer_id is null and v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Business order customer is required';
  end if;
  if p_order_date is null then raise exception 'Order date is required'; end if;
  if p_exchange_rate_to_cny is not null
     and (p_exchange_rate_to_cny <= 0 or p_exchange_rate_to_cny > 1000000) then
    raise exception 'Exchange rate is invalid';
  end if;
  if p_currency::text = 'CNY' and p_exchange_rate_to_cny is not null
     and p_exchange_rate_to_cny <> 1 then
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

  if p_customer_id is not null then
    select * into v_customer from public.customers c where c.id = p_customer_id;
    if not found or (
      v_actor.role::text in ('sales', 'supervisor') and v_customer.created_by is distinct from v_uid
    ) then
      raise exception 'Customer does not exist or is not manageable by current user';
    end if;
    v_customer_snapshot := jsonb_build_object(
      'name', v_customer.name, 'company', v_customer.company,
      'email', v_customer.email, 'phone', v_customer.phone,
      'address', v_customer.address, 'city', v_customer.city,
      'state', v_customer.state, 'postal_code', v_customer.postal_code,
      'country', v_customer.country, 'contact_person', v_customer.contact_person
    );
  end if;

  v_old := jsonb_build_object(
    'order', to_jsonb(v_order),
    'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order)
                       from public.business_order_items i
                       where i.order_id = v_order.id), '[]'::jsonb)
  );

  update public.business_orders bo set
    customer_id = p_customer_id,
    customer_snapshot = v_customer_snapshot
  where bo.id = v_order.id;

  v_subtotal := public.replace_business_order_items(v_order.id, p_items);

  update public.business_orders bo set
    customer_id = p_customer_id,
    customer_snapshot = v_customer_snapshot,
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

-- -----------------------------------------------------------------------------
-- 4. 每日字段应用器：订单号可空，并在写完实收总额后刷新收款状态
--    其余守卫（角色、业务员归属、店铺、总额精度、明细条数、逐行覆盖推导）与 0038 完全一致。
-- -----------------------------------------------------------------------------
create or replace function public.apply_business_order_daily_entry(
  p_order_id uuid,
  p_shop_id uuid,
  p_salesperson_id uuid,
  p_external_order_number text,
  p_daily_shipping_date date,
  p_daily_shipping_number text,
  p_daily_payment_category public.daily_order_payment_category,
  p_total_product_received_amount numeric,
  p_total_product_received_overridden boolean,
  p_total_shipping_received_amount numeric,
  p_total_shipping_received_overridden boolean,
  p_total_sales_amount numeric,
  p_total_sales_overridden boolean,
  p_items jsonb,
  p_actor_id uuid,
  p_is_create boolean,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_salesperson public.profiles%rowtype;
  v_shop public.finance_daily_order_shops%rowtype;
  v_shop_group_id uuid;
  v_shop_group_name text;
  v_order public.business_orders%rowtype;
  v_item jsonb;
  v_order_item public.business_order_items%rowtype;
  v_sort_order int := 0;
  v_product_amount numeric;
  v_logistics_amount numeric;
  v_sales_amount numeric;
  v_product_overridden boolean;
  v_sales_overridden boolean;
  v_product_sum numeric(18,2) := 0;
  v_shipping_sum numeric(18,2) := 0;
  v_sales_sum numeric(18,2) := 0;
  v_effective_product_total numeric(18,2);
  v_effective_shipping_total numeric(18,2);
  v_effective_sales_total numeric(18,2);
  v_old jsonb;
  v_new jsonb;
begin
  select * into v_actor from public.profiles p where p.id = p_actor_id;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved sales, supervisor, admin, or finance account required';
  end if;

  select * into v_order
  from public.business_orders bo
  where bo.id = p_order_id
  for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if v_order.status::text = 'completed' or v_order.closed_at is not null then
    raise exception 'Completed or closed business order cannot be edited';
  end if;

  select * into v_salesperson
  from public.profiles p
  where p.id = p_salesperson_id and p.status::text = 'approved';
  if not found then raise exception 'Assigned salesperson must be approved'; end if;
  if v_actor.role::text in ('admin', 'finance') then
    if v_salesperson.role::text not in ('sales', 'supervisor', 'admin') then
      raise exception 'Administrator or finance can assign only approved sales, supervisor, or admin users';
    end if;
  elsif p_salesperson_id is distinct from p_actor_id then
    raise exception 'Sales or supervisor users can assign orders only to themselves';
  end if;

  select * into v_shop
  from public.finance_daily_order_shops s
  where s.id = p_shop_id;
  if not found then raise exception 'Daily order shop does not exist'; end if;
  if not v_shop.is_active and (p_is_create or v_order.shop_id is distinct from p_shop_id) then
    raise exception 'Daily order shop is inactive';
  end if;
  if not exists (
    select 1
    from public.finance_daily_order_shop_salespeople a
    where a.shop_id = p_shop_id
      and a.salesperson_id = p_salesperson_id
      and a.is_active
  ) then
    raise exception 'Salesperson is not actively assigned to this shop';
  end if;

  if v_shop.group_id is not null then
    select g.id, nullif(btrim(g.name), '')
      into v_shop_group_id, v_shop_group_name
    from public.finance_daily_order_shop_groups g
    where g.id = v_shop.group_id;
    if not found then raise exception 'Daily order shop group does not exist'; end if;
  else
    v_shop_group_id := null;
    v_shop_group_name := null;
  end if;

  if char_length(coalesce(btrim(p_external_order_number), '')) > 200 then
    raise exception 'External order number cannot exceed 200 characters';
  end if;
  if p_daily_shipping_date is null then raise exception 'Daily shipping date is required'; end if;
  if p_daily_payment_category is null then raise exception 'Daily payment category is required'; end if;
  if char_length(coalesce(p_daily_shipping_number, '')) > 200 then
    raise exception 'Daily shipping number cannot exceed 200 characters';
  end if;
  if char_length(coalesce(p_reason, '')) > 1000 then
    raise exception 'Reason cannot exceed 1000 characters';
  end if;

  if p_total_product_received_amount is null
     or p_total_shipping_received_amount is null
     or p_total_sales_amount is null
     or p_total_product_received_overridden is null
     or p_total_shipping_received_overridden is null
     or p_total_sales_overridden is null then
    raise exception 'Daily order totals are incomplete';
  end if;
  if p_total_product_received_amount < 0
     or p_total_product_received_amount > 999999999999
     or p_total_product_received_amount <> round(p_total_product_received_amount, 2)
     or p_total_shipping_received_amount < 0
     or p_total_shipping_received_amount > 999999999999
     or p_total_shipping_received_amount <> round(p_total_shipping_received_amount, 2)
     or p_total_sales_amount < 0
     or p_total_sales_amount > 999999999999
     or p_total_sales_amount <> round(p_total_sales_amount, 2) then
    raise exception 'Daily order totals must be non-negative and within 2 decimal places';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 500 then
    raise exception 'Order items count must be between 1 and 500';
  end if;
  if jsonb_array_length(p_items) <> (
    select count(*) from public.business_order_items i where i.order_id = p_order_id
  ) then
    raise exception 'Daily order item count does not match business order items';
  end if;

  v_old := jsonb_build_object(
    'order', jsonb_build_object(
      'shop_id', v_order.shop_id,
      'shop_name_snapshot', v_order.shop_name_snapshot,
      'shop_group_id', v_order.shop_group_id,
      'shop_group_name_snapshot', v_order.shop_group_name_snapshot,
      'salesperson_id', v_order.salesperson_id,
      'salesperson_name_snapshot', v_order.salesperson_name_snapshot,
      'external_order_number', v_order.external_order_number,
      'daily_shipping_date', v_order.daily_shipping_date,
      'daily_shipping_number', v_order.daily_shipping_number,
      'daily_payment_category', v_order.daily_payment_category,
      'total_product_received_amount', v_order.total_product_received_amount,
      'total_product_received_overridden', v_order.total_product_received_overridden,
      'total_shipping_received_amount', v_order.total_shipping_received_amount,
      'total_shipping_received_overridden', v_order.total_shipping_received_overridden,
      'total_sales_amount', v_order.total_sales_amount,
      'total_sales_overridden', v_order.total_sales_overridden
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id,
        'daily_shipping_category', i.daily_shipping_category,
        'product_received_amount', i.product_received_amount,
        'product_received_overridden', i.product_received_overridden,
        'logistics_fee_amount', i.logistics_fee_amount,
        'sales_total_amount', i.sales_total_amount,
        'sales_total_overridden', i.sales_total_overridden
      ) order by i.sort_order)
      from public.business_order_items i where i.order_id = p_order_id
    ), '[]'::jsonb)
  );

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) <> 'object'
       or not (v_item ?& array[
         'daily_shipping_category',
         'product_received_amount',
         'product_received_overridden',
         'logistics_fee_amount',
         'sales_total_amount',
         'sales_total_overridden'
       ]) then
      raise exception 'Daily order item fields are incomplete';
    end if;
    if v_item->>'daily_shipping_category' not in ('stock', 'sample', 'custom', 'purchase') then
      raise exception 'Invalid daily shipping category';
    end if;
    if jsonb_typeof(v_item->'product_received_overridden') <> 'boolean'
       or jsonb_typeof(v_item->'sales_total_overridden') <> 'boolean' then
      raise exception 'Daily order item override flags are required';
    end if;

    begin
      v_product_amount := (v_item->>'product_received_amount')::numeric;
      v_logistics_amount := (v_item->>'logistics_fee_amount')::numeric;
      v_sales_amount := (v_item->>'sales_total_amount')::numeric;
      v_product_overridden := (v_item->>'product_received_overridden')::boolean;
      v_sales_overridden := (v_item->>'sales_total_overridden')::boolean;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Daily order item amounts are invalid';
    end;

    if v_product_amount is null or v_logistics_amount is null or v_sales_amount is null
       or v_product_amount < 0 or v_product_amount > 999999999999
       or v_product_amount <> round(v_product_amount, 2)
       or v_logistics_amount < 0 or v_logistics_amount > 999999999999
       or v_logistics_amount <> round(v_logistics_amount, 2)
       or v_sales_amount < 0 or v_sales_amount > 999999999999
       or v_sales_amount <> round(v_sales_amount, 2) then
      raise exception 'Daily order item amounts must be non-negative and within 2 decimal places';
    end if;

    select * into v_order_item
    from public.business_order_items i
    where i.order_id = p_order_id and i.sort_order = v_sort_order
    for update;
    if not found then raise exception 'Daily order item does not match business order item'; end if;

    if not v_product_overridden then
      v_product_amount := round(v_order_item.quantity * v_order_item.unit_price, 2);
    end if;
    if not v_sales_overridden then
      v_sales_amount := v_product_amount + v_logistics_amount;
    end if;

    update public.business_order_items i
    set daily_shipping_category = (v_item->>'daily_shipping_category')::public.daily_order_shipping_category,
        product_received_amount = v_product_amount,
        product_received_overridden = v_product_overridden,
        logistics_fee_amount = v_logistics_amount,
        sales_total_amount = v_sales_amount,
        sales_total_overridden = v_sales_overridden
    where i.id = v_order_item.id;

    v_product_sum := v_product_sum + v_product_amount;
    v_shipping_sum := v_shipping_sum + v_logistics_amount;
    v_sales_sum := v_sales_sum + v_sales_amount;
    v_sort_order := v_sort_order + 1;
  end loop;

  v_effective_product_total := case
    when p_total_product_received_overridden then p_total_product_received_amount
    else v_product_sum
  end;
  v_effective_shipping_total := case
    when p_total_shipping_received_overridden then p_total_shipping_received_amount
    else v_shipping_sum
  end;
  v_effective_sales_total := case
    when p_total_sales_overridden then p_total_sales_amount
    else v_sales_sum
  end;

  if v_effective_sales_total <> v_effective_product_total + v_effective_shipping_total then
    raise exception 'Total sales amount must equal product received plus shipping received';
  end if;

  update public.business_orders bo
  set shop_id = v_shop.id,
      shop_name_snapshot = btrim(v_shop.name),
      shop_group_id = v_shop_group_id,
      shop_group_name_snapshot = v_shop_group_name,
      salesperson_id = v_salesperson.id,
      salesperson_name_snapshot = coalesce(
        nullif(btrim(v_salesperson.chinese_name), ''),
        nullif(btrim(v_salesperson.full_name), ''),
        v_salesperson.email
      ),
      external_order_number = nullif(btrim(p_external_order_number), ''),
      daily_shipping_date = p_daily_shipping_date,
      daily_shipping_number = nullif(btrim(p_daily_shipping_number), ''),
      daily_payment_category = p_daily_payment_category,
      total_product_received_amount = v_effective_product_total,
      total_product_received_overridden = p_total_product_received_overridden,
      total_shipping_received_amount = v_effective_shipping_total,
      total_shipping_received_overridden = p_total_shipping_received_overridden,
      total_sales_amount = v_effective_sales_total,
      total_sales_overridden = p_total_sales_overridden
  where bo.id = p_order_id
  returning * into v_order;

  v_new := jsonb_build_object(
    'order', jsonb_build_object(
      'shop_id', v_order.shop_id,
      'shop_name_snapshot', v_order.shop_name_snapshot,
      'shop_group_id', v_order.shop_group_id,
      'shop_group_name_snapshot', v_order.shop_group_name_snapshot,
      'salesperson_id', v_order.salesperson_id,
      'salesperson_name_snapshot', v_order.salesperson_name_snapshot,
      'external_order_number', v_order.external_order_number,
      'daily_shipping_date', v_order.daily_shipping_date,
      'daily_shipping_number', v_order.daily_shipping_number,
      'daily_payment_category', v_order.daily_payment_category,
      'total_product_received_amount', v_order.total_product_received_amount,
      'total_product_received_overridden', v_order.total_product_received_overridden,
      'total_shipping_received_amount', v_order.total_shipping_received_amount,
      'total_shipping_received_overridden', v_order.total_shipping_received_overridden,
      'total_sales_amount', v_order.total_sales_amount,
      'total_sales_overridden', v_order.total_sales_overridden
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id,
        'daily_shipping_category', i.daily_shipping_category,
        'product_received_amount', i.product_received_amount,
        'product_received_overridden', i.product_received_overridden,
        'logistics_fee_amount', i.logistics_fee_amount,
        'sales_total_amount', i.sales_total_amount,
        'sales_total_overridden', i.sales_total_overridden
      ) order by i.sort_order)
      from public.business_order_items i where i.order_id = p_order_id
    ), '[]'::jsonb)
  );

  perform public.business_refresh_order_payment_status(p_order_id);

  if v_old is distinct from v_new then
    perform public.write_business_order_audit(
      v_order.id,
      'order',
      v_order.id,
      'update',
      v_order.status,
      v_order.status,
      v_old,
      v_new,
      p_reason,
      p_actor_id
    );
  end if;
end;
$$;
revoke all on function public.apply_business_order_daily_entry(
  uuid, uuid, uuid, text, date, text, public.daily_order_payment_category,
  numeric, boolean, numeric, boolean, numeric, boolean, jsonb, uuid, boolean, text
) from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. 管理员与财务建单免审核：v4 在建单成功后直接置为已审核，并写 approve 审计
-- -----------------------------------------------------------------------------
create or replace function public.create_business_order_v4(
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
  p_shop_id uuid,
  p_salesperson_id uuid,
  p_external_order_number text,
  p_daily_shipping_date date,
  p_daily_shipping_number text,
  p_daily_payment_category public.daily_order_payment_category,
  p_total_product_received_amount numeric,
  p_total_product_received_overridden boolean,
  p_total_shipping_received_amount numeric,
  p_total_shipping_received_overridden boolean,
  p_total_sales_amount numeric,
  p_total_sales_overridden boolean,
  p_receivable_received_difference_reason text
)
returns table (id uuid, order_number text, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_created record;
  v_order public.business_orders%rowtype;
  v_before jsonb;
  v_reason text := nullif(regexp_replace(
    coalesce(p_receivable_received_difference_reason, ''),
    '^[[:space:]]+|[[:space:]]+$',
    '',
    'g'
  ), '');
begin
  if char_length(coalesce(p_receivable_received_difference_reason, '')) > 1000 then
    raise exception 'Receivable and received amount difference reason cannot exceed 1000 characters';
  end if;

  select * into v_actor from public.profiles p where p.id = v_uid;

  select * into v_created
  from public.create_business_order_v3(
    p_customer_id, p_order_date, p_fulfillment_type, p_currency,
    p_exchange_rate_to_cny, p_shipping_fee, p_tracking_number, p_sales_notes,
    p_items, p_payment_due_date, p_shop_id, p_salesperson_id,
    p_external_order_number, p_daily_shipping_date, p_daily_shipping_number,
    p_daily_payment_category, p_total_product_received_amount,
    p_total_product_received_overridden, p_total_shipping_received_amount,
    p_total_shipping_received_overridden, p_total_sales_amount,
    p_total_sales_overridden
  );

  select * into v_order
  from public.business_orders bo
  where bo.id = v_created.id
  for update;

  if round(v_order.total_amount, 2) = round(v_order.total_sales_amount, 2) then
    v_reason := null;
  end if;

  update public.business_orders bo
  set receivable_received_difference_reason = v_reason
  where bo.id = v_order.id
  returning * into v_order;

  if v_reason is not null then
    perform public.write_business_order_audit(
      v_order.id, 'order', v_order.id, 'update', v_order.status, v_order.status,
      jsonb_build_object('receivable_received_difference_reason', null),
      jsonb_build_object(
        'total_amount', v_order.total_amount,
        'total_sales_amount', v_order.total_sales_amount,
        'receivable_received_difference_reason', v_reason
      ),
      v_reason,
      v_uid
    );
  end if;

  if v_actor.role::text in ('admin', 'finance') then
    v_before := to_jsonb(v_order);
    update public.business_orders bo
    set status = 'approved',
        approval_status = 'approved',
        submitted_by = v_uid,
        submitted_at = now(),
        reviewed_by = v_uid,
        reviewed_at = now(),
        version = bo.version + 1
    where bo.id = v_order.id
    returning * into v_order;

    perform public.write_business_order_audit(
      v_order.id, 'order', v_order.id, 'approve',
      (v_before->>'status')::public.business_order_status, v_order.status,
      v_before, to_jsonb(v_order), '管理员或财务建单免审核', v_uid
    );
  end if;

  return query select v_order.id, v_order.order_number, v_order.version;
end;
$$;
revoke all on function public.create_business_order_v4(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb, date, uuid, uuid, text, date, text,
  public.daily_order_payment_category, numeric, boolean, numeric, boolean,
  numeric, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_business_order_v4(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb, date, uuid, uuid, text, date, text,
  public.daily_order_payment_category, numeric, boolean, numeric, boolean,
  numeric, boolean, text
) to authenticated;

-- -----------------------------------------------------------------------------
-- 6. 免审核后仍可维护订单截图：管理员与财务在已审核、未收款未发货前可增删
-- -----------------------------------------------------------------------------
create or replace function public.bind_business_order_attachment(
  p_order_id uuid,
  p_object_path text,
  p_original_name text,
  p_mime_type text,
  p_size_bytes bigint
)
returns public.business_order_attachments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_object storage.objects%rowtype;
  v_result public.business_order_attachments%rowtype;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved sales, supervisor, admin, or finance account required';
  end if;

  select * into v_order
  from public.business_orders bo
  where bo.id = p_order_id
  for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if not public.business_order_accepts_entry_edits(v_order.id, v_actor.role::text) then
    raise exception 'Business order attachments cannot be changed in current status';
  end if;
  if v_actor.role::text in ('sales', 'supervisor')
     and v_order.salesperson_id is distinct from v_uid then
    raise exception 'Sales user cannot edit another owner business order';
  end if;

  if p_mime_type not in ('image/jpeg', 'image/png')
     or p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > 20971520 then
    raise exception 'Invalid attachment type or size';
  end if;
  if char_length(coalesce(p_original_name, '')) > 255 then
    raise exception 'Attachment name cannot exceed 255 characters';
  end if;
  if p_object_path !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$'
     or split_part(p_object_path, '/', 1) <> v_uid::text
     or split_part(p_object_path, '/', 2) <> p_order_id::text then
    raise exception 'Invalid attachment path';
  end if;

  select * into v_object
  from storage.objects o
  where o.bucket_id = 'finance-daily-order-screenshots'
    and o.name = p_object_path;
  if not found then raise exception 'Attachment object does not exist'; end if;
  if lower(coalesce(v_object.metadata->>'mimetype', '')) <> p_mime_type
     or coalesce(v_object.metadata->>'size', '') !~ '^\d+$'
     or (v_object.metadata->>'size')::bigint <> p_size_bytes then
    raise exception 'Attachment object metadata does not match';
  end if;

  select * into v_result
  from public.business_order_attachments a
  where a.object_path = p_object_path;
  if found then
    if v_result.order_id is distinct from p_order_id
       or v_result.created_by is distinct from v_uid
       or v_result.status::text <> 'active'
       or v_result.mime_type <> p_mime_type
       or v_result.size_bytes <> p_size_bytes then
      raise exception 'Attachment path is already bound';
    end if;
    return v_result;
  end if;

  if (
    select count(*)
    from public.business_order_attachments a
    where a.order_id = p_order_id and a.status::text = 'active'
  ) >= 10 then
    raise exception 'Business order cannot have more than 10 attachments';
  end if;

  insert into public.business_order_attachments (
    order_id, object_path, original_name, mime_type, size_bytes, created_by
  ) values (
    p_order_id, p_object_path, nullif(btrim(p_original_name), ''),
    p_mime_type, p_size_bytes, v_uid
  ) returning * into v_result;

  return v_result;
end;
$$;
revoke all on function public.bind_business_order_attachment(uuid, text, text, text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.bind_business_order_attachment(uuid, text, text, text, bigint)
  to authenticated;

create or replace function public.remove_business_order_attachment(p_attachment_id uuid)
returns public.business_order_attachments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_result public.business_order_attachments%rowtype;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved sales, supervisor, admin, or finance account required';
  end if;

  select * into v_result
  from public.business_order_attachments a
  where a.id = p_attachment_id
  for update;
  if not found then raise exception 'Business order attachment does not exist'; end if;
  if v_result.status::text = 'void' then raise exception 'Business order attachment is already removed'; end if;

  select * into v_order
  from public.business_orders bo
  where bo.id = v_result.order_id
  for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if not public.business_order_accepts_entry_edits(v_order.id, v_actor.role::text) then
    raise exception 'Business order attachments cannot be changed in current status';
  end if;
  if v_actor.role::text in ('sales', 'supervisor')
     and v_order.salesperson_id is distinct from v_uid then
    raise exception 'Sales user cannot edit another owner business order';
  end if;

  update public.business_order_attachments a
  set status = 'void', removed_at = now(), removed_by = v_uid
  where a.id = p_attachment_id
  returning * into v_result;
  return v_result;
end;
$$;
revoke all on function public.remove_business_order_attachment(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.remove_business_order_attachment(uuid)
  to authenticated;

drop policy if exists "finance_daily_order_screenshots_insert" on storage.objects;
create policy "finance_daily_order_screenshots_insert"
  on storage.objects for insert to authenticated
with check (
  public.is_approved_user()
  and bucket_id = 'finance-daily-order-screenshots'
  and case
    when array_length(storage.foldername(name), 1) = 2
      and (storage.foldername(name))[1] = (select auth.uid())::text
      and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$'
    then exists (
      select 1
      from public.business_orders bo
      join public.profiles actor on actor.id = (select auth.uid())
      where bo.id = ((storage.foldername(name))[2])::uuid
        and actor.status::text = 'approved'
        and actor.role::text in ('sales', 'supervisor', 'admin', 'finance')
        and public.business_order_accepts_entry_edits(bo.id, actor.role::text)
        and (actor.role::text in ('admin', 'finance') or bo.salesperson_id = actor.id)
    )
    else false
  end
);

-- -----------------------------------------------------------------------------
-- 7. 收款口径：建单填写的实收总额与后续转账分配额相加
-- -----------------------------------------------------------------------------
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
         coalesce(bo.total_sales_amount, 0)
           + coalesce(sum(a.amount) filter (
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
         coalesce(bo.total_sales_amount, 0) + coalesce(pay.amount, 0),
         greatest(
           bo.total_amount - coalesce(bo.total_sales_amount, 0) - coalesce(pay.amount, 0),
           0
         ),
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

-- 已有订单的 payment_status 是按旧口径存下来的，按新口径重算一次；
-- 完成与特殊关闭的订单不动，避免触发关闭后字段冻结。
do $$
declare
  v_id uuid;
begin
  for v_id in
    select bo.id
    from public.business_orders bo
    where bo.closed_at is null
      and bo.status::text <> 'completed'
      and coalesce(bo.total_sales_amount, 0) > 0
  loop
    perform public.business_refresh_order_payment_status(v_id);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. 前端约束视图：编辑按钮跟随同一条放宽规则
-- -----------------------------------------------------------------------------
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
    'can_edit_order', public.business_order_accepts_entry_edits(
      v_order.id, coalesce(v_actor.role::text, '')
    ),
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

commit;
