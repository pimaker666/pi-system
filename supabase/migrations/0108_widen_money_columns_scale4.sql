-- 金额列精度统一加宽到 numeric(18,4)：展示默认 2 位，填写支持 4 位。
-- 幂等：已到位的列自动跳过。权重类（weight_g 系列）保持 3 位，数量/汇率列原本已 ≥4 不动。
-- 生成列（generated column）依赖金额列：先删后加，表达式同步 round(…, 4)。

DO $$ BEGIN
  ALTER TABLE public.business_custom_product_versions DROP COLUMN IF EXISTS order_amount;
  ALTER TABLE public.business_custom_product_versions DROP COLUMN IF EXISTS outstanding_amount;
  ALTER TABLE public.business_order_items DROP COLUMN IF EXISTS line_amount;
  ALTER TABLE public.business_orders DROP COLUMN IF EXISTS total_cny;
  ALTER TABLE public.finance_order_costs DROP COLUMN IF EXISTS amount_cny;
  ALTER TABLE public.finance_orders DROP COLUMN IF EXISTS amount_cny;
  ALTER TABLE public.finance_transactions DROP COLUMN IF EXISTS amount_cny;
END $$;

DO $$
DECLARE
  target_tables text[] := ARRAY[
    'business_custom_product_versions',
    'business_customer_transfers',
    'business_order_amount_revisions',
    'business_order_finance_details',
    'business_order_items',
    'business_order_payment_allocations',
    'business_order_payments',
    'business_orders',
    'finance_daily_order_commissions',
    'finance_daily_order_workflows',
    'finance_daily_orders',
    'finance_order_costs',
    'finance_orders',
    'finance_transactions',
    'pi_items',
    'products',
    'proforma_invoices'
  ];
  t text;
  col record;
  trg record;
  skipped int := 0;
  altered int := 0;
BEGIN
  FOREACH t IN ARRAY target_tables LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = t) THEN
      RAISE NOTICE 'table % missing, skip', t;
      CONTINUE;
    END IF;

    -- 本表全部非内部触发器：先删后建（触发器列依赖会阻塞 ALTER COLUMN TYPE）。
    CREATE TEMP TABLE IF NOT EXISTS _0108_trg_defs (tgname text, tgdef text) ON COMMIT DROP;
    DELETE FROM _0108_trg_defs;
    INSERT INTO _0108_trg_defs
      SELECT tr.tgname, pg_get_triggerdef(tr.oid)
      FROM pg_trigger tr
      WHERE tr.tgrelid = format('public.%I', t)::regclass
        AND NOT tr.tgisinternal;
    FOR trg IN SELECT tgname FROM _0108_trg_defs LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', trg.tgname, t);
    END LOOP;

    FOR col IN
      SELECT column_name, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = t
        AND data_type = 'numeric'
        AND numeric_scale < 4
        AND column_name NOT LIKE '%weight%'
        AND column_name NOT LIKE '%quantity%'
    LOOP
      IF col.numeric_precision = 18 AND col.numeric_scale = 4 THEN
        skipped := skipped + 1;
      ELSE
        EXECUTE format(
          'ALTER TABLE public.%I ALTER COLUMN %I TYPE numeric(18,4)',
          t, col.column_name
        );
        altered := altered + 1;
      END IF;
    END LOOP;

    FOR trg IN SELECT tgdef FROM _0108_trg_defs LOOP
      EXECUTE trg.tgdef;
    END LOOP;
    DROP TABLE IF EXISTS _0108_trg_defs;
  END LOOP;

  ALTER TABLE public.business_custom_product_versions
    ADD COLUMN order_amount numeric(18,4)
      GENERATED ALWAYS AS (CASE WHEN quantity IS NULL THEN NULL::numeric ELSE round(quantity * default_unit_price, 4) END) STORED,
    ADD COLUMN outstanding_amount numeric(18,4)
      GENERATED ALWAYS AS (CASE WHEN quantity IS NULL THEN NULL::numeric ELSE round(quantity * default_unit_price - COALESCE(received_amount, 0), 4) END) STORED;
  ALTER TABLE public.business_order_items
    ADD COLUMN line_amount numeric(18,4)
      GENERATED ALWAYS AS (round(quantity * unit_price, 4)) STORED;
  ALTER TABLE public.business_orders
    ADD COLUMN total_cny numeric(18,4)
      GENERATED ALWAYS AS (round(total_amount * exchange_rate_to_cny, 4)) STORED;
  ALTER TABLE public.finance_order_costs
    ADD COLUMN amount_cny numeric(18,4)
      GENERATED ALWAYS AS (round(amount_original * exchange_rate_to_cny, 4)) STORED;
  ALTER TABLE public.finance_orders
    ADD COLUMN amount_cny numeric(18,4)
      GENERATED ALWAYS AS (round(amount_original * exchange_rate_to_cny, 4)) STORED;
  ALTER TABLE public.finance_transactions
    ADD COLUMN amount_cny numeric(18,4)
      GENERATED ALWAYS AS (round(amount_original * exchange_rate_to_cny, 4)) STORED;

  RAISE NOTICE '0108 widen done: % altered, % skipped', altered, skipped;
END $$;

-- ============================================================
-- Part B: 重写金额相关函数（scale 2 → 4）
-- 底稿：pg_get_functiondef 从生产库导出的线上真实函数体（2026-10-23）
-- 转换：round(x, 2) → round(x, 4)、numeric(18,2) → numeric(18,4)
--      split_part(x, /, 2) 保持不变；含 2 个同名重载，共 24 个函数
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_business_order(p_customer_id uuid, p_order_date date, p_fulfillment_type business_fulfillment_type, p_currency currency_code, p_exchange_rate_to_cny numeric, p_shipping_fee numeric, p_tracking_number text, p_sales_notes text, p_items jsonb)
 RETURNS TABLE(id uuid, order_number text, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_customer public.customers%rowtype;
  v_customer_snapshot jsonb := '{}'::jsonb;
  v_order public.business_orders%rowtype;
  v_subtotal numeric(18,4);
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
      'country', v_customer.country, 'contact_person', v_customer.contact_person,
      'tag_color', v_customer.tag_color
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
$function$;

CREATE OR REPLACE FUNCTION public.create_finance_daily_order(p_order_date date, p_shop_id uuid, p_salesperson_id uuid, p_order_number text, p_shipping_date date, p_shipping_number text, p_shipping_category daily_order_shipping_category, p_product_id uuid, p_quantity numeric, p_sales_unit_price_amount numeric, p_sales_unit_price_currency currency_code, p_product_received_amount numeric, p_product_received_currency currency_code, p_logistics_fee_amount numeric, p_logistics_fee_currency currency_code, p_sales_total_amount numeric, p_sales_total_currency currency_code, p_payment_category daily_order_payment_category, p_remarks text)
 RETURNS TABLE(id uuid, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if p_sales_unit_price_amount <> round(p_sales_unit_price_amount, 4)
     or p_product_received_amount <> round(p_product_received_amount, 4)
     or p_logistics_fee_amount <> round(p_logistics_fee_amount, 4)
     or p_sales_total_amount <> round(p_sales_total_amount, 4)
  then raise exception 'Amounts cannot exceed 2 decimal places'; end if;

  select * into v_shop
  from public.finance_daily_order_shops as shops
  where shops.id = p_shop_id and shops.is_active = true;
  if not found then raise exception 'Shop does not exist or is inactive'; end if;
  select * into v_sales
  from public.profiles as salespeople
  where salespeople.id = p_salesperson_id
    and salespeople.status::text = 'approved'
    and salespeople.role::text in ('sales', 'admin');
  if not found then raise exception 'Salesperson does not exist or is not approved'; end if;
  if not exists (
    select 1 from public.finance_daily_order_shop_salespeople as assignments
    where assignments.shop_id = p_shop_id
      and assignments.salesperson_id = p_salesperson_id
      and assignments.is_active = true
  ) then raise exception 'Salesperson is not assigned to shop'; end if;
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
    p_sales_total_amount, p_sales_total_currency, p_payment_category, nullif(btrim(p_remarks), ''), v_workflow_id, v_actor.id, v_actor.id
  ) returning * into v_order;
  return query select v_order.id, v_order.version;
end;
$function$;

CREATE OR REPLACE FUNCTION public.validate_daily_order_change_payload(p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
declare v_num numeric;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Change payload must be a JSON object';
  end if;
  if p_payload = '{}'::jsonb then
    raise exception 'Change payload cannot be empty';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_payload) as k(key)
    where k.key not in (
      'shipping_date', 'shipping_number', 'shipping_category', 'quantity',
      'sales_unit_price_amount', 'sales_unit_price_currency',
      'product_received_amount', 'product_received_currency',
      'logistics_fee_amount', 'logistics_fee_currency',
      'sales_total_amount', 'sales_total_currency',
      'payment_category', 'remarks'
    )
  ) then
    raise exception 'Change payload contains unsupported fields';
  end if;

  if p_payload ? 'shipping_date' then
    perform (p_payload->>'shipping_date')::date;
  end if;
  if p_payload ? 'shipping_number' and char_length(coalesce(p_payload->>'shipping_number', '')) > 200 then
    raise exception 'Shipping number is too long';
  end if;
  if p_payload ? 'shipping_category' then
    perform (p_payload->>'shipping_category')::public.daily_order_shipping_category;
  end if;
  if p_payload ? 'payment_category' then
    perform (p_payload->>'payment_category')::public.daily_order_payment_category;
  end if;
  if p_payload ? 'remarks' and char_length(coalesce(p_payload->>'remarks', '')) > 2000 then
    raise exception 'Remarks are too long';
  end if;

  if p_payload ? 'quantity' then
    v_num := (p_payload->>'quantity')::numeric;
    if v_num <= 0 or v_num > 999999999999 or v_num <> round(v_num, 4) then
      raise exception 'Quantity must be positive and within 4 decimal places';
    end if;
  end if;

  foreach v_num in array (
    select coalesce(array_agg((p_payload->>col)::numeric), array[]::numeric[])
    from unnest(array[
      'sales_unit_price_amount', 'product_received_amount', 'logistics_fee_amount', 'sales_total_amount'
    ]) as col
    where p_payload ? col
  ) loop
    if v_num < 0 or v_num > 999999999999 or v_num <> round(v_num, 4) then
      raise exception 'Amounts must be non-negative and within 2 decimal places';
    end if;
  end loop;

  if p_payload ? 'sales_unit_price_currency' then
    perform (p_payload->>'sales_unit_price_currency')::public.currency_code;
    if (p_payload->>'sales_unit_price_currency') not in ('CNY', 'USD') then raise exception 'Unsupported currency'; end if;
  end if;
  if p_payload ? 'product_received_currency' then
    perform (p_payload->>'product_received_currency')::public.currency_code;
    if (p_payload->>'product_received_currency') not in ('CNY', 'USD') then raise exception 'Unsupported currency'; end if;
  end if;
  if p_payload ? 'logistics_fee_currency' then
    perform (p_payload->>'logistics_fee_currency')::public.currency_code;
    if (p_payload->>'logistics_fee_currency') not in ('CNY', 'USD') then raise exception 'Unsupported currency'; end if;
  end if;
  if p_payload ? 'sales_total_currency' then
    perform (p_payload->>'sales_total_currency')::public.currency_code;
    if (p_payload->>'sales_total_currency') not in ('CNY', 'USD') then raise exception 'Unsupported currency'; end if;
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.update_finance_daily_order_unchecked_0031(p_order_id uuid, p_expected_version integer, p_order_date date, p_shop_id uuid, p_salesperson_id uuid, p_order_number text, p_shipping_date date, p_shipping_number text, p_shipping_category daily_order_shipping_category, p_product_id uuid, p_quantity numeric, p_sales_unit_price_amount numeric, p_sales_unit_price_currency currency_code, p_product_received_amount numeric, p_product_received_currency currency_code, p_logistics_fee_amount numeric, p_logistics_fee_currency currency_code, p_sales_total_amount numeric, p_sales_total_currency currency_code, p_payment_category daily_order_payment_category, p_remarks text)
 RETURNS TABLE(id uuid, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  select * into v_existing from public.finance_daily_orders where finance_daily_orders.id = p_order_id for update;
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
  if p_sales_unit_price_amount <> round(p_sales_unit_price_amount, 4)
     or p_product_received_amount <> round(p_product_received_amount, 4)
     or p_logistics_fee_amount <> round(p_logistics_fee_amount, 4)
     or p_sales_total_amount <> round(p_sales_total_amount, 4)
  then raise exception 'Amounts cannot exceed 2 decimal places'; end if;
  select * into v_shop
  from public.finance_daily_order_shops as shops
  where shops.id = p_shop_id and shops.is_active = true;
  if not found then raise exception 'Shop does not exist or is inactive'; end if;
  select * into v_sales
  from public.profiles as salespeople
  where salespeople.id = p_salesperson_id
    and salespeople.status::text = 'approved'
    and salespeople.role::text in ('sales', 'admin');
  if not found then raise exception 'Salesperson does not exist or is not approved'; end if;
  if not exists (
    select 1 from public.finance_daily_order_shop_salespeople as assignments
    where assignments.shop_id = p_shop_id
      and assignments.salesperson_id = p_salesperson_id
      and assignments.is_active = true
  ) then raise exception 'Salesperson is not assigned to shop'; end if;
  select * into v_product
  from public.products as products
  where products.id = p_product_id and products.is_active = true;
  if not found then raise exception 'Product does not exist or is inactive'; end if;

  v_sales_name := coalesce(nullif(btrim(v_sales.full_name), ''), v_sales.email);
  v_workflow_id := public.resolve_daily_order_workflow(v_sales.id, v_sales_name, p_order_number, v_actor.id);

  update public.finance_daily_orders as target set
    order_date = p_order_date, shop_id = v_shop.id, shop_name_snapshot = v_shop.name,
    salesperson_id = v_sales.id, salesperson_name_snapshot = v_sales_name,
    order_number = btrim(p_order_number), shipping_date = p_shipping_date,
    shipping_number = nullif(btrim(p_shipping_number), ''), shipping_category = p_shipping_category,
    product_id = v_product.id, product_name_snapshot = v_product.name, product_sku_snapshot = v_product.sku,
    quantity = p_quantity, sales_unit_price_amount = p_sales_unit_price_amount,
    sales_unit_price_currency = p_sales_unit_price_currency,
    product_received_amount = p_product_received_amount, product_received_currency = p_product_received_currency,
    logistics_fee_amount = p_logistics_fee_amount, logistics_fee_currency = p_logistics_fee_currency,
    sales_total_amount = p_sales_total_amount, sales_total_currency = p_sales_total_currency,
    payment_category = p_payment_category, remarks = nullif(btrim(p_remarks), ''),
    workflow_id = v_workflow_id,
    version = target.version + 1, updated_by = v_actor.id
  where target.id = p_order_id
  returning target.id, target.version into id, version;
  return next;
end;
$function$;

CREATE OR REPLACE FUNCTION public.bulk_create_finance_daily_orders_with_totals(p_rows jsonb, p_totals jsonb)
 RETURNS TABLE(id uuid, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_created record;
  v_ids uuid[] := array[]::uuid[];
  v_workflow_id uuid;
  v_workflow_count int;
  v_product_amount numeric;
  v_shipping_amount numeric;
  v_sales_amount numeric;
  v_product_currency public.currency_code;
  v_shipping_currency public.currency_code;
  v_sales_currency public.currency_code;
  v_product_overridden boolean;
  v_shipping_overridden boolean;
  v_sales_overridden boolean;
begin
  perform public.assert_daily_order_finance_actor();
  if p_totals is null or jsonb_typeof(p_totals) <> 'object' then
    raise exception 'Order totals must be an object';
  end if;
  if not (p_totals ?& array[
    'total_product_received_amount', 'total_product_received_currency', 'total_product_received_overridden',
    'total_shipping_received_amount', 'total_shipping_received_currency', 'total_shipping_received_overridden',
    'total_sales_amount', 'total_sales_currency', 'total_sales_overridden'
  ]) then
    raise exception 'Order totals are incomplete';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_totals) as fields(key)
    where fields.key not in (
      'total_product_received_amount', 'total_product_received_currency', 'total_product_received_overridden',
      'total_shipping_received_amount', 'total_shipping_received_currency', 'total_shipping_received_overridden',
      'total_sales_amount', 'total_sales_currency', 'total_sales_overridden'
    )
  ) then
    raise exception 'Order totals contain unsupported fields';
  end if;

  v_product_amount := (p_totals->>'total_product_received_amount')::numeric;
  v_shipping_amount := (p_totals->>'total_shipping_received_amount')::numeric;
  v_sales_amount := (p_totals->>'total_sales_amount')::numeric;
  if v_product_amount < 0 or v_product_amount > 999999999999 or v_product_amount <> round(v_product_amount, 4)
     or v_shipping_amount < 0 or v_shipping_amount > 999999999999 or v_shipping_amount <> round(v_shipping_amount, 4)
     or v_sales_amount < 0 or v_sales_amount > 999999999999 or v_sales_amount <> round(v_sales_amount, 4)
  then
    raise exception 'Order totals must be non-negative and within 2 decimal places';
  end if;
  if p_totals->>'total_product_received_currency' not in ('CNY', 'USD')
     or p_totals->>'total_shipping_received_currency' not in ('CNY', 'USD')
     or p_totals->>'total_sales_currency' not in ('CNY', 'USD')
  then
    raise exception 'Order total currencies must be CNY or USD';
  end if;
  v_product_currency := (p_totals->>'total_product_received_currency')::public.currency_code;
  v_shipping_currency := (p_totals->>'total_shipping_received_currency')::public.currency_code;
  v_sales_currency := (p_totals->>'total_sales_currency')::public.currency_code;
  v_product_overridden := (p_totals->>'total_product_received_overridden')::boolean;
  v_shipping_overridden := (p_totals->>'total_shipping_received_overridden')::boolean;
  v_sales_overridden := (p_totals->>'total_sales_overridden')::boolean;
  if v_product_overridden is null or v_shipping_overridden is null or v_sales_overridden is null then
    raise exception 'Order total override flags are required';
  end if;

  for v_created in select * from public.bulk_create_finance_daily_orders(p_rows) loop
    v_ids := array_append(v_ids, v_created.id);
    id := v_created.id;
    version := v_created.version;
    return next;
  end loop;

  select count(distinct orders.workflow_id), min(orders.workflow_id::text)::uuid
  into v_workflow_count, v_workflow_id
  from public.finance_daily_orders as orders
  where orders.id = any(v_ids);
  if v_workflow_count <> 1 or v_workflow_id is null then
    raise exception 'Rows with explicit order totals must belong to one order';
  end if;

  perform 1
  from public.finance_daily_order_workflows as workflows
  where workflows.id = v_workflow_id
  for update;

  update public.finance_daily_order_workflows as workflows
  set
    total_product_received_amount = case when v_product_overridden then v_product_amount else workflows.total_product_received_amount end,
    total_product_received_currency = case when v_product_overridden then v_product_currency else workflows.total_product_received_currency end,
    total_product_received_overridden = workflows.total_product_received_overridden or v_product_overridden,
    total_shipping_received_amount = case when v_shipping_overridden then v_shipping_amount else workflows.total_shipping_received_amount end,
    total_shipping_received_currency = case when v_shipping_overridden then v_shipping_currency else workflows.total_shipping_received_currency end,
    total_shipping_received_overridden = workflows.total_shipping_received_overridden or v_shipping_overridden,
    total_sales_amount = case when v_sales_overridden then v_sales_amount else workflows.total_sales_amount end,
    total_sales_currency = case when v_sales_overridden then v_sales_currency else workflows.total_sales_currency end,
    total_sales_overridden = workflows.total_sales_overridden or v_sales_overridden
  where workflows.id = v_workflow_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.replace_business_order_items(p_order_id uuid, p_items jsonb)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_subtotal numeric(18,4) := 0;
  v_matched_ids uuid[] := array[]::uuid[];
  v_is_existing boolean;
begin
  select * into v_order from public.business_orders bo where bo.id = p_order_id for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if v_order.status::text = 'completed' or v_order.closed_at is not null then
    raise exception 'Completed or closed order items cannot be replaced';
  end if;
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
    v_unit_price := round((v_item->>'unit_price')::numeric, 4);
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
      if not found then
        raise exception 'Product does not exist';
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
    v_subtotal := v_subtotal + round(v_quantity * v_unit_price, 4);
    v_sort_order := v_sort_order + 1;
  end loop;

  if exists (
    select 1
    from public.business_order_shipment_items si
    join public.business_order_shipments s on s.id = si.shipment_id
    where s.order_id = p_order_id
      and s.voided_at is null
      and not (si.order_item_id = any(v_matched_ids))
  ) then
    raise exception 'Shipped items cannot be removed; void the shipment batch first';
  end if;

  delete from public.business_order_items
  where order_id = p_order_id and not (id = any(v_matched_ids));
  return v_subtotal;
end;
$function$;

CREATE OR REPLACE FUNCTION public.update_business_order(p_order_id uuid, p_expected_version integer, p_customer_id uuid, p_order_date date, p_fulfillment_type business_fulfillment_type, p_currency currency_code, p_exchange_rate_to_cny numeric, p_shipping_fee numeric, p_tracking_number text, p_sales_notes text, p_items jsonb, p_reason text)
 RETURNS TABLE(id uuid, order_number text, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_customer public.customers%rowtype;
  v_customer_snapshot jsonb := '{}'::jsonb;
  v_old jsonb;
  v_subtotal numeric(18,4);
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
    if v_actor.role::text not in ('admin', 'finance')
       or v_order.status::text <> 'approved' then
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
      'country', v_customer.country, 'contact_person', v_customer.contact_person,
      'tag_color', v_customer.tag_color
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
$function$;

CREATE OR REPLACE FUNCTION public.business_apply_transfer_allocations(p_transfer_id uuid, p_allocations jsonb, p_actor_id uuid, p_correction_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_transfer public.business_customer_transfers%rowtype;
  v_actor public.profiles%rowtype;
  v_item jsonb;
  v_order public.business_orders%rowtype;
  v_order_item public.business_order_items%rowtype;
  v_allocation public.business_order_payment_allocations%rowtype;
  v_order_id uuid;
  v_order_item_id uuid;
  v_target text;
  v_amount numeric;
  v_payment_type public.business_payment_type;
  v_transfer_allocated numeric;
  v_order_paid numeric;
  v_item_allocated numeric;
  v_shipping_allocated numeric;
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
  if not public.can_manage_business_transfer(v_transfer.id) then
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
    from jsonb_to_recordset(p_allocations)
      as x(order_id uuid, amount numeric, payment_type text, order_item_id uuid, allocation_target text)
    where x.order_id is null
  ) then
    raise exception 'Each allocation must have an order_id';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_allocations)
      as x(order_id uuid, amount numeric, payment_type text, order_item_id uuid, allocation_target text)
    where coalesce(nullif(x.allocation_target, ''), 'order') not in ('order', 'item', 'shipping')
       or (coalesce(nullif(x.allocation_target, ''), 'order') = 'item')
          <> (x.order_item_id is not null)
  ) then
    raise exception 'Allocation target is invalid';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_allocations)
      as x(order_id uuid, amount numeric, payment_type text, order_item_id uuid, allocation_target text)
    group by x.order_id, coalesce(nullif(x.allocation_target, ''), 'order'), x.order_item_id
    having count(*) > 1
  ) then
    raise exception 'Each allocation must target a unique order, order item, or shipping';
  end if;

  -- 固定顺序锁住全部目标订单，避免多个转账并发分摊时死锁或超收。
  perform bo.id
  from public.business_orders bo
  join (
    select x.order_id
    from jsonb_to_recordset(p_allocations)
      as x(order_id uuid, amount numeric, payment_type text, order_item_id uuid, allocation_target text)
  ) requested on requested.order_id = bo.id
  order by bo.id
  for update of bo;

  if (select count(*) from jsonb_to_recordset(p_allocations)
        as x(order_id uuid, amount numeric, payment_type text, order_item_id uuid, allocation_target text))
     <> (select count(*) from public.business_orders bo
         join (select x.order_id from jsonb_to_recordset(p_allocations)
               as x(order_id uuid, amount numeric, payment_type text, order_item_id uuid, allocation_target text)) r
           on r.order_id = bo.id) then
    raise exception 'One or more allocation orders do not exist';
  end if;

  select coalesce(sum(a.amount), 0) into v_transfer_allocated
  from public.business_order_payment_allocations a
  where a.transfer_id = v_transfer.id and a.voided_at is null;

  select coalesce(sum(round(x.amount, 4)), 0) into v_requested
  from jsonb_to_recordset(p_allocations)
    as x(order_id uuid, amount numeric, payment_type text, order_item_id uuid, allocation_target text);
  if v_requested > v_transfer.amount - v_transfer_allocated then
    raise exception 'Allocations exceed transfer available amount';
  end if;
  if v_transfer.customer_id is null then
    if v_requested <> v_transfer.amount then
      raise exception 'Order transfer must be fully allocated to its own order';
    end if;
    if exists (
      select 1
      from jsonb_to_recordset(p_allocations)
        as x(order_id uuid, amount numeric, payment_type text, order_item_id uuid, allocation_target text)
      where coalesce(nullif(x.allocation_target, ''), 'order') = 'order'
    ) then
      raise exception 'Order transfer allocations must target an order item or shipping';
    end if;
  end if;

  -- 订单级硬性闸门（结算口径）：本批每单合计 + 该单既有有效分摊
  -- 不得超过 total_amount - coalesce(total_sales_amount, 0)。
  perform 1
  from (
    select x.order_id, round(sum(x.amount), 4) as batch_total
    from jsonb_to_recordset(p_allocations)
      as x(order_id uuid, amount numeric, payment_type text, order_item_id uuid, allocation_target text)
    group by x.order_id
  ) batch
  join public.business_orders o on o.id = batch.order_id
  where batch.batch_total > round(
    o.total_amount
    - coalesce(o.total_sales_amount, 0)
    - coalesce((
        select sum(a.amount)
        from public.business_order_payment_allocations a
        join public.business_customer_transfers t on t.id = a.transfer_id
        where a.order_id = o.id
          and a.voided_at is null
          and t.voided_at is null
      ), 0), 4);
  if found then
    raise exception 'Allocations exceed order outstanding amount';
  end if;

  for v_item in select value from jsonb_array_elements(p_allocations)
  loop
    v_order_id := nullif(v_item->>'order_id', '')::uuid;
    v_order_item_id := nullif(v_item->>'order_item_id', '')::uuid;
    v_target := coalesce(nullif(v_item->>'allocation_target', ''), 'order');
    v_amount := round((v_item->>'amount')::numeric, 4);
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
    if v_transfer.customer_id is null then
      if v_order.id is distinct from v_transfer.order_id then
        raise exception 'Order transfer can only be allocated to its own order';
      end if;
    elsif v_order.customer_id is distinct from v_transfer.customer_id then
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

    if v_target = 'item' then
      select * into v_order_item from public.business_order_items
      where id = v_order_item_id and order_id = v_order.id;
      if not found then
        raise exception 'Allocation order item does not belong to allocation order';
      end if;
      select coalesce(sum(a.amount), 0) into v_item_allocated
      from public.business_order_payment_allocations a
      join public.business_customer_transfers t on t.id = a.transfer_id
      where a.order_item_id = v_order_item.id
        and a.voided_at is null
        and t.voided_at is null;
      if v_amount > round(v_order_item.line_amount
                          - coalesce(v_order_item.product_received_amount, 0)
                          - v_item_allocated, 4) then
        raise exception 'Allocation exceeds order item outstanding amount';
      end if;
    elsif v_target = 'shipping' then
      select coalesce(sum(a.amount), 0) into v_shipping_allocated
      from public.business_order_payment_allocations a
      join public.business_customer_transfers t on t.id = a.transfer_id
      where a.order_id = v_order.id
        and a.allocation_target = 'shipping'
        and a.voided_at is null
        and t.voided_at is null;
      if v_amount > round(coalesce(v_order.shipping_fee, 0)
                          - coalesce(v_order.total_shipping_received_amount, 0)
                          - v_shipping_allocated, 4) then
        raise exception 'Allocation exceeds order shipping outstanding amount';
      end if;
    else
      select coalesce(sum(a.amount), 0) into v_order_paid
      from public.business_order_payment_allocations a
      join public.business_customer_transfers t on t.id = a.transfer_id
      where a.order_id = v_order.id
        and a.voided_at is null
        and t.voided_at is null;
      if v_amount > round(v_order.total_amount
                          - coalesce(v_order.total_sales_amount, 0)
                          - v_order_paid, 4) then
        raise exception 'Allocation exceeds order outstanding amount';
      end if;
    end if;

    insert into public.business_order_payment_allocations (
      transfer_id, order_id, order_item_id, allocation_target, amount, payment_type, created_by
    ) values (
      v_transfer.id, v_order.id, v_order_item_id, v_target, v_amount, v_payment_type, p_actor_id
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
$function$;

CREATE OR REPLACE FUNCTION public.get_finance_summary()
 RETURNS TABLE(order_revenue numeric, income numeric, expense numeric, order_costs numeric, gross_profit numeric, cash_balance numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with legacy_order_summary as (
    select coalesce(sum(amount_cny), 0) as amount
    from public.finance_orders
    where status = 'active'
  ),
  business_order_summary as (
    select coalesce(sum(total_cny), 0) as amount
    from public.business_orders
    where status = 'completed' and voided_at is null
  ),
  transaction_summary as (
    select
      coalesce(sum(amount_cny) filter (where transaction_type = 'income'), 0) as income,
      coalesce(sum(amount_cny) filter (where transaction_type = 'expense'), 0) as expense
    from public.finance_transactions
    where status = 'active'
  ),
  business_transfer_summary as (
    select coalesce(sum(round(a.amount * t.exchange_rate_to_cny, 4)), 0) as income
    from public.business_order_payment_allocations a
    join public.business_customer_transfers t on t.id = a.transfer_id
    join public.business_orders bo on bo.id = a.order_id
    where a.voided_at is null
      and t.voided_at is null
      and bo.voided_at is null
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
    where bo.status = 'completed' and bo.voided_at is null
  ),
  business_wage_summary as (
    select coalesce(sum(bofd.wage_amount_cny), 0) as amount
    from public.business_order_finance_details bofd
    join public.business_orders bo on bo.id = bofd.order_id
    where bo.status = 'completed' and bo.voided_at is null
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
$function$;

CREATE OR REPLACE FUNCTION public.create_business_order_v4(p_customer_id uuid, p_order_date date, p_fulfillment_type business_fulfillment_type, p_currency currency_code, p_exchange_rate_to_cny numeric, p_shipping_fee numeric, p_tracking_number text, p_sales_notes text, p_items jsonb, p_payment_due_date date, p_shop_id uuid, p_salesperson_id uuid, p_external_order_number text, p_daily_shipping_date date, p_daily_shipping_number text, p_daily_payment_category daily_order_payment_category, p_total_product_received_amount numeric, p_total_product_received_overridden boolean, p_total_shipping_received_amount numeric, p_total_shipping_received_overridden boolean, p_total_sales_amount numeric, p_total_sales_overridden boolean, p_receivable_received_difference_reason text, p_payment_account text)
 RETURNS TABLE(id uuid, order_number text, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if char_length(coalesce(p_payment_account, '')) > 200 then
    raise exception 'Payment account cannot exceed 200 characters';
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

  update public.business_orders bo
  set payment_account = nullif(btrim(p_payment_account), '')
  where bo.id = v_order.id
  returning * into v_order;

  if round(v_order.total_amount, 4) = round(v_order.total_sales_amount, 4) then
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
$function$;

CREATE OR REPLACE FUNCTION public.get_business_order_edit_constraints(p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

CREATE OR REPLACE FUNCTION public.apply_business_order_daily_entry(p_order_id uuid, p_shop_id uuid, p_salesperson_id uuid, p_external_order_number text, p_daily_shipping_date date, p_daily_shipping_number text, p_daily_payment_category daily_order_payment_category, p_total_product_received_amount numeric, p_total_product_received_overridden boolean, p_total_shipping_received_amount numeric, p_total_shipping_received_overridden boolean, p_total_sales_amount numeric, p_total_sales_overridden boolean, p_items jsonb, p_actor_id uuid, p_is_create boolean, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_product_sum numeric(18,4) := 0;
  v_shipping_sum numeric(18,4) := 0;
  v_sales_sum numeric(18,4) := 0;
  v_effective_product_total numeric(18,4);
  v_effective_shipping_total numeric(18,4);
  v_effective_sales_total numeric(18,4);
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
     or p_total_product_received_amount <> round(p_total_product_received_amount, 4)
     or p_total_shipping_received_amount < 0
     or p_total_shipping_received_amount > 999999999999
     or p_total_shipping_received_amount <> round(p_total_shipping_received_amount, 4)
     or p_total_sales_amount < 0
     or p_total_sales_amount > 999999999999
     or p_total_sales_amount <> round(p_total_sales_amount, 4) then
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
    if v_item->>'daily_shipping_category' not in ('stock', 'sample', 'custom_sample', 'custom', 'purchase') then
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
       or v_product_amount <> round(v_product_amount, 4)
       or v_logistics_amount < 0 or v_logistics_amount > 999999999999
       or v_logistics_amount <> round(v_logistics_amount, 4)
       or v_sales_amount < 0 or v_sales_amount > 999999999999
       or v_sales_amount <> round(v_sales_amount, 4) then
      raise exception 'Daily order item amounts must be non-negative and within 2 decimal places';
    end if;

    select * into v_order_item
    from public.business_order_items i
    where i.order_id = p_order_id and i.sort_order = v_sort_order
    for update;
    if not found then raise exception 'Daily order item does not match business order item'; end if;

    if not v_product_overridden then
      v_product_amount := round(v_order_item.quantity * v_order_item.unit_price, 4);
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
$function$;

CREATE OR REPLACE FUNCTION public.create_business_order_shipment_internal_0057(p_order_id uuid, p_shipped_at timestamp with time zone, p_tracking_number text, p_notes text, p_items jsonb, p_idempotency_key text, p_allow_overship boolean, p_overship_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
  v_subtotal_before numeric(18,4);
  v_total_before numeric(18,4);
  v_subtotal_after numeric(18,4);
  v_revision public.business_order_amount_revisions%rowtype;
  v_payload jsonb;
  v_hash text;
  v_created jsonb := '[]'::jsonb;
  v_result jsonb;
  v_shipping_number text;
  v_existing_numbers text[];
  v_updated_numbers text;
begin
  perform set_config('app.adjust_business_order_items_rpc', 'true', true);
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
  v_shipping_number := nullif(btrim(coalesce(p_tracking_number, '')), '');
  if v_shipping_number is not null then
    select coalesce(array_agg(btrim(part) order by ord), array[]::text[])
      into v_existing_numbers
    from unnest(string_to_array(coalesce(v_order.daily_shipping_number, ''), '、'))
      with ordinality as t(part, ord)
    where btrim(part) <> '';
    if not (v_shipping_number = any(v_existing_numbers)) then
      v_updated_numbers := array_to_string(v_existing_numbers || v_shipping_number, '、');
      if char_length(v_updated_numbers) > 200 then
        raise exception 'Daily shipping number cannot exceed 200 characters';
      end if;
      update public.business_orders bo
      set daily_shipping_number = v_updated_numbers
      where bo.id = p_order_id;
    end if;
  end if;
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
$function$;

CREATE OR REPLACE FUNCTION public.save_daily_order_commission(p_workflow_id uuid, p_commission_amount numeric, p_commission_currency currency_code, p_remarks text)
 RETURNS finance_daily_order_commissions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor public.profiles%rowtype; v_wf public.finance_daily_order_workflows%rowtype; v_row public.finance_daily_order_commissions%rowtype;
begin
  v_actor := public.assert_daily_order_finance_actor();
  select * into v_wf from public.finance_daily_order_workflows where id = p_workflow_id for update;
  if not found then raise exception 'Workflow does not exist'; end if;
  if v_wf.status <> 'approved' then raise exception 'Commission can only be recorded after performance approval'; end if;
  if p_commission_amount is null or p_commission_amount < 0 or p_commission_amount > 999999999999 or p_commission_amount <> round(p_commission_amount, 4) then
    raise exception 'Commission amount must be non-negative and within 2 decimal places';
  end if;
  if p_commission_currency::text not in ('CNY', 'USD') then raise exception 'Unsupported commission currency'; end if;
  if char_length(coalesce(p_remarks, '')) > 2000 then raise exception 'Remarks are too long'; end if;

  insert into public.finance_daily_order_commissions(workflow_id, commission_amount, commission_currency, remarks, created_by, updated_by)
    values (p_workflow_id, p_commission_amount, p_commission_currency, nullif(btrim(p_remarks), ''), v_actor.id, v_actor.id)
  on conflict (workflow_id) do update set
    commission_amount = excluded.commission_amount,
    commission_currency = excluded.commission_currency,
    remarks = excluded.remarks,
    updated_by = v_actor.id
  returning * into v_row;
  perform public.write_daily_order_workflow_audit(
    p_workflow_id, 'commission_saved', v_actor.id,
    jsonb_build_object('amount', p_commission_amount, 'currency', p_commission_currency::text)
  );
  return v_row;
end;
$function$;

CREATE OR REPLACE FUNCTION public.adjust_business_order_items(p_order_id uuid, p_expected_version integer, p_items jsonb, p_reason_type text, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_idempotency public.business_rpc_idempotency%rowtype;
  v_item jsonb;
  v_existing public.business_order_items%rowtype;
  v_next public.business_order_items%rowtype;
  v_product public.products%rowtype;
  v_custom_product public.business_custom_products%rowtype;
  v_custom_version public.business_custom_product_versions%rowtype;
  v_requested_id uuid;
  v_action text;
  v_source_type text;
  v_product_id uuid;
  v_custom_product_id uuid;
  v_custom_version_id uuid;
  v_quantity numeric;
  v_unit_price numeric;
  v_line_amount numeric;
  v_net_shipped numeric;
  v_daily_active boolean;
  v_daily_category text;
  v_product_received numeric;
  v_product_received_overridden boolean;
  v_logistics_fee numeric;
  v_sales_total numeric;
  v_sales_total_overridden boolean;
  v_sort_order int;
  v_changes jsonb := '[]'::jsonb;
  v_subtotal_before numeric(18,4);
  v_total_before numeric(18,4);
  v_subtotal_after numeric(18,4);
  v_product_sum numeric;
  v_shipping_sum numeric;
  v_total_product numeric;
  v_total_shipping numeric;
  v_total_sales numeric;
  v_revision public.business_order_amount_revisions%rowtype;
  v_hash text;
  v_old jsonb;
  v_new jsonb;
  v_result jsonb;
  v_needs_resubmit boolean;
begin
  perform set_config('app.adjust_business_order_items_rpc', 'true', true);

  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved' then
    raise exception 'Approved account required';
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
  v_needs_resubmit := v_actor.role::text in ('sales', 'supervisor');
  if v_needs_resubmit then
    if v_order.status::text <> 'approved' or v_order.approval_status <> 'approved' then
      raise exception 'Only approved orders can be adjusted by sales; edit the draft instead';
    end if;
    if v_order.salesperson_id is distinct from v_uid then
      raise exception 'Sales user cannot adjust another owner business order';
    end if;
  end if;

  -- 订单是否已启用日字段（实收）口径；未启用的订单追加行不写日字段，
  -- 否则 total_*_received 单独置值会违反 daily_fields_complete_check。
  v_daily_active := v_order.total_product_received_amount is not null;

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

    if v_requested_id is not null then
      select * into v_existing from public.business_order_items
      where id = v_requested_id and order_id = p_order_id for update;
      if not found then raise exception 'Order item id does not belong to order'; end if;

      v_action := coalesce(nullif(v_item->>'action', ''), 'upsert');
      if v_action = 'delete' then
        if v_existing.origin <> 'append' then
          raise exception 'Only appended order items can be deleted';
        end if;
        if exists (select 1 from public.business_order_shipment_items si
                   where si.order_item_id = v_existing.id)
           or exists (select 1 from public.business_order_return_items ri
                      where ri.order_item_id = v_existing.id) then
          raise exception 'Order item with shipment or return activity cannot be deleted';
        end if;
        if exists (select 1 from public.business_order_payment_allocations pa
                   where pa.order_item_id = v_existing.id) then
          raise exception 'Order item with payment allocations cannot be deleted';
        end if;
        delete from public.business_order_items where id = v_existing.id;
        v_changes := v_changes || jsonb_build_array(jsonb_build_object(
          'kind', 'deleted',
          'order_item_id', v_existing.id,
          'name_snapshot', v_existing.name_snapshot,
          'unit_snapshot', v_existing.unit_snapshot,
          'unit_price', v_existing.unit_price,
          'quantity_before', v_existing.quantity,
          'quantity_after', 0,
          'product_received_amount', v_existing.product_received_amount,
          'logistics_fee_amount', v_existing.logistics_fee_amount,
          'sales_total_amount', v_existing.sales_total_amount
        ));
      elsif v_action = 'upsert' then
        if v_existing.origin <> 'append' then
          raise exception 'Only appended order items can be modified';
        end if;
        v_quantity := round((v_item->>'quantity')::numeric, 4);
        if v_quantity is null or v_quantity <= 0 or v_quantity > 999999999999 then
          raise exception 'Quantity is invalid';
        end if;
        select public.business_order_item_net_shipped(v_existing.id) into v_net_shipped;
        if v_quantity < v_net_shipped then
          raise exception 'Quantity cannot be below net shipped quantity %', v_net_shipped;
        end if;
        if v_item ? 'unit_price' then
          v_unit_price := round((v_item->>'unit_price')::numeric, 4);
          if v_unit_price is null or v_unit_price < 0 or v_unit_price > 999999999999 then
            raise exception 'Unit price is invalid';
          end if;
        else
          v_unit_price := v_existing.unit_price;
        end if;
        if (v_product_id is not null and v_product_id is distinct from v_existing.product_id)
           or (v_custom_product_id is not null
               and v_custom_product_id is distinct from v_existing.custom_product_id)
           or (v_custom_version_id is not null
               and v_custom_version_id is distinct from v_existing.custom_product_version_id) then
          raise exception 'Order item product cannot be replaced by an adjustment';
        end if;

        v_line_amount := round(v_quantity * v_unit_price, 4);
        v_daily_category := v_existing.daily_shipping_category;
        v_product_received := v_existing.product_received_amount;
        v_product_received_overridden := v_existing.product_received_overridden;
        v_logistics_fee := v_existing.logistics_fee_amount;
        v_sales_total := v_existing.sales_total_amount;
        v_sales_total_overridden := v_existing.sales_total_overridden;
        if v_daily_active and v_item ? 'daily_shipping_category' then
          v_daily_category := nullif(v_item->>'daily_shipping_category', '');
        end if;
        if v_daily_category is not null
           and v_daily_category not in ('stock', 'sample', 'custom_sample', 'custom', 'purchase') then
          raise exception 'Daily shipping category is invalid';
        end if;
        if v_daily_active and v_item ? 'product_received_amount' then
          v_product_received := round((v_item->>'product_received_amount')::numeric, 4);
          if v_product_received is null or v_product_received < 0
             or v_product_received > 999999999999 then
            raise exception 'Product received amount is invalid';
          end if;
          v_product_received_overridden := case when v_item ? 'product_received_overridden'
            then (v_item->>'product_received_overridden')::boolean
            else round(v_product_received, 4) is distinct from v_line_amount end;
          if not v_product_received_overridden then
            v_product_received := v_line_amount;
          end if;
        end if;
        if v_daily_active and v_item ? 'logistics_fee_amount' then
          v_logistics_fee := round((v_item->>'logistics_fee_amount')::numeric, 4);
          if v_logistics_fee is null or v_logistics_fee < 0
             or v_logistics_fee > 999999999999 then
            raise exception 'Logistics fee amount is invalid';
          end if;
        end if;
        if v_daily_active and v_item ? 'sales_total_amount' then
          v_sales_total := round((v_item->>'sales_total_amount')::numeric, 4);
          if v_sales_total is null or v_sales_total < 0 or v_sales_total > 999999999999 then
            raise exception 'Sales total amount is invalid';
          end if;
          v_sales_total_overridden := case when v_item ? 'sales_total_overridden'
            then (v_item->>'sales_total_overridden')::boolean
            else round(v_sales_total, 4)
                 is distinct from round(coalesce(v_product_received, 0)
                                       + coalesce(v_logistics_fee, 0), 4) end;
          if not v_sales_total_overridden then
            v_sales_total := round(coalesce(v_product_received, 0)
                                 + coalesce(v_logistics_fee, 0), 4);
          end if;
        end if;

        if v_quantity is distinct from v_existing.quantity
           or v_unit_price is distinct from v_existing.unit_price
           or v_daily_category is distinct from v_existing.daily_shipping_category::text
           or v_product_received is distinct from v_existing.product_received_amount
           or v_product_received_overridden
              is distinct from v_existing.product_received_overridden
           or v_logistics_fee is distinct from v_existing.logistics_fee_amount
           or v_sales_total is distinct from v_existing.sales_total_amount
           or v_sales_total_overridden is distinct from v_existing.sales_total_overridden then
          update public.business_order_items set
            quantity = v_quantity,
            unit_price = v_unit_price,
            daily_shipping_category = v_daily_category::public.daily_order_shipping_category,
            product_received_amount = v_product_received,
            product_received_overridden = v_product_received_overridden,
            logistics_fee_amount = v_logistics_fee,
            sales_total_amount = v_sales_total,
            sales_total_overridden = v_sales_total_overridden,
            updated_at = now()
          where id = v_existing.id
          returning * into v_next;
          v_changes := v_changes || jsonb_build_array(jsonb_build_object(
            'kind', 'updated',
            'order_item_id', v_next.id,
            'name_snapshot', v_next.name_snapshot,
            'unit_snapshot', v_next.unit_snapshot,
            'quantity_before', v_existing.quantity,
            'quantity_after', v_next.quantity,
            'unit_price_before', v_existing.unit_price,
            'unit_price_after', v_next.unit_price,
            'daily_before', jsonb_build_object(
              'daily_shipping_category', v_existing.daily_shipping_category,
              'product_received_amount', v_existing.product_received_amount,
              'product_received_overridden', v_existing.product_received_overridden,
              'logistics_fee_amount', v_existing.logistics_fee_amount,
              'sales_total_amount', v_existing.sales_total_amount,
              'sales_total_overridden', v_existing.sales_total_overridden
            ),
            'daily_after', jsonb_build_object(
              'daily_shipping_category', v_next.daily_shipping_category,
              'product_received_amount', v_next.product_received_amount,
              'product_received_overridden', v_next.product_received_overridden,
              'logistics_fee_amount', v_next.logistics_fee_amount,
              'sales_total_amount', v_next.sales_total_amount,
              'sales_total_overridden', v_next.sales_total_overridden
            )
          ));
        end if;
      else
        raise exception 'Invalid adjustment action';
      end if;
    else
      v_quantity := round((v_item->>'quantity')::numeric, 4);
      if v_quantity is null or v_quantity <= 0 or v_quantity > 999999999999 then
        raise exception 'Quantity is invalid';
      end if;
      v_unit_price := round((v_item->>'unit_price')::numeric, 4);
      if v_unit_price is null or v_unit_price < 0 or v_unit_price > 999999999999 then
        raise exception 'Unit price is invalid';
      end if;
      v_line_amount := round(v_quantity * v_unit_price, 4);

      -- 日字段：与建单同口径。订单未启用日字段时追加行不写，保持全 NULL。
      v_daily_category := null;
      v_product_received := null;
      v_product_received_overridden := false;
      v_logistics_fee := null;
      v_sales_total := null;
      v_sales_total_overridden := false;
      if v_daily_active then
        v_daily_category := nullif(v_item->>'daily_shipping_category', '');
        if v_daily_category is not null
           and v_daily_category not in ('stock', 'sample', 'custom_sample', 'custom', 'purchase') then
          raise exception 'Daily shipping category is invalid';
        end if;
        if v_item ? 'product_received_amount' then
          v_product_received := round((v_item->>'product_received_amount')::numeric, 4);
          if v_product_received is null or v_product_received < 0
             or v_product_received > 999999999999 then
            raise exception 'Product received amount is invalid';
          end if;
          v_product_received_overridden := case when v_item ? 'product_received_overridden'
            then (v_item->>'product_received_overridden')::boolean
            else round(v_product_received, 4) is distinct from v_line_amount end;
          if not v_product_received_overridden then
            v_product_received := v_line_amount;
          end if;
        else
          v_product_received := v_line_amount;
          v_product_received_overridden := false;
        end if;
        if v_item ? 'logistics_fee_amount' then
          v_logistics_fee := round((v_item->>'logistics_fee_amount')::numeric, 4);
          if v_logistics_fee is null or v_logistics_fee < 0
             or v_logistics_fee > 999999999999 then
            raise exception 'Logistics fee amount is invalid';
          end if;
        else
          v_logistics_fee := 0;
        end if;
        if v_item ? 'sales_total_amount' then
          v_sales_total := round((v_item->>'sales_total_amount')::numeric, 4);
          if v_sales_total is null or v_sales_total < 0 or v_sales_total > 999999999999 then
            raise exception 'Sales total amount is invalid';
          end if;
          v_sales_total_overridden := case when v_item ? 'sales_total_overridden'
            then (v_item->>'sales_total_overridden')::boolean
            else round(v_sales_total, 4)
                 is distinct from round(v_product_received + v_logistics_fee, 4) end;
          if not v_sales_total_overridden then
            v_sales_total := round(v_product_received + v_logistics_fee, 4);
          end if;
        else
          v_sales_total := round(v_product_received + v_logistics_fee, 4);
          v_sales_total_overridden := false;
        end if;
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
        if not found then
          raise exception 'Product does not exist';
        end if;
        insert into public.business_order_items (
          order_id, source_type, product_id, sku_snapshot, name_snapshot,
          description_snapshot, specification_snapshot, unit_snapshot,
          image_url_snapshot, quantity, unit_price, sort_order, origin,
          daily_shipping_category, product_received_amount, product_received_overridden,
          logistics_fee_amount, sales_total_amount, sales_total_overridden
        ) values (
          p_order_id, 'catalog', v_product.id, v_product.sku, v_product.name,
          v_product.description, v_product.specification, v_product.unit,
          v_product.image_url, v_quantity, v_unit_price, v_sort_order, 'append',
          v_daily_category::public.daily_order_shipping_category,
          v_product_received, v_product_received_overridden,
          v_logistics_fee, v_sales_total, v_sales_total_overridden
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
        insert into public.business_order_items (
          order_id, source_type, custom_product_id, custom_product_version_id,
          sku_snapshot, name_snapshot, description_snapshot, specification_snapshot,
          unit_snapshot, image_url_snapshot, quantity, unit_price, sort_order, origin,
          daily_shipping_category, product_received_amount, product_received_overridden,
          logistics_fee_amount, sales_total_amount, sales_total_overridden
        ) values (
          p_order_id, 'custom', v_custom_product.id, v_custom_version.id,
          v_custom_version.code, v_custom_version.name, v_custom_version.description,
          v_custom_version.specification, v_custom_version.unit, v_custom_version.image_url,
          v_quantity, v_unit_price, v_sort_order, 'append',
          v_daily_category::public.daily_order_shipping_category,
          v_product_received, v_product_received_overridden,
          v_logistics_fee, v_sales_total, v_sales_total_overridden
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
        'quantity_after', v_existing.quantity,
        'daily_shipping_category', v_existing.daily_shipping_category,
        'product_received_amount', v_existing.product_received_amount,
        'product_received_overridden', v_existing.product_received_overridden,
        'logistics_fee_amount', v_existing.logistics_fee_amount,
        'sales_total_amount', v_existing.sales_total_amount,
        'sales_total_overridden', v_existing.sales_total_overridden
      ));
      v_sort_order := v_sort_order + 1;
    end if;
  end loop;

  if jsonb_array_length(v_changes) = 0 then
    raise exception 'Adjustment does not change the order';
  end if;

  select coalesce(sum(i.line_amount), 0) into v_subtotal_after
  from public.business_order_items i where i.order_id = p_order_id;

  -- 实收口径重算：覆盖标记为真的合计保持手工值，其余按行求和；
  -- 实收总额始终=产品实收+运费实收。
  if v_daily_active then
    select coalesce(sum(i.product_received_amount), 0),
           coalesce(sum(i.logistics_fee_amount), 0)
      into v_product_sum, v_shipping_sum
    from public.business_order_items i where i.order_id = p_order_id;
    v_total_product := case when v_order.total_product_received_overridden
      then v_order.total_product_received_amount else v_product_sum end;
    v_total_shipping := case when v_order.total_shipping_received_overridden
      then v_order.total_shipping_received_amount else v_shipping_sum end;
    v_total_sales := case when v_order.total_sales_overridden
      then v_order.total_sales_amount
      else round(v_total_product + v_total_shipping, 4) end;
  end if;

  if v_needs_resubmit then
    update public.business_orders bo set
      items_subtotal = v_subtotal_after,
      total_amount = v_subtotal_after + bo.shipping_fee,
      total_product_received_amount = case when v_daily_active
        then v_total_product else bo.total_product_received_amount end,
      total_shipping_received_amount = case when v_daily_active
        then v_total_shipping else bo.total_shipping_received_amount end,
      total_sales_amount = case when v_daily_active
        then v_total_sales else bo.total_sales_amount end,
      status = 'submitted',
      approval_status = 'submitted',
      submitted_by = v_uid,
      submitted_at = now(),
      version = bo.version + 1
    where bo.id = p_order_id;
  else
    update public.business_orders bo set
      items_subtotal = v_subtotal_after,
      total_amount = v_subtotal_after + bo.shipping_fee,
      total_product_received_amount = case when v_daily_active
        then v_total_product else bo.total_product_received_amount end,
      total_shipping_received_amount = case when v_daily_active
        then v_total_shipping else bo.total_shipping_received_amount end,
      total_sales_amount = case when v_daily_active
        then v_total_sales else bo.total_sales_amount end,
      version = bo.version + 1
    where bo.id = p_order_id;
  end if;

  perform public.business_refresh_order_fulfillment_status(p_order_id);
  perform public.business_refresh_order_payment_status(p_order_id);
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
    v_order.id, 'order', v_order.id, 'update',
    (v_old->>'status')::public.business_order_status,
    v_order.status,
    v_old, v_new, p_reason, v_uid
  );
  if v_needs_resubmit then
    perform public.write_business_order_audit(
      v_order.id, 'order', v_order.id, 'submit',
      'approved', 'submitted',
      v_old, v_new, '加单后自动重新提交审核', v_uid
    );
  end if;

  v_result := jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'version', v_order.version,
    'items_subtotal', v_order.items_subtotal,
    'total_amount', v_order.total_amount,
    'total_product_received_amount', v_order.total_product_received_amount,
    'total_shipping_received_amount', v_order.total_shipping_received_amount,
    'total_sales_amount', v_order.total_sales_amount,
    'payment_status', v_order.payment_status,
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
$function$;

CREATE OR REPLACE FUNCTION public.business_write_order_amount_revision(p_order_id uuid, p_reason_type text, p_items_subtotal_before numeric, p_items_subtotal_after numeric, p_total_amount_before numeric, p_total_amount_after numeric, p_detail jsonb, p_reason text, p_actor_id uuid)
 RETURNS business_order_amount_revisions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    round(p_items_subtotal_before, 4), round(p_items_subtotal_after, 4),
    round(p_total_amount_before, 4), round(p_total_amount_after, 4),
    coalesce(p_detail, '{}'::jsonb),
    nullif(btrim(p_reason), ''),
    p_actor_id,
    coalesce(nullif(btrim(v_actor.chinese_name), ''), v_actor.full_name)
  ) returning * into v_revision;

  return v_revision;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_business_order_v4(p_customer_id uuid, p_order_date date, p_fulfillment_type business_fulfillment_type, p_currency currency_code, p_exchange_rate_to_cny numeric, p_shipping_fee numeric, p_tracking_number text, p_sales_notes text, p_items jsonb, p_payment_due_date date, p_shop_id uuid, p_salesperson_id uuid, p_external_order_number text, p_daily_shipping_date date, p_daily_shipping_number text, p_daily_payment_category daily_order_payment_category, p_total_product_received_amount numeric, p_total_product_received_overridden boolean, p_total_shipping_received_amount numeric, p_total_shipping_received_overridden boolean, p_total_sales_amount numeric, p_total_sales_overridden boolean, p_receivable_received_difference_reason text)
 RETURNS TABLE(id uuid, order_number text, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  if round(v_order.total_amount, 4) = round(v_order.total_sales_amount, 4) then
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
$function$;

CREATE OR REPLACE FUNCTION public.update_business_order_v4(p_order_id uuid, p_expected_version integer, p_customer_id uuid, p_order_date date, p_fulfillment_type business_fulfillment_type, p_currency currency_code, p_exchange_rate_to_cny numeric, p_shipping_fee numeric, p_tracking_number text, p_sales_notes text, p_items jsonb, p_payment_due_date date, p_reason text, p_shop_id uuid, p_salesperson_id uuid, p_external_order_number text, p_daily_shipping_date date, p_daily_shipping_number text, p_daily_payment_category daily_order_payment_category, p_total_product_received_amount numeric, p_total_product_received_overridden boolean, p_total_shipping_received_amount numeric, p_total_shipping_received_overridden boolean, p_total_sales_amount numeric, p_total_sales_overridden boolean, p_receivable_received_difference_reason text)
 RETURNS TABLE(id uuid, order_number text, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v_updated record;
  v_order public.business_orders%rowtype;
  v_old_reason text;
  v_reason text := nullif(regexp_replace(
    coalesce(p_receivable_received_difference_reason, ''),
    '^[[:space:]]+|[[:space:]]+$',
    '',
    'g'
  ), '');
  v_audit_reason text;
begin
  if char_length(coalesce(p_receivable_received_difference_reason, '')) > 1000 then
    raise exception 'Receivable and received amount difference reason cannot exceed 1000 characters';
  end if;

  v_audit_reason := coalesce(nullif(btrim(p_reason), ''), v_reason);

  select * into v_updated
  from public.update_business_order_v3(
    p_order_id, p_expected_version, p_customer_id, p_order_date,
    p_fulfillment_type, p_currency, p_exchange_rate_to_cny, p_shipping_fee,
    p_tracking_number, p_sales_notes, p_items, p_payment_due_date,
    v_audit_reason, p_shop_id, p_salesperson_id, p_external_order_number,
    p_daily_shipping_date, p_daily_shipping_number, p_daily_payment_category,
    p_total_product_received_amount, p_total_product_received_overridden,
    p_total_shipping_received_amount, p_total_shipping_received_overridden,
    p_total_sales_amount, p_total_sales_overridden
  );

  select * into v_order
  from public.business_orders bo
  where bo.id = v_updated.id
  for update;

  v_old_reason := v_order.receivable_received_difference_reason;
  if round(v_order.total_amount, 4) = round(v_order.total_sales_amount, 4) then
    v_reason := null;
  end if;

  update public.business_orders bo
  set receivable_received_difference_reason = v_reason
  where bo.id = v_order.id
  returning * into v_order;

  if v_old_reason is distinct from v_reason then
    perform public.write_business_order_audit(
      v_order.id,
      'order',
      v_order.id,
      'update',
      v_order.status,
      v_order.status,
      jsonb_build_object('receivable_received_difference_reason', v_old_reason),
      jsonb_build_object(
        'total_amount', v_order.total_amount,
        'total_sales_amount', v_order.total_sales_amount,
        'receivable_received_difference_reason', v_reason
      ),
      coalesce(v_audit_reason, '应收实收差额已归零'),
      v_uid
    );
  end if;

  return query select v_updated.id, v_updated.order_number, v_updated.version;
end;
$function$;

CREATE OR REPLACE FUNCTION public.add_business_custom_product_version(p_custom_product_id uuid, p_product_group_id uuid, p_code text, p_name text, p_description text, p_specification text, p_unit text, p_image_url text, p_default_unit_price numeric, p_default_currency currency_code, p_quantity numeric, p_received_amount numeric)
 RETURNS business_custom_product_versions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  if p_product_group_id is null or not exists (
    select 1 from public.product_groups where id = p_product_group_id
  ) then
    raise exception 'Product group does not exist';
  end if;
  if char_length(btrim(coalesce(p_code, ''))) > 100 then
    raise exception 'Custom product code cannot exceed 100 characters';
  end if;
  if nullif(btrim(p_name), '') is null or char_length(btrim(p_name)) > 300 then
    raise exception 'Custom product name is required and cannot exceed 300 characters';
  end if;
  if char_length(btrim(coalesce(p_unit, ''))) > 100 then
    raise exception 'Custom product unit cannot exceed 100 characters';
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
  if p_default_currency is null then
    raise exception 'Default currency is required';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 999999999999 then
    raise exception 'Custom product quantity is invalid';
  end if;
  if round(round(p_quantity, 4) * round(p_default_unit_price, 4), 4)
     > 9999999999999999.99 then
    raise exception 'Custom product order amount is invalid';
  end if;
  if p_received_amount is not null and (
    p_received_amount < 0 or p_received_amount > 999999999999
  ) then
    raise exception 'Custom product received amount is invalid';
  end if;

  select coalesce(max(version_no), 0) + 1 into v_version_no
  from public.business_custom_product_versions
  where custom_product_id = v_product.id;

  insert into public.business_custom_product_versions (
    custom_product_id, version_no, product_group_id, code, name, description,
    specification, unit, image_url, default_unit_price, default_currency,
    quantity, received_amount, created_by
  ) values (
    v_product.id, v_version_no, p_product_group_id,
    btrim(coalesce(p_code, '')), btrim(p_name),
    nullif(btrim(p_description), ''), nullif(btrim(p_specification), ''),
    btrim(coalesce(p_unit, '')), nullif(btrim(p_image_url), ''), p_default_unit_price,
    p_default_currency, round(p_quantity, 4),
    case when p_received_amount is null then null else round(p_received_amount, 4) end,
    v_uid
  ) returning * into v_version;

  update public.business_custom_products set updated_by = v_uid where id = v_product.id;

  perform public.write_business_lifecycle_audit(
    null, null, 'custom_product_version', v_version.id,
    'version_create', null, to_jsonb(v_version), null, v_uid
  );

  return v_version;
end;
$function$;

CREATE OR REPLACE FUNCTION public.update_business_order_v4(p_order_id uuid, p_expected_version integer, p_customer_id uuid, p_order_date date, p_fulfillment_type business_fulfillment_type, p_currency currency_code, p_exchange_rate_to_cny numeric, p_shipping_fee numeric, p_tracking_number text, p_sales_notes text, p_items jsonb, p_payment_due_date date, p_reason text, p_shop_id uuid, p_salesperson_id uuid, p_external_order_number text, p_daily_shipping_date date, p_daily_shipping_number text, p_daily_payment_category daily_order_payment_category, p_total_product_received_amount numeric, p_total_product_received_overridden boolean, p_total_shipping_received_amount numeric, p_total_shipping_received_overridden boolean, p_total_sales_amount numeric, p_total_sales_overridden boolean, p_receivable_received_difference_reason text, p_payment_account text)
 RETURNS TABLE(id uuid, order_number text, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_updated record;
  v_order public.business_orders%rowtype;
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
  if char_length(coalesce(p_payment_account, '')) > 200 then
    raise exception 'Payment account cannot exceed 200 characters';
  end if;

  select * into v_actor from public.profiles p where p.id = v_uid;

  select * into v_updated
  from public.update_business_order_v3(
    p_order_id, p_expected_version, p_customer_id, p_order_date, p_fulfillment_type,
    p_currency, p_exchange_rate_to_cny, p_shipping_fee, p_tracking_number,
    p_sales_notes, p_items, p_payment_due_date, p_reason, p_shop_id,
    p_salesperson_id, p_external_order_number, p_daily_shipping_date,
    p_daily_shipping_number, p_daily_payment_category, p_total_product_received_amount,
    p_total_product_received_overridden, p_total_shipping_received_amount,
    p_total_shipping_received_overridden, p_total_sales_amount,
    p_total_sales_overridden
  );

  select * into v_order
  from public.business_orders bo
  where bo.id = v_updated.id
  for update;

  update public.business_orders bo
  set payment_account = nullif(btrim(p_payment_account), '')
  where bo.id = v_order.id
  returning * into v_order;

  if round(v_order.total_amount, 4) = round(v_order.total_sales_amount, 4) then
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

  return query select v_order.id, v_order.order_number, v_order.version;
end;
$function$;

CREATE OR REPLACE FUNCTION public.apply_business_order_daily_entry_v2(p_order_id uuid, p_shop_id uuid, p_salesperson_id uuid, p_external_order_number text, p_daily_shipping_date date, p_daily_shipping_number text, p_daily_payment_category daily_order_payment_category, p_total_product_received_amount numeric, p_total_product_received_overridden boolean, p_total_shipping_received_amount numeric, p_total_shipping_received_overridden boolean, p_total_sales_amount numeric, p_total_sales_overridden boolean, p_items jsonb, p_actor_id uuid, p_is_create boolean, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_product_sum numeric(18,4) := 0;
  v_shipping_sum numeric(18,4) := 0;
  v_sales_sum numeric(18,4) := 0;
  v_effective_product_total numeric(18,4);
  v_effective_shipping_total numeric(18,4);
  v_effective_sales_total numeric(18,4);
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
     or p_total_product_received_amount <> round(p_total_product_received_amount, 4)
     or p_total_shipping_received_amount < 0
     or p_total_shipping_received_amount > 999999999999
     or p_total_shipping_received_amount <> round(p_total_shipping_received_amount, 4)
     or p_total_sales_amount < 0
     or p_total_sales_amount > 999999999999
     or p_total_sales_amount <> round(p_total_sales_amount, 4) then
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
    if v_item->>'daily_shipping_category' not in ('stock', 'sample', 'custom_sample', 'custom', 'purchase') then
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
       or v_product_amount <> round(v_product_amount, 4)
       or v_logistics_amount < 0 or v_logistics_amount > 999999999999
       or v_logistics_amount <> round(v_logistics_amount, 4)
       or v_sales_amount < 0 or v_sales_amount > 999999999999
       or v_sales_amount <> round(v_sales_amount, 4) then
      raise exception 'Daily order item amounts must be non-negative and within 2 decimal places';
    end if;

    select * into v_order_item
    from public.business_order_items i
    where i.order_id = p_order_id and i.sort_order = v_sort_order
    for update;
    if not found then raise exception 'Daily order item does not match business order item'; end if;

    if not v_product_overridden then
      v_product_amount := round(v_order_item.quantity * v_order_item.unit_price, 4);
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
$function$;

CREATE OR REPLACE FUNCTION public.create_business_order_v5(p_customer_id uuid, p_order_date date, p_fulfillment_type business_fulfillment_type, p_currency currency_code, p_exchange_rate_to_cny numeric, p_shipping_fee numeric, p_tracking_number text, p_sales_notes text, p_items jsonb, p_payment_due_date date, p_shop_id uuid, p_salesperson_id uuid, p_external_order_number text, p_daily_shipping_date date, p_daily_shipping_number text, p_daily_payment_category daily_order_payment_category, p_total_product_received_amount numeric, p_total_product_received_overridden boolean, p_total_shipping_received_amount numeric, p_total_shipping_received_overridden boolean, p_total_sales_amount numeric, p_total_sales_overridden boolean, p_receivable_received_difference_reason text, p_payment_account text)
 RETURNS TABLE(id uuid, order_number text, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if char_length(coalesce(p_payment_account, '')) > 200 then
    raise exception 'Payment account cannot exceed 200 characters';
  end if;

  select * into v_actor from public.profiles p where p.id = v_uid;

  select * into v_created
  from public.create_business_order_v2(
    p_customer_id, p_order_date, p_fulfillment_type, p_currency,
    p_exchange_rate_to_cny, p_shipping_fee, p_tracking_number, p_sales_notes,
    p_items, p_payment_due_date
  );

  perform public.apply_business_order_daily_entry_v2(
    v_created.id, p_shop_id, p_salesperson_id, p_external_order_number,
    p_daily_shipping_date, p_daily_shipping_number, p_daily_payment_category,
    p_total_product_received_amount, p_total_product_received_overridden,
    p_total_shipping_received_amount, p_total_shipping_received_overridden,
    p_total_sales_amount, p_total_sales_overridden, p_items, v_uid, true,
    'Set daily-order fields during V5 creation'
  );

  select * into v_order
  from public.business_orders bo
  where bo.id = v_created.id
  for update;

  update public.business_orders bo
  set payment_account = nullif(btrim(p_payment_account), '')
  where bo.id = v_order.id
  returning * into v_order;

  if round(v_order.total_amount, 4) = round(v_order.total_sales_amount, 4) then
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
$function$;

CREATE OR REPLACE FUNCTION public.update_business_order_v5(p_order_id uuid, p_expected_version integer, p_customer_id uuid, p_order_date date, p_fulfillment_type business_fulfillment_type, p_currency currency_code, p_exchange_rate_to_cny numeric, p_shipping_fee numeric, p_tracking_number text, p_sales_notes text, p_items jsonb, p_payment_due_date date, p_reason text, p_shop_id uuid, p_salesperson_id uuid, p_external_order_number text, p_daily_shipping_date date, p_daily_shipping_number text, p_daily_payment_category daily_order_payment_category, p_total_product_received_amount numeric, p_total_product_received_overridden boolean, p_total_shipping_received_amount numeric, p_total_shipping_received_overridden boolean, p_total_sales_amount numeric, p_total_sales_overridden boolean, p_receivable_received_difference_reason text, p_payment_account text)
 RETURNS TABLE(id uuid, order_number text, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v_updated record;
  v_order public.business_orders%rowtype;
  v_reason text := nullif(regexp_replace(
    coalesce(p_receivable_received_difference_reason, ''),
    '^[[:space:]]+|[[:space:]]+$',
    '',
    'g'
  ), '');
begin
  perform set_config('app.adjust_business_order_items_rpc', 'true', true);

  if char_length(coalesce(p_receivable_received_difference_reason, '')) > 1000 then
    raise exception 'Receivable and received amount difference reason cannot exceed 1000 characters';
  end if;
  if char_length(coalesce(p_payment_account, '')) > 200 then
    raise exception 'Payment account cannot exceed 200 characters';
  end if;

  select * into v_updated
  from public.update_business_order_v2(
    p_order_id, p_expected_version, p_customer_id, p_order_date, p_fulfillment_type,
    p_currency, p_exchange_rate_to_cny, p_shipping_fee, p_tracking_number,
    p_sales_notes, p_items, p_payment_due_date, p_reason
  );

  perform public.apply_business_order_daily_entry_v2(
    v_updated.id, p_shop_id, p_salesperson_id, p_external_order_number,
    p_daily_shipping_date, p_daily_shipping_number, p_daily_payment_category,
    p_total_product_received_amount, p_total_product_received_overridden,
    p_total_shipping_received_amount, p_total_shipping_received_overridden,
    p_total_sales_amount, p_total_sales_overridden, p_items, v_uid, false, p_reason
  );

  select * into v_order
  from public.business_orders bo
  where bo.id = v_updated.id
  for update;

  update public.business_orders bo
  set payment_account = nullif(btrim(p_payment_account), '')
  where bo.id = v_order.id
  returning * into v_order;

  if round(v_order.total_amount, 4) = round(v_order.total_sales_amount, 4) then
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

  return query select v_order.id, v_order.order_number, v_order.version;
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_business_customer_transfer_v2(p_customer_id uuid, p_order_id uuid, p_currency currency_code, p_amount numeric, p_exchange_rate_to_cny numeric, p_received_at timestamp with time zone, p_payment_type business_payment_type, p_proof_path text, p_notes text, p_correction_reason text, p_idempotency_key text, p_allocations jsonb, p_extra_proof_paths jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_transfer public.business_customer_transfers%rowtype;
  v_existing public.business_customer_transfers%rowtype;
  v_idempotency public.business_rpc_idempotency%rowtype;
  v_rate numeric;
  v_hash text;
  v_allocations jsonb;
  v_result jsonb;
  v_extra_proof_paths text[] := '{}'::text[];
  v_path text;
begin
  select * into v_actor from public.profiles where id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved business role required';
  end if;
  if (p_customer_id is null) = (p_order_id is null) then
    raise exception 'Transfer requires exactly one of customer or order';
  end if;

  if p_customer_id is not null then
    if not public.can_manage_business_customer(p_customer_id) then
      raise exception 'Customer is not manageable by current user';
    end if;
  else
    select * into v_order from public.business_orders bo where bo.id = p_order_id for update;
    if not found then
      raise exception 'Business order does not exist';
    end if;
    if v_order.customer_id is not null then
      raise exception 'Order already has a customer; record the transfer on the customer';
    end if;
    if v_order.closed_at is not null then
      raise exception 'Closed business order cannot receive transfers';
    end if;
    if not public.can_manage_business_order_payments(p_order_id) then
      raise exception 'Business order is not manageable by current user';
    end if;
    if v_order.currency is distinct from p_currency then
      raise exception 'Transfer currency does not match order currency';
    end if;
    if p_allocations is null or jsonb_typeof(p_allocations) <> 'array'
       or jsonb_array_length(p_allocations) < 1 then
      raise exception 'Order transfer must be allocated to its own order';
    end if;
  end if;

  if p_amount is null or round(p_amount, 4) <= 0 or round(p_amount, 4) > 999999999999 then
    raise exception 'Transfer amount is invalid';
  end if;
  if p_exchange_rate_to_cny is not null and (
       round(p_exchange_rate_to_cny, 8) <= 0
       or round(p_exchange_rate_to_cny, 8) > 1000000
     ) then
    raise exception 'Exchange rate is invalid';
  end if;
  if p_currency::text = 'CNY' and p_exchange_rate_to_cny is not null
     and round(p_exchange_rate_to_cny, 8) <> 1 then
    raise exception 'CNY exchange rate must equal one';
  end if;
  -- CNY 留空按 1 落库，其余币种留空落 NULL。
  v_rate := case
    when p_currency::text = 'CNY' then round(coalesce(p_exchange_rate_to_cny, 1), 8)
    else round(p_exchange_rate_to_cny, 8)
  end;
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

  -- 首张凭证：留空（NULL/空白）表示未上传，改为合法输入。
  if nullif(btrim(coalesce(p_proof_path, '')), '') is null then
    p_proof_path := null;
  else
    if split_part(p_proof_path, '/', 1) <> v_uid::text then
      raise exception 'Invalid transfer proof path';
    end if;
    if p_customer_id is not null then
      if p_proof_path !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/customer/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
         or split_part(p_proof_path, '/', 2) <> 'customer'
         or split_part(p_proof_path, '/', 3) <> p_customer_id::text then
        raise exception 'Invalid transfer proof path';
      end if;
    else
      if p_proof_path !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/order/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
         or split_part(p_proof_path, '/', 2) <> 'order'
         or split_part(p_proof_path, '/', 3) <> p_order_id::text then
        raise exception 'Invalid transfer proof path';
      end if;
    end if;
    if not exists (
      select 1 from storage.objects so
      where so.bucket_id = 'business-payment-proofs' and so.name = p_proof_path
    ) then
      raise exception 'Transfer proof object does not exist';
    end if;
  end if;

  -- 附加凭证：逐张按首图同款规则校验，禁止与首图或彼此重复，合计最多 10 张。
  if p_extra_proof_paths is not null then
    if jsonb_typeof(p_extra_proof_paths) is distinct from 'array' then
      raise exception 'Invalid transfer proof path';
    end if;
    for v_path in
      select btrim(e.value #>> '{}')
      from jsonb_array_elements(p_extra_proof_paths) as e(value)
    loop
      if nullif(v_path, '') is null
         or split_part(v_path, '/', 1) <> v_uid::text
         or v_path is not distinct from coalesce(p_proof_path, '')
         or v_path = any (v_extra_proof_paths) then
        raise exception 'Invalid transfer proof path';
      end if;
      if p_customer_id is not null then
        if v_path !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/customer/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
           or split_part(v_path, '/', 2) <> 'customer'
           or split_part(v_path, '/', 3) <> p_customer_id::text then
          raise exception 'Invalid transfer proof path';
        end if;
      else
        if v_path !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/order/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
           or split_part(v_path, '/', 2) <> 'order'
           or split_part(v_path, '/', 3) <> p_order_id::text then
          raise exception 'Invalid transfer proof path';
        end if;
      end if;
      if not exists (
        select 1 from storage.objects so
        where so.bucket_id = 'business-payment-proofs' and so.name = v_path
      ) then
        raise exception 'Transfer proof object does not exist';
      end if;
      v_extra_proof_paths := v_extra_proof_paths || v_path;
    end loop;
    if array_length(v_extra_proof_paths, 1) > 9 then
      raise exception 'Transfer cannot have more than 10 proof images';
    end if;
  end if;

  v_hash := encode(digest(jsonb_build_object(
    'customer_id', p_customer_id, 'order_id', p_order_id,
    'currency', p_currency::text,
    'amount', round(p_amount, 4), 'exchange_rate_to_cny', v_rate,
    'received_at', p_received_at, 'payment_type', p_payment_type::text,
    'proof_path', p_proof_path, 'extra_proof_paths', to_jsonb(v_extra_proof_paths),
    'notes', nullif(btrim(p_notes), ''),
    'correction_reason', nullif(btrim(p_correction_reason), ''),
    'allocations', p_allocations
  )::text, 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    v_uid::text || ':record_business_customer_transfer_v2:' || btrim(p_idempotency_key), 0
  ));

  select * into v_idempotency
  from public.business_rpc_idempotency
  where actor_id = v_uid
    and operation = 'record_business_customer_transfer_v2'
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
    customer_id, order_id, currency, amount, exchange_rate_to_cny, received_at,
    payment_type, proof_path, extra_proof_paths, notes, idempotency_key, payload_hash,
    created_by, updated_by
  ) values (
    p_customer_id, p_order_id, p_currency, round(p_amount, 4),
    v_rate, p_received_at,
    p_payment_type, p_proof_path, v_extra_proof_paths, nullif(btrim(p_notes), ''),
    btrim(p_idempotency_key), v_hash, v_uid, v_uid
  ) returning * into v_transfer;

  v_allocations := public.business_apply_transfer_allocations(
    v_transfer.id, p_allocations, v_uid, p_correction_reason
  );
  perform public.write_business_lifecycle_audit(
    p_order_id, p_customer_id, 'transfer', v_transfer.id,
    'create', null, to_jsonb(v_transfer), null, v_uid
  );
  v_result := jsonb_build_object('transfer', to_jsonb(v_transfer), 'allocations', v_allocations);
  insert into public.business_rpc_idempotency (
    actor_id, operation, idempotency_key, payload_hash, result
  ) values (
    v_uid, 'record_business_customer_transfer_v2', btrim(p_idempotency_key), v_hash, v_result
  );
  return v_result;
end;
$function$;
