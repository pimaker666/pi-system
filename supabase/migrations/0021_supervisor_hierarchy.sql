-- 0021_supervisor_hierarchy.sql
-- 业务主管（supervisor）角色与多级汇报层级。
-- 设计原则（加法式、最小权限）：
--   1) supervisor 的写权限与 sales 完全一致（自己的客户/PI/业务订单/收款），
--      因此所有原本判定 role='sales' 的写入 RPC 扩展为 role in ('sales','supervisor')。
--   2) supervisor 额外获得对“下属（递归）”的客户、PI、业务订单、每日订单台账的
--      只读可见性——仅在既有 SELECT 策略后追加 `or is_my_subordinate(owner)`，
--      不改动任何写策略，不放宽工资/核算/成本/流水/审计等敏感表。
--   3) 上级关系仅管理员可设置；环检测与目标角色校验集中在 profiles 守卫触发器。
-- 注意：ALTER TYPE ADD VALUE 的新枚举值不能在同一事务中作为“枚举字面量”使用；
--       本迁移全部使用 role::text 与文本字面量比较，规避该限制（沿用 0016 的做法）。

-- 1) 新增角色枚举值
alter type public.user_role add value if not exists 'supervisor';

-- 2) profiles 增加上级字段（自引用），删除上级时置空，禁止自引用
alter table public.profiles
  add column if not exists supervisor_id uuid references public.profiles(id) on delete set null;

alter table public.profiles
  drop constraint if exists profiles_supervisor_not_self;
alter table public.profiles
  add constraint profiles_supervisor_not_self check (
    supervisor_id is null or supervisor_id <> id
  );

create index if not exists idx_profiles_supervisor on public.profiles (supervisor_id);

comment on column public.profiles.supervisor_id is
  '汇报上级（业务主管或管理员），仅管理员可维护，用于主管查看下属数据';

-- 3) 权限辅助函数：当前用户是否为“已审核的业务主管”
create or replace function public.is_active_supervisor()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and status::text = 'approved'
      and role::text = 'supervisor'
  );
$$;

-- 4) 递归判定：p_owner 是否为当前主管（递归）下属。
--    从 p_owner 沿 supervisor_id 向上回溯，若链路上某节点的上级为当前用户，则成立。
--    depth<50 防止异常数据成环导致死循环。仅对已审核主管生效。
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

revoke all on function public.is_active_supervisor() from public, anon, authenticated, service_role;
revoke all on function public.is_my_subordinate(uuid) from public, anon, authenticated, service_role;
grant execute on function public.is_active_supervisor() to authenticated;
grant execute on function public.is_my_subordinate(uuid) to authenticated;

-- 5) 守卫触发器扩展：新增 supervisor_id 变更保护（仅管理员）、目标角色校验与环检测。
--    保留原有 role/status（仅管理员）与 chinese_name（仅财务/管理员）保护逻辑。
create or replace function public.protect_profile_privileged_fields()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_node uuid;
  v_depth int := 0;
  v_target_ok boolean;
begin
  if (select auth.uid()) is not null
     and (
       new.role is distinct from old.role
       or new.status is distinct from old.status
     )
     and not public.is_admin()
  then
    raise exception 'Only administrators can change role or status';
  end if;

  if new.chinese_name is distinct from old.chinese_name
     and not public.is_finance_or_admin()
  then
    raise exception 'Only approved finance users or administrators can change Chinese names';
  end if;

  if new.supervisor_id is distinct from old.supervisor_id then
    -- 仅管理员可设置/修改上级
    if (select auth.uid()) is not null and not public.is_admin() then
      raise exception 'Only administrators can change the reporting manager';
    end if;

    if new.supervisor_id is not null then
      if new.supervisor_id = new.id then
        raise exception 'A user cannot be their own manager';
      end if;

      -- 上级必须是已审核的业务主管或管理员
      select (p.status::text = 'approved' and p.role::text in ('supervisor', 'admin'))
        into v_target_ok
      from public.profiles p
      where p.id = new.supervisor_id;

      if not coalesce(v_target_ok, false) then
        raise exception 'Manager must be an approved supervisor or administrator';
      end if;

      -- 环检测：从新上级向上回溯，若回到本人则形成环
      v_node := new.supervisor_id;
      while v_node is not null and v_depth < 100 loop
        if v_node = new.id then
          raise exception 'Reporting hierarchy cannot contain a cycle';
        end if;
        select supervisor_id into v_node from public.profiles where id = v_node;
        v_depth := v_depth + 1;
      end loop;
    end if;
  end if;

  return new;
end;
$$;

-- 6) 管理员专用 RPC：设置/清除用户上级。串行化层级写入以避免并发成环。
--    目标用户须为 sales/supervisor；上级角色/自引用/环由守卫触发器兜底校验。
create or replace function public.set_user_manager(
  p_user_id uuid,
  p_manager_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.profiles%rowtype;
  v_updated uuid;
begin
  if not public.is_admin() then
    raise exception 'Only administrators can change the reporting manager';
  end if;
  if p_user_id is null then
    raise exception 'User ID is required';
  end if;
  if p_manager_id is not null and p_manager_id = p_user_id then
    raise exception 'A user cannot be their own manager';
  end if;

  perform pg_advisory_xact_lock(hashtext('profiles_supervisor_hierarchy'));

  select * into v_user from public.profiles where id = p_user_id;
  if not found then
    raise exception 'User does not exist';
  end if;

  if v_user.role::text not in ('sales', 'supervisor') then
    raise exception 'Only sales or supervisor users can have a manager';
  end if;

  update public.profiles
     set supervisor_id = p_manager_id
   where id = p_user_id
   returning id into v_updated;

  return v_updated;
end;
$$;

revoke all on function public.set_user_manager(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.set_user_manager(uuid, uuid) to authenticated;

-- ============================================================
-- 7) 只读可见性扩展（仅追加 or is_my_subordinate(...)，不改写写策略）
-- ============================================================

-- customers：本人 / 管理员 / 主管的下属
drop policy if exists "customers_select_own" on public.customers;
create policy "customers_select_own" on public.customers
  for select using (
    created_by = (select auth.uid())
    or public.is_admin()
    or public.is_my_subordinate(created_by)
  );

-- proforma_invoices：本人 / 管理员 / 主管的下属
drop policy if exists "pi_select_own" on public.proforma_invoices;
create policy "pi_select_own" on public.proforma_invoices
  for select using (
    created_by = (select auth.uid())
    or public.is_admin()
    or public.is_my_subordinate(created_by)
  );

-- pi_items：跟随所属 PI 的可见性
drop policy if exists "pi_items_select_own" on public.pi_items;
create policy "pi_items_select_own" on public.pi_items
  for select using (
    exists (
      select 1 from public.proforma_invoices pi
      where pi.id = pi_items.pi_id
        and (
          pi.created_by = (select auth.uid())
          or public.is_admin()
          or public.is_my_subordinate(pi.created_by)
        )
    )
  );

-- 每日订单台账：财务/管理员全量；主管可见下属业务员的订单
drop policy if exists "daily_orders_select" on public.finance_daily_orders;
create policy "daily_orders_select" on public.finance_daily_orders
  for select to authenticated
  using (
    public.is_finance_or_admin()
    or public.is_my_subordinate(salesperson_id)
  );

-- 每日订单截图：财务/管理员全量；主管可见下属订单的截图凭证
drop policy if exists "daily_order_screenshots_select" on public.finance_daily_order_screenshots;
create policy "daily_order_screenshots_select" on public.finance_daily_order_screenshots
  for select to authenticated
  using (
    public.is_finance_or_admin()
    or exists (
      select 1
      from public.finance_daily_orders o
      where o.id = finance_daily_order_screenshots.order_id
        and public.is_my_subordinate(o.salesperson_id)
    )
  );

-- 每日订单截图存储对象：主管可读取下属订单（路径第 2 段为 order_id）截图
drop policy if exists "finance_daily_order_screenshots_select" on storage.objects;
create policy "finance_daily_order_screenshots_select" on storage.objects for select to authenticated
using (
  bucket_id = 'finance-daily-order-screenshots'
  and array_length(storage.foldername(name), 1) = 2
  and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$'
  and (
    public.is_finance_or_admin()
    or exists (
      select 1
      from public.finance_daily_orders o
      where o.id = ((storage.foldername(name))[2])::uuid
        and public.is_my_subordinate(o.salesperson_id)
    )
  )
);

-- 业务订单可见性：新增 supervisor 分支（自己 + 递归下属）。
-- 该函数覆盖 business_orders / _items / _payments 的 SELECT 及支付凭证读取策略；
-- business_order_finance_details（工资/核算）与 audit_logs 仍限 finance/admin，主管不可见。
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
        or (
          p.role::text = 'supervisor'
          and (
            bo.salesperson_id = p.id
            or public.is_my_subordinate(bo.salesperson_id)
          )
        )
      )
  );
$$;

revoke all on function public.can_view_business_order(uuid) from public, anon, authenticated, service_role;
grant execute on function public.can_view_business_order(uuid) to authenticated;

-- ============================================================
-- 8) 写权限与 sales 对齐：所有 sales-owner 写入分支扩展为 sales+supervisor
--    （仅改动角色判定，其余逻辑与 0017 完全一致）
-- ============================================================

-- 8.1) 创建业务订单
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
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor') then
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

-- 8.2) 编辑业务订单（sales/supervisor 仅本人 draft/rejected；admin/finance 仅 completed 且带原因）
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

  if v_actor.role::text in ('sales', 'supervisor') then
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

-- 8.3) 新增收款
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

  if v_actor.role::text in ('sales', 'supervisor') then
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

-- 8.4) 更新收款
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

  if v_actor.role::text in ('sales', 'supervisor') then
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

-- 8.5) 收款作废（软删除）
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

  if v_actor.role::text in ('sales', 'supervisor') then
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

-- 8.6) 状态机：sales/supervisor 提交；admin 审批/驳回；finance 完成。
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

  if v_actor.role::text in ('sales', 'supervisor')
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

-- 8.7) 支付凭证上传策略：sales/supervisor 可为本人 draft/rejected 订单上传
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
            (p.role::text in ('sales', 'supervisor')
             and bo.salesperson_id = p.id
             and bo.status::text in ('draft', 'rejected'))
            or (p.role::text in ('admin', 'finance')
                and bo.status::text = 'completed')
          )
      )
      else false
    end
  );
