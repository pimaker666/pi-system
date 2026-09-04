-- 0024_daily_order_purchase_and_admin.sql
-- 每日订单增强：
--  1) 发货分类新增 '外采'（purchase）。
--  2) 店铺可分配业务员范围放宽到 approved 的 sales + admin；
--     对应 create/update 订单与保存店铺时的业务员校验同步放宽。
--  3) 店铺支持自定义分组；每个店铺最多属于一个分组，删除分组后店铺自动变为未分组。
-- 注意：ALTER TYPE ... ADD VALUE 与其字面量使用不可同一事务，本迁移不使用 'purchase' 字面量，仅按类型引用，安全。

alter type public.daily_order_shipping_category add value if not exists 'purchase';

create table if not exists public.finance_daily_order_shop_groups (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_daily_order_shop_groups_name_check check (char_length(btrim(name)) between 1 and 100)
);
create unique index if not exists idx_daily_order_shop_groups_name_ci
  on public.finance_daily_order_shop_groups (lower(btrim(name)));
create index if not exists idx_daily_order_shop_groups_created_by
  on public.finance_daily_order_shop_groups (created_by);

alter table public.finance_daily_order_shops
  add column if not exists group_id uuid references public.finance_daily_order_shop_groups(id) on delete set null;
create index if not exists idx_daily_order_shops_group
  on public.finance_daily_order_shops (group_id, name);

drop trigger if exists trg_daily_order_shop_groups_touch on public.finance_daily_order_shop_groups;
create trigger trg_daily_order_shop_groups_touch before update on public.finance_daily_order_shop_groups
  for each row execute function public.touch_updated_at();

alter table public.finance_daily_order_shop_groups enable row level security;
revoke all on table public.finance_daily_order_shop_groups from anon, authenticated;
grant select on table public.finance_daily_order_shop_groups to authenticated;
drop policy if exists "daily_order_shop_groups_select" on public.finance_daily_order_shop_groups;
create policy "daily_order_shop_groups_select" on public.finance_daily_order_shop_groups
  for select to authenticated using (public.is_finance_or_admin());

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

  insert into public.finance_daily_orders (
    order_date, shop_id, shop_name_snapshot, salesperson_id, salesperson_name_snapshot,
    order_number, shipping_date, shipping_number, shipping_category,
    product_id, product_name_snapshot, product_sku_snapshot, quantity,
    sales_unit_price_amount, sales_unit_price_currency,
    product_received_amount, product_received_currency,
    logistics_fee_amount, logistics_fee_currency,
    sales_total_amount, sales_total_currency, payment_category, remarks, created_by, updated_by
  ) values (
    p_order_date, v_shop.id, v_shop.name, v_sales.id, coalesce(nullif(btrim(v_sales.full_name), ''), v_sales.email),
    btrim(p_order_number), p_shipping_date, nullif(btrim(p_shipping_number), ''), p_shipping_category,
    v_product.id, v_product.name, v_product.sku, p_quantity,
    p_sales_unit_price_amount, p_sales_unit_price_currency,
    p_product_received_amount, p_product_received_currency,
    p_logistics_fee_amount, p_logistics_fee_currency,
    p_sales_total_amount, p_sales_total_currency, p_payment_category, nullif(btrim(p_remarks), ''), v_actor.id, v_actor.id
  ) returning * into v_order;
  return query select v_order.id, v_order.version;
end;
$$;

create or replace function public.update_finance_daily_order(
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

  update public.finance_daily_orders as target set
    order_date = p_order_date, shop_id = v_shop.id, shop_name_snapshot = v_shop.name,
    salesperson_id = v_sales.id, salesperson_name_snapshot = coalesce(nullif(btrim(v_sales.full_name), ''), v_sales.email),
    order_number = btrim(p_order_number), shipping_date = p_shipping_date,
    shipping_number = nullif(btrim(p_shipping_number), ''), shipping_category = p_shipping_category,
    product_id = v_product.id, product_name_snapshot = v_product.name, product_sku_snapshot = v_product.sku,
    quantity = p_quantity, sales_unit_price_amount = p_sales_unit_price_amount,
    sales_unit_price_currency = p_sales_unit_price_currency,
    product_received_amount = p_product_received_amount, product_received_currency = p_product_received_currency,
    logistics_fee_amount = p_logistics_fee_amount, logistics_fee_currency = p_logistics_fee_currency,
    sales_total_amount = p_sales_total_amount, sales_total_currency = p_sales_total_currency,
    payment_category = p_payment_category, remarks = nullif(btrim(p_remarks), ''),
    version = target.version + 1, updated_by = v_actor.id
  where target.id = p_order_id
  returning target.id, target.version into id, version;
  return next;
end;
$$;

revoke all on function public.create_finance_daily_order(date, uuid, uuid, text, date, text, public.daily_order_shipping_category, uuid, numeric, numeric, public.currency_code, numeric, public.currency_code, numeric, public.currency_code, numeric, public.currency_code, public.daily_order_payment_category, text) from public, anon, authenticated, service_role;
grant execute on function public.create_finance_daily_order(date, uuid, uuid, text, date, text, public.daily_order_shipping_category, uuid, numeric, numeric, public.currency_code, numeric, public.currency_code, numeric, public.currency_code, numeric, public.currency_code, public.daily_order_payment_category, text) to authenticated;
revoke all on function public.update_finance_daily_order(uuid, int, date, uuid, uuid, text, date, text, public.daily_order_shipping_category, uuid, numeric, numeric, public.currency_code, numeric, public.currency_code, numeric, public.currency_code, numeric, public.currency_code, public.daily_order_payment_category, text) from public, anon, authenticated, service_role;
grant execute on function public.update_finance_daily_order(uuid, int, date, uuid, uuid, text, date, text, public.daily_order_shipping_category, uuid, numeric, numeric, public.currency_code, numeric, public.currency_code, numeric, public.currency_code, numeric, public.currency_code, public.daily_order_payment_category, text) to authenticated;

create or replace function public.save_finance_daily_order_shop_group(p_group_id uuid, p_name text)
returns public.finance_daily_order_shop_groups
language plpgsql
security definer
set search_path = public
as $$
declare v_actor public.profiles%rowtype; v_group public.finance_daily_order_shop_groups%rowtype;
begin
  v_actor := public.assert_daily_order_finance_actor();
  if nullif(btrim(p_name), '') is null or char_length(btrim(p_name)) > 100 then raise exception 'Invalid shop group name'; end if;
  if p_group_id is null then
    insert into public.finance_daily_order_shop_groups(name, created_by)
      values (btrim(p_name), v_actor.id) returning * into v_group;
  else
    update public.finance_daily_order_shop_groups set name = btrim(p_name)
      where id = p_group_id returning * into v_group;
    if not found then raise exception 'Shop group does not exist'; end if;
  end if;
  return v_group;
end;
$$;
revoke all on function public.save_finance_daily_order_shop_group(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.save_finance_daily_order_shop_group(uuid, text) to authenticated;

create or replace function public.delete_finance_daily_order_shop_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_daily_order_finance_actor();
  delete from public.finance_daily_order_shop_groups where id = p_group_id;
  if not found then raise exception 'Shop group does not exist'; end if;
end;
$$;
revoke all on function public.delete_finance_daily_order_shop_group(uuid) from public, anon, authenticated, service_role;
grant execute on function public.delete_finance_daily_order_shop_group(uuid) to authenticated;

create or replace function public.save_finance_daily_order_shop(
  p_shop_id uuid, p_name text, p_group_id uuid, p_is_active boolean, p_salesperson_ids uuid[]
)
returns public.finance_daily_order_shops
language plpgsql
security definer
set search_path = public
as $$
declare v_actor public.profiles%rowtype; v_shop public.finance_daily_order_shops%rowtype; v_sales_id uuid;
begin
  v_actor := public.assert_daily_order_finance_actor();
  if nullif(btrim(p_name), '') is null or char_length(btrim(p_name)) > 100 then raise exception 'Invalid shop name'; end if;
  if p_group_id is not null and not exists (select 1 from public.finance_daily_order_shop_groups where id = p_group_id)
    then raise exception 'Shop group does not exist'; end if;
  if coalesce(array_length(p_salesperson_ids, 1), 0) > 200 then raise exception 'Too many salespeople'; end if;
  foreach v_sales_id in array coalesce(p_salesperson_ids, array[]::uuid[]) loop
    if not exists (select 1 from public.profiles where id = v_sales_id and status::text = 'approved' and role::text in ('sales', 'admin'))
      then raise exception 'Salesperson does not exist or is not approved'; end if;
  end loop;
  if p_shop_id is null then
    insert into public.finance_daily_order_shops(name, group_id, is_active, created_by)
      values (btrim(p_name), p_group_id, p_is_active, v_actor.id) returning * into v_shop;
  else
    update public.finance_daily_order_shops set name = btrim(p_name), group_id = p_group_id, is_active = p_is_active
      where id = p_shop_id returning * into v_shop;
    if not found then raise exception 'Shop does not exist'; end if;
  end if;
  update public.finance_daily_order_shop_salespeople set is_active = false
    where shop_id = v_shop.id and salesperson_id <> all(coalesce(p_salesperson_ids, array[]::uuid[]));
  foreach v_sales_id in array coalesce(p_salesperson_ids, array[]::uuid[]) loop
    insert into public.finance_daily_order_shop_salespeople(shop_id, salesperson_id, is_active, created_by)
      values (v_shop.id, v_sales_id, true, v_actor.id)
    on conflict (shop_id, salesperson_id) do update set is_active = true;
  end loop;
  return v_shop;
end;
$$;
revoke all on function public.save_finance_daily_order_shop(uuid, text, uuid, boolean, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.save_finance_daily_order_shop(uuid, text, uuid, boolean, uuid[]) to authenticated;

-- 兼容迁移期间尚未切换的新版本容器；后续稳定版本可再移除此旧签名。
-- 编辑已有店铺时保留现有分组，避免旧容器在滚动切换期间把 group_id 静默清空。
create or replace function public.save_finance_daily_order_shop(
  p_shop_id uuid, p_name text, p_is_active boolean, p_salesperson_ids uuid[]
)
returns public.finance_daily_order_shops
language sql
security definer
set search_path = public
as $$
  select public.save_finance_daily_order_shop(
    p_shop_id,
    p_name,
    case
      when p_shop_id is null then null
      else (select s.group_id from public.finance_daily_order_shops s where s.id = p_shop_id)
    end,
    p_is_active,
    p_salesperson_ids
  );
$$;
revoke all on function public.save_finance_daily_order_shop(uuid, text, boolean, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.save_finance_daily_order_shop(uuid, text, boolean, uuid[]) to authenticated;

-- 修复 0021 主管层级上线后与财务可见性、管理员订单归属组合产生的权限边界。
-- 仅 approved 的 sales/supervisor 可作为主管链中的下属，避免遗留 supervisor_id
-- 让主管读取已转为 admin/finance 或未审核账号所归属的数据。
create or replace function public.is_my_subordinate(p_owner uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  with recursive chain as (
    select p.id, p.supervisor_id, 1 as depth
    from public.profiles p
    where p.id = p_owner
      and p.status::text = 'approved'
      and p.role::text in ('sales', 'supervisor')
    union all
    select parent.id, parent.supervisor_id, c.depth + 1
    from public.profiles parent
    join chain c on parent.id = c.supervisor_id
    where c.depth < 50
  )
  select
    p_owner is not null
    and (select auth.uid()) is not null
    and public.is_active_supervisor()
    and exists (
      select 1 from chain where chain.supervisor_id = (select auth.uid())
    );
$$;
revoke all on function public.is_my_subordinate(uuid) from public, anon, authenticated, service_role;
grant execute on function public.is_my_subordinate(uuid) to authenticated;

-- 0021 扩展主管可见性时必须保留 0016 已授予财务的 PI 只读权限。
drop policy if exists "pi_select_own" on public.proforma_invoices;
create policy "pi_select_own" on public.proforma_invoices
  for select to authenticated
  using (
    created_by = (select auth.uid())
    or public.is_finance_or_admin()
    or public.is_my_subordinate(created_by)
  );

drop policy if exists "pi_items_select_own" on public.pi_items;
create policy "pi_items_select_own" on public.pi_items
  for select to authenticated
  using (
    exists (
      select 1
      from public.proforma_invoices pi
      where pi.id = pi_items.pi_id
        and (
          pi.created_by = (select auth.uid())
          or public.is_finance_or_admin()
          or public.is_my_subordinate(pi.created_by)
        )
    )
  );
