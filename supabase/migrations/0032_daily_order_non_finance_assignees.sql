-- 0032_daily_order_non_finance_assignees.sql
-- 每日订单店铺与业务交接可分配给所有已审核的非财务账号：
--   1) 店铺关联保存同时接受 sales、supervisor、admin。
--   2) 财务创建或更新每日订单时允许以上账号作为归属人。
--   3) supervisor 作为归属人时可认领、绑定客户、提交及发起改单。
--   4) 账号交接目标同步接受以上账号。
-- finance 仍仅承担财务管理职责，不可成为店铺分配、订单归属或业务交接对象。

-- 业务侧工作流操作统一允许所有 approved 非财务账号；保留 0031 的账号交接锁，
-- 防止账号在停用/交接等待期间继续完成写入。
create or replace function public.assert_daily_order_sales_actor()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare v_actor public.profiles%rowtype;
begin
  perform pg_advisory_xact_lock_shared(hashtext('account_handover')::bigint);
  perform pg_advisory_xact_lock(hashtext('finance_daily_order_totals')::bigint);
  select * into v_actor
  from public.profiles
  where id = (select auth.uid())
  for update;
  if not found or v_actor.status::text <> 'approved' or v_actor.role::text = 'finance' then
    raise exception 'Only approved non-finance users can perform this action';
  end if;
  return v_actor;
end;
$$;
revoke all on function public.assert_daily_order_sales_actor()
  from public, anon, authenticated, service_role;

-- 绑定客户等通用工作流操作允许所有当前已审核角色，补齐 supervisor。
create or replace function public.assert_daily_order_actor()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare v_actor public.profiles%rowtype;
begin
  perform pg_advisory_xact_lock_shared(hashtext('account_handover')::bigint);
  perform pg_advisory_xact_lock(hashtext('finance_daily_order_totals')::bigint);
  select * into v_actor
  from public.profiles
  where id = (select auth.uid())
  for update;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Only approved users can perform this action';
  end if;
  return v_actor;
end;
$$;
revoke all on function public.assert_daily_order_actor()
  from public, anon, authenticated, service_role;

-- 店铺保存的当前六参数入口。调用者仍必须通过财务/管理员断言，
-- 被分配账号则必须 approved 且不是 finance。
create or replace function public.save_finance_daily_order_shop(
  p_shop_id uuid, p_name text, p_group_id uuid, p_is_active boolean,
  p_salesperson_ids uuid[], p_default_currency public.currency_code
)
returns public.finance_daily_order_shops
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_shop public.finance_daily_order_shops%rowtype;
  v_sales_id uuid;
begin
  v_actor := public.assert_daily_order_finance_actor();
  if nullif(btrim(p_name), '') is null or char_length(btrim(p_name)) > 100 then
    raise exception 'Invalid shop name';
  end if;
  if p_default_currency is null or p_default_currency::text not in ('CNY', 'USD') then
    raise exception 'Invalid shop currency';
  end if;
  if p_group_id is not null and not exists (
    select 1 from public.finance_daily_order_shop_groups where id = p_group_id
  ) then
    raise exception 'Shop group does not exist';
  end if;
  if coalesce(array_length(p_salesperson_ids, 1), 0) > 200 then
    raise exception 'Too many salespeople';
  end if;
  foreach v_sales_id in array coalesce(p_salesperson_ids, array[]::uuid[]) loop
    if not exists (
      select 1
      from public.profiles
      where id = v_sales_id
        and status::text = 'approved'
        and role::text <> 'finance'
    ) then
      raise exception 'Assigned user does not exist, is not approved, or is a finance user';
    end if;
  end loop;

  if p_shop_id is null then
    insert into public.finance_daily_order_shops(
      name, group_id, is_active, default_currency, created_by
    ) values (
      btrim(p_name), p_group_id, p_is_active, p_default_currency, v_actor.id
    ) returning * into v_shop;
  else
    update public.finance_daily_order_shops
    set name = btrim(p_name),
        group_id = p_group_id,
        is_active = p_is_active,
        default_currency = p_default_currency
    where id = p_shop_id
    returning * into v_shop;
    if not found then raise exception 'Shop does not exist'; end if;
  end if;

  update public.finance_daily_order_shop_salespeople
  set is_active = false
  where shop_id = v_shop.id
    and salesperson_id <> all(coalesce(p_salesperson_ids, array[]::uuid[]));

  foreach v_sales_id in array coalesce(p_salesperson_ids, array[]::uuid[]) loop
    insert into public.finance_daily_order_shop_salespeople(
      shop_id, salesperson_id, is_active, created_by
    ) values (
      v_shop.id, v_sales_id, true, v_actor.id
    )
    on conflict (shop_id, salesperson_id) do update set is_active = true;
  end loop;

  return v_shop;
end;
$$;
revoke all on function public.save_finance_daily_order_shop(
  uuid, text, uuid, boolean, uuid[], public.currency_code
) from public, anon, authenticated, service_role;
grant execute on function public.save_finance_daily_order_shop(
  uuid, text, uuid, boolean, uuid[], public.currency_code
) to authenticated;

-- 保留旧五参数入口供滚动升级期间的旧容器使用，并复用同一套候选校验。
create or replace function public.save_finance_daily_order_shop(
  p_shop_id uuid, p_name text, p_group_id uuid, p_is_active boolean,
  p_salesperson_ids uuid[]
)
returns public.finance_daily_order_shops
language sql
security definer
set search_path = public
as $$
  select public.save_finance_daily_order_shop(
    p_shop_id,
    p_name,
    p_group_id,
    p_is_active,
    p_salesperson_ids,
    case
      when p_shop_id is null then 'CNY'::public.currency_code
      else coalesce(
        (select s.default_currency from public.finance_daily_order_shops s where s.id = p_shop_id),
        'CNY'::public.currency_code
      )
    end
  );
$$;
revoke all on function public.save_finance_daily_order_shop(
  uuid, text, uuid, boolean, uuid[]
) from public, anon, authenticated, service_role;
grant execute on function public.save_finance_daily_order_shop(
  uuid, text, uuid, boolean, uuid[]
) to authenticated;

-- bulk_create_finance_daily_orders 仍调用此单行入口，因此在这里统一放宽归属人校验。
create or replace function public.create_finance_daily_order(
  p_order_date date, p_shop_id uuid, p_salesperson_id uuid, p_order_number text,
  p_shipping_date date, p_shipping_number text, p_shipping_category public.daily_order_shipping_category,
  p_product_id uuid, p_quantity numeric,
  p_sales_unit_price_amount numeric, p_sales_unit_price_currency public.currency_code,
  p_product_received_amount numeric, p_product_received_currency public.currency_code,
  p_logistics_fee_amount numeric, p_logistics_fee_currency public.currency_code,
  p_sales_total_amount numeric, p_sales_total_currency public.currency_code,
  p_payment_category public.daily_order_payment_category, p_remarks text
)
returns table (id uuid, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_shop public.finance_daily_order_shops%rowtype;
  v_sales public.profiles%rowtype;
  v_product public.products%rowtype;
  v_order public.finance_daily_orders%rowtype;
  v_workflow_id uuid;
  v_sales_name text;
begin
  v_actor := public.assert_daily_order_finance_actor();
  if p_order_date is null or p_shipping_date is null then raise exception 'Order and shipping dates are required'; end if;
  if nullif(btrim(p_order_number), '') is null or char_length(btrim(p_order_number)) > 200 then raise exception 'Invalid order number'; end if;
  if char_length(coalesce(p_shipping_number, '')) > 200 then raise exception 'Shipping number is too long'; end if;
  if char_length(coalesce(p_remarks, '')) > 2000 then raise exception 'Remarks are too long'; end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 999999999999 then raise exception 'Quantity must be greater than zero'; end if;
  if p_quantity <> round(p_quantity, 4) then raise exception 'Quantity cannot exceed 4 decimal places'; end if;
  if p_sales_unit_price_amount is null or p_sales_unit_price_amount < 0 or p_sales_unit_price_amount > 999999999999
     or p_product_received_amount is null or p_product_received_amount < 0 or p_product_received_amount > 999999999999
     or p_logistics_fee_amount is null or p_logistics_fee_amount < 0 or p_logistics_fee_amount > 999999999999
     or p_sales_total_amount is null or p_sales_total_amount < 0 or p_sales_total_amount > 999999999999
  then raise exception 'Amounts must be non-negative and within range'; end if;
  if p_sales_unit_price_amount <> round(p_sales_unit_price_amount, 2)
     or p_product_received_amount <> round(p_product_received_amount, 2)
     or p_logistics_fee_amount <> round(p_logistics_fee_amount, 2)
     or p_sales_total_amount <> round(p_sales_total_amount, 2)
  then raise exception 'Amounts cannot exceed 2 decimal places'; end if;

  select * into v_shop
  from public.finance_daily_order_shops as shops
  where shops.id = p_shop_id and shops.is_active = true;
  if not found then raise exception 'Shop does not exist or is inactive'; end if;

  select * into v_sales
  from public.profiles as salespeople
  where salespeople.id = p_salesperson_id
    and salespeople.status::text = 'approved'
    and salespeople.role::text <> 'finance';
  if not found then raise exception 'Assigned user does not exist, is not approved, or is a finance user'; end if;

  if not exists (
    select 1 from public.finance_daily_order_shop_salespeople as assignments
    where assignments.shop_id = p_shop_id
      and assignments.salesperson_id = p_salesperson_id
      and assignments.is_active = true
  ) then raise exception 'Assigned user is not assigned to shop'; end if;

  select * into v_product
  from public.products as products
  where products.id = p_product_id and products.is_active = true;
  if not found then raise exception 'Product does not exist or is inactive'; end if;

  v_sales_name := coalesce(nullif(btrim(v_sales.full_name), ''), v_sales.email);
  v_workflow_id := public.resolve_daily_order_workflow(v_sales.id, v_sales_name, p_order_number, v_actor.id);

  insert into public.finance_daily_orders (
    order_date, shop_id, shop_name_snapshot, salesperson_id, salesperson_name_snapshot,
    order_number, shipping_date, shipping_number, shipping_category,
    product_id, product_name_snapshot, product_sku_snapshot, quantity,
    sales_unit_price_amount, sales_unit_price_currency,
    product_received_amount, product_received_currency,
    logistics_fee_amount, logistics_fee_currency,
    sales_total_amount, sales_total_currency, payment_category, remarks, workflow_id, created_by, updated_by
  ) values (
    p_order_date, v_shop.id, v_shop.name, v_sales.id, v_sales_name,
    btrim(p_order_number), p_shipping_date, nullif(btrim(p_shipping_number), ''), p_shipping_category,
    v_product.id, v_product.name, v_product.sku, p_quantity,
    p_sales_unit_price_amount, p_sales_unit_price_currency,
    p_product_received_amount, p_product_received_currency,
    p_logistics_fee_amount, p_logistics_fee_currency,
    p_sales_total_amount, p_sales_total_currency, p_payment_category, nullif(btrim(p_remarks), ''),
    v_workflow_id, v_actor.id, v_actor.id
  ) returning * into v_order;

  return query select v_order.id, v_order.version;
end;
$$;
revoke all on function public.create_finance_daily_order(
  date, uuid, uuid, text, date, text, public.daily_order_shipping_category,
  uuid, numeric, numeric, public.currency_code, numeric, public.currency_code,
  numeric, public.currency_code, numeric, public.currency_code,
  public.daily_order_payment_category, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_finance_daily_order(
  date, uuid, uuid, text, date, text, public.daily_order_shipping_category,
  uuid, numeric, numeric, public.currency_code, numeric, public.currency_code,
  numeric, public.currency_code, numeric, public.currency_code,
  public.daily_order_payment_category, text
) to authenticated;

-- 0031 的受审计公开 update RPC 调用该内部实现；仅替换内部归属人校验，
-- 保留公开包装器对无 workflow 历史、submitted 和 approved 状态的保护。
create or replace function public.update_finance_daily_order_unchecked_0031(
  p_order_id uuid, p_expected_version int,
  p_order_date date, p_shop_id uuid, p_salesperson_id uuid, p_order_number text,
  p_shipping_date date, p_shipping_number text, p_shipping_category public.daily_order_shipping_category,
  p_product_id uuid, p_quantity numeric,
  p_sales_unit_price_amount numeric, p_sales_unit_price_currency public.currency_code,
  p_product_received_amount numeric, p_product_received_currency public.currency_code,
  p_logistics_fee_amount numeric, p_logistics_fee_currency public.currency_code,
  p_sales_total_amount numeric, p_sales_total_currency public.currency_code,
  p_payment_category public.daily_order_payment_category, p_remarks text
)
returns table (id uuid, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_existing public.finance_daily_orders%rowtype;
  v_shop public.finance_daily_order_shops%rowtype;
  v_sales public.profiles%rowtype;
  v_product public.products%rowtype;
  v_workflow_id uuid;
  v_sales_name text;
begin
  v_actor := public.assert_daily_order_finance_actor();
  select * into v_existing
  from public.finance_daily_orders
  where finance_daily_orders.id = p_order_id
  for update;
  if not found then raise exception 'Daily order does not exist'; end if;
  if v_existing.status <> 'active' then raise exception 'Voided daily order cannot be edited'; end if;
  if v_existing.version <> p_expected_version then raise exception 'Daily order version conflict'; end if;
  if p_order_date is null or p_shipping_date is null then raise exception 'Order and shipping dates are required'; end if;
  if nullif(btrim(p_order_number), '') is null or char_length(btrim(p_order_number)) > 200 then raise exception 'Invalid order number'; end if;
  if char_length(coalesce(p_shipping_number, '')) > 200 or char_length(coalesce(p_remarks, '')) > 2000 then raise exception 'Text field is too long'; end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 999999999999 then raise exception 'Quantity must be greater than zero'; end if;
  if p_quantity <> round(p_quantity, 4) then raise exception 'Quantity cannot exceed 4 decimal places'; end if;
  if p_sales_unit_price_amount is null or p_sales_unit_price_amount < 0 or p_sales_unit_price_amount > 999999999999
     or p_product_received_amount is null or p_product_received_amount < 0 or p_product_received_amount > 999999999999
     or p_logistics_fee_amount is null or p_logistics_fee_amount < 0 or p_logistics_fee_amount > 999999999999
     or p_sales_total_amount is null or p_sales_total_amount < 0 or p_sales_total_amount > 999999999999
  then raise exception 'Amounts must be non-negative and within range'; end if;
  if p_sales_unit_price_amount <> round(p_sales_unit_price_amount, 2)
     or p_product_received_amount <> round(p_product_received_amount, 2)
     or p_logistics_fee_amount <> round(p_logistics_fee_amount, 2)
     or p_sales_total_amount <> round(p_sales_total_amount, 2)
  then raise exception 'Amounts cannot exceed 2 decimal places'; end if;

  select * into v_shop
  from public.finance_daily_order_shops as shops
  where shops.id = p_shop_id and shops.is_active = true;
  if not found then raise exception 'Shop does not exist or is inactive'; end if;

  select * into v_sales
  from public.profiles as salespeople
  where salespeople.id = p_salesperson_id
    and salespeople.status::text = 'approved'
    and salespeople.role::text <> 'finance';
  if not found then raise exception 'Assigned user does not exist, is not approved, or is a finance user'; end if;

  if not exists (
    select 1 from public.finance_daily_order_shop_salespeople as assignments
    where assignments.shop_id = p_shop_id
      and assignments.salesperson_id = p_salesperson_id
      and assignments.is_active = true
  ) then raise exception 'Assigned user is not assigned to shop'; end if;

  select * into v_product
  from public.products as products
  where products.id = p_product_id and products.is_active = true;
  if not found then raise exception 'Product does not exist or is inactive'; end if;

  v_sales_name := coalesce(nullif(btrim(v_sales.full_name), ''), v_sales.email);
  v_workflow_id := public.resolve_daily_order_workflow(v_sales.id, v_sales_name, p_order_number, v_actor.id);

  update public.finance_daily_orders as target set
    order_date = p_order_date,
    shop_id = v_shop.id,
    shop_name_snapshot = v_shop.name,
    salesperson_id = v_sales.id,
    salesperson_name_snapshot = v_sales_name,
    order_number = btrim(p_order_number),
    shipping_date = p_shipping_date,
    shipping_number = nullif(btrim(p_shipping_number), ''),
    shipping_category = p_shipping_category,
    product_id = v_product.id,
    product_name_snapshot = v_product.name,
    product_sku_snapshot = v_product.sku,
    quantity = p_quantity,
    sales_unit_price_amount = p_sales_unit_price_amount,
    sales_unit_price_currency = p_sales_unit_price_currency,
    product_received_amount = p_product_received_amount,
    product_received_currency = p_product_received_currency,
    logistics_fee_amount = p_logistics_fee_amount,
    logistics_fee_currency = p_logistics_fee_currency,
    sales_total_amount = p_sales_total_amount,
    sales_total_currency = p_sales_total_currency,
    payment_category = p_payment_category,
    remarks = nullif(btrim(p_remarks), ''),
    workflow_id = v_workflow_id,
    version = target.version + 1,
    updated_by = v_actor.id
  where target.id = p_order_id
  returning target.id, target.version into id, version;
  return next;
end;
$$;
revoke all on function public.update_finance_daily_order_unchecked_0031(
  uuid, int, date, uuid, uuid, text, date, text, public.daily_order_shipping_category,
  uuid, numeric, numeric, public.currency_code, numeric, public.currency_code,
  numeric, public.currency_code, numeric, public.currency_code,
  public.daily_order_payment_category, text
) from public, anon, authenticated, service_role;

-- 账号交接目标与店铺分配、订单归属使用同一规则：approved 且非 finance。
-- 保留 0031 的锁顺序、历史快照、仅转未完成业务及停用保护。
create or replace function public.admin_handover_user(
  p_from_user_id uuid,
  p_to_user_id uuid,
  p_customer_ids uuid[],
  p_transfer_open_orders boolean,
  p_disable_source boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_source public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_reason text := nullif(btrim(p_reason), '');
  v_requested_count int := 0;
  v_customer_count int := 0;
  v_business_count int := 0;
  v_workflow_count int := 0;
  v_daily_count int := 0;
  v_cancelled_change_count int := 0;
  v_shop_count int := 0;
  v_cleared_subordinate_count int := 0;
  v_customer_ids uuid[] := '{}'::uuid[];
  v_business_ids uuid[] := '{}'::uuid[];
  v_workflow_ids uuid[] := '{}'::uuid[];
  v_daily_ids uuid[] := '{}'::uuid[];
  v_cancelled_change_ids uuid[] := '{}'::uuid[];
  v_shop_ids uuid[] := '{}'::uuid[];
begin
  if not public.is_admin() then raise exception 'Only administrators can hand over accounts'; end if;
  if p_from_user_id is null or p_to_user_id is null then raise exception 'Source and target users are required'; end if;
  if p_transfer_open_orders is null or p_disable_source is null then
    raise exception 'Transfer and disable flags are required';
  end if;
  if p_from_user_id = p_to_user_id then raise exception 'Source and target users must be different'; end if;
  if v_reason is null then raise exception 'A handover reason is required'; end if;
  if char_length(v_reason) > 1000 then raise exception 'Reason is too long'; end if;

  perform pg_advisory_xact_lock(hashtext('account_handover')::bigint);
  perform pg_advisory_xact_lock(hashtext('admin_account_status')::bigint);
  perform pg_advisory_xact_lock(hashtext('profiles_supervisor_hierarchy')::bigint);
  perform pg_advisory_xact_lock(hashtext('finance_daily_order_totals')::bigint);

  select * into v_actor
  from public.profiles
  where id = (select auth.uid())
  for update;
  if not found or v_actor.status::text <> 'approved' or v_actor.role::text <> 'admin' then
    raise exception 'Administrator permission was revoked while waiting for the handover lock';
  end if;
  select * into v_source from public.profiles where id = p_from_user_id for update;
  if not found then raise exception 'Source user does not exist'; end if;
  if v_source.status::text not in ('approved', 'disabled') then
    raise exception 'Pending accounts cannot be handed over';
  end if;
  select * into v_target from public.profiles where id = p_to_user_id for update;
  if not found or v_target.status::text <> 'approved'
     or v_target.role::text = 'finance' then
    raise exception 'Target user must be an approved non-finance user';
  end if;
  if p_disable_source and p_from_user_id = v_actor.id then
    raise exception 'You cannot disable your own account';
  end if;
  if p_disable_source and v_source.role::text = 'admin' and v_source.status::text = 'approved' and not exists (
    select 1 from public.profiles p
    where p.id <> v_source.id and p.role::text = 'admin' and p.status::text = 'approved'
  ) then
    raise exception 'At least one approved administrator must remain';
  end if;

  if p_customer_ids is null then
    perform 1 from public.customers c where c.created_by = v_source.id for update;
    select coalesce(array_agg(c.id order by c.id), '{}'::uuid[]) into v_customer_ids
    from public.customers c where c.created_by = v_source.id;
  elsif cardinality(p_customer_ids) > 0 then
    select count(*) into v_requested_count from (select distinct unnest(p_customer_ids)) requested;
    perform 1 from public.customers c where c.id = any(p_customer_ids) for update;
    select coalesce(array_agg(c.id order by c.id), '{}'::uuid[]) into v_customer_ids
    from public.customers c
    where c.id = any(p_customer_ids) and c.created_by = v_source.id;
    if cardinality(v_customer_ids) <> v_requested_count then
      raise exception 'One or more customers do not belong to the source user';
    end if;
  end if;

  perform set_config('app.customer_owner_rpc', 'transfer', true);
  update public.customers
  set created_by = v_target.id
  where id = any(v_customer_ids);
  get diagnostics v_customer_count = row_count;

  if p_transfer_open_orders then
    with updated as (
      update public.business_orders bo
      set salesperson_id = v_target.id, version = bo.version + 1
      where bo.salesperson_id = v_source.id
        and bo.status::text in ('draft', 'submitted', 'rejected')
        and (p_customer_ids is null or bo.customer_id = any(v_customer_ids))
      returning bo.id
    )
    select coalesce(array_agg(id order by id), '{}'::uuid[]), count(*)::int
      into v_business_ids, v_business_count
    from updated;

    if exists (
      select 1
      from public.finance_daily_order_workflows source_wf
      join public.finance_daily_order_workflows target_wf
        on target_wf.salesperson_id = v_target.id
       and target_wf.order_number = source_wf.order_number
       and target_wf.id <> source_wf.id
      where source_wf.salesperson_id = v_source.id
        and source_wf.status::text <> 'approved'
        and (p_customer_ids is null or source_wf.customer_id = any(v_customer_ids))
    ) then
      raise exception 'Target user already has a daily-order workflow with the same order number';
    end if;

    select coalesce(array_agg(source_wf.id order by source_wf.id), '{}'::uuid[])
      into v_workflow_ids
    from public.finance_daily_order_workflows source_wf
    where source_wf.salesperson_id = v_source.id
      and source_wf.status::text <> 'approved'
      and (p_customer_ids is null or source_wf.customer_id = any(v_customer_ids));

    -- 待审改单属于原业务员的历史操作，交接时保留 requested_by，
    -- 但由执行交接的管理员显式取消，避免唯一待审约束阻塞新负责人。
    with cancelled as (
      update public.finance_daily_order_change_requests
      set status = 'cancelled',
          reviewed_by = v_actor.id,
          reviewed_at = now(),
          review_reason = '账号交接自动取消：' || v_reason
      where workflow_id = any(v_workflow_ids)
        and status::text = 'pending'
      returning id
    )
    select coalesce(array_agg(id order by id), '{}'::uuid[]), count(*)::int
      into v_cancelled_change_ids, v_cancelled_change_count
    from cancelled;

    insert into public.finance_daily_order_workflow_audit_logs(
      workflow_id, action, actor_id, detail
    )
    select change_request.workflow_id,
           'change_cancelled'::public.daily_order_workflow_audit_action,
           v_actor.id,
           jsonb_build_object(
             'order_id', change_request.order_id,
             'change_id', change_request.id,
             'reason', 'account_handover'
           )
    from public.finance_daily_order_change_requests change_request
    where change_request.id = any(v_cancelled_change_ids);

    perform 1 from public.finance_daily_order_workflows source_wf
    where source_wf.id = any(v_workflow_ids)
    for update;

    update public.finance_daily_order_workflows
    set salesperson_id = v_target.id, version = version + 1
    where id = any(v_workflow_ids);
    get diagnostics v_workflow_count = row_count;

    with updated as (
      update public.finance_daily_orders
      set salesperson_id = v_target.id, version = version + 1, updated_by = v_actor.id
      where workflow_id = any(v_workflow_ids)
        and status::text = 'active'
      returning id
    )
    select coalesce(array_agg(id order by id), '{}'::uuid[]), count(*)::int
      into v_daily_ids, v_daily_count
    from updated;
  end if;

  with changed as (
    insert into public.finance_daily_order_shop_salespeople(
      shop_id, salesperson_id, is_active, created_by
    )
    select a.shop_id, v_target.id, true, v_actor.id
    from public.finance_daily_order_shop_salespeople a
    where a.salesperson_id = v_source.id and a.is_active = true
    on conflict (shop_id, salesperson_id) do update set is_active = true
    returning shop_id
  )
  select coalesce(array_agg(shop_id order by shop_id), '{}'::uuid[]), count(*)::int
    into v_shop_ids, v_shop_count
  from changed;

  if p_disable_source then
    update public.finance_daily_order_shop_salespeople
    set is_active = false
    where salesperson_id = v_source.id;

    perform set_config('app.profile_mutation_rpc', 'lifecycle', true);
    update public.profiles
    set supervisor_id = null
    where supervisor_id = v_source.id;
    get diagnostics v_cleared_subordinate_count = row_count;

    update public.profiles
    set status = 'disabled', disabled_at = now(), disabled_by = v_actor.id,
        supervisor_id = null
    where id = v_source.id;
  end if;

  insert into public.account_lifecycle_audit_logs(
    action, source_user_id, target_user_id,
    source_name_snapshot, target_name_snapshot,
    actor_id, actor_name_snapshot, reason, detail
  ) values (
    'handover', v_source.id, v_target.id,
    coalesce(public.profile_display_name(v_source.id), v_source.email),
    coalesce(public.profile_display_name(v_target.id), v_target.email),
    v_actor.id, coalesce(public.profile_display_name(v_actor.id), '系统'),
    v_reason,
    jsonb_build_object(
      'customer_count', v_customer_count,
      'customer_ids', to_jsonb(v_customer_ids),
      'business_order_count', v_business_count,
      'business_order_ids', to_jsonb(v_business_ids),
      'daily_workflow_count', v_workflow_count,
      'daily_workflow_ids', to_jsonb(v_workflow_ids),
      'daily_order_count', v_daily_count,
      'daily_order_ids', to_jsonb(v_daily_ids),
      'cancelled_change_request_count', v_cancelled_change_count,
      'cancelled_change_request_ids', to_jsonb(v_cancelled_change_ids),
      'shop_assignment_count', v_shop_count,
      'shop_ids', to_jsonb(v_shop_ids),
      'source_disabled', p_disable_source,
      'cleared_subordinate_count', v_cleared_subordinate_count
    )
  );

  return jsonb_build_object(
    'customer_count', v_customer_count,
    'business_order_count', v_business_count,
    'daily_workflow_count', v_workflow_count,
    'daily_order_count', v_daily_count,
    'cancelled_change_request_count', v_cancelled_change_count,
    'shop_assignment_count', v_shop_count,
    'source_disabled', p_disable_source
  );
end;
$$;
revoke all on function public.admin_handover_user(uuid, uuid, uuid[], boolean, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_handover_user(uuid, uuid, uuid[], boolean, boolean, text)
  to authenticated;
