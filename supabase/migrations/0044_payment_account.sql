-- 0044 收款账户：订单表单增加收款账户字段，店铺设置增加收款账户维护
--
-- 业务背景：
--   1. 原“生命周期货运单号”字段在业务订单表单中实际用于记录收款账户，现改为独立字段。
--   2. 新增 payment_accounts 表维护常用收款账户，在业务订单表单中以下拉形式选择，
--      选择后仍可在输入框内直接修改。

begin;

-- -----------------------------------------------------------------------------
-- 1. 收款账户字典表
-- -----------------------------------------------------------------------------
create table if not exists public.payment_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_accounts_name_check check (char_length(btrim(name)) between 1 and 200),
  constraint payment_accounts_name_unique unique (name)
);

comment on table public.payment_accounts is '业务订单收款账户字典';
comment on column public.payment_accounts.name is '收款账户名称，如银行卡号、支付宝账号等';
comment on column public.payment_accounts.is_active is 'false 表示停用，不再出现在下拉选项中';

alter table public.payment_accounts enable row level security;
revoke all on table public.payment_accounts from anon, authenticated;
grant select on table public.payment_accounts to authenticated;
grant insert, update, delete on table public.payment_accounts to authenticated;

drop policy if exists "payment_accounts_select" on public.payment_accounts;
create policy "payment_accounts_select"
  on public.payment_accounts for select to authenticated
  using (true);

drop policy if exists "payment_accounts_manage" on public.payment_accounts;
create policy "payment_accounts_manage"
  on public.payment_accounts for all to authenticated
  using (public.is_approved_user() and role() in ('admin', 'finance'))
  with check (public.is_approved_user() and role() in ('admin', 'finance'));

-- -----------------------------------------------------------------------------
-- 2. 业务订单增加收款账户字段
-- -----------------------------------------------------------------------------
alter table public.business_orders
  add column if not exists payment_account text;

comment on column public.business_orders.payment_account is '收款账户，可从 payment_accounts 下拉选择或直接填写';

-- -----------------------------------------------------------------------------
-- 3. 收款账户维护 RPC（仅管理员/财务）
-- -----------------------------------------------------------------------------
create or replace function public.save_payment_account(
  p_account_id uuid,
  p_name text,
  p_is_active boolean
)
returns public.payment_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_account public.payment_accounts%rowtype;
  v_trimmed text := btrim(p_name);
begin
  select * into v_actor from public.profiles p where p.id = (select auth.uid());
  if not found or v_actor.status::text <> 'approved' or v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Only approved admin or finance users can manage payment accounts';
  end if;
  if nullif(v_trimmed, '') is null or char_length(v_trimmed) > 200 then
    raise exception 'Invalid payment account name';
  end if;
  if p_account_id is null then
    insert into public.payment_accounts(name, is_active)
      values (v_trimmed, coalesce(p_is_active, true))
      returning * into v_account;
  else
    update public.payment_accounts
      set name = v_trimmed, is_active = coalesce(p_is_active, is_active), updated_at = now()
      where id = p_account_id
      returning * into v_account;
    if not found then raise exception 'Payment account does not exist'; end if;
  end if;
  return v_account;
end;
$$;
revoke all on function public.save_payment_account(uuid, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.save_payment_account(uuid, text, boolean) to authenticated;

create or replace function public.delete_payment_account(p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
begin
  select * into v_actor from public.profiles p where p.id = (select auth.uid());
  if not found or v_actor.status::text <> 'approved' or v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Only approved admin or finance users can delete payment accounts';
  end if;
  if p_account_id is null then raise exception 'Payment account id is required'; end if;
  delete from public.payment_accounts where id = p_account_id;
end;
$$;
revoke all on function public.delete_payment_account(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_payment_account(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. 业务订单 v4 RPC 增加 p_payment_account 参数
--    v4 继续调用 v3 处理 tracking_number 等原有字段，之后单独写入 payment_account。
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
  p_receivable_received_difference_reason text,
  p_payment_account text
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
  numeric, boolean, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_business_order_v4(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb, date, uuid, uuid, text, date, text,
  public.daily_order_payment_category, numeric, boolean, numeric, boolean,
  numeric, boolean, text, text
) to authenticated;

create or replace function public.update_business_order_v4(
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
  p_reason text,
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
  p_receivable_received_difference_reason text,
  p_payment_account text
)
returns table (id uuid, order_number text, version int)
language plpgsql
security definer
set search_path = public
as $$
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

  return query select v_order.id, v_order.order_number, v_order.version;
end;
$$;
revoke all on function public.update_business_order_v4(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text, uuid,
  uuid, text, date, text, public.daily_order_payment_category, numeric, boolean,
  numeric, boolean, numeric, boolean, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.update_business_order_v4(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text, uuid,
  uuid, text, date, text, public.daily_order_payment_category, numeric, boolean,
  numeric, boolean, numeric, boolean, text, text
) to authenticated;

commit;
