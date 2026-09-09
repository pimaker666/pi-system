-- 0034_account_handover_release_guards.sql
-- 发布保护：修复 PI 创建与强化旧每日订单只读边界。

begin;

-- 生产可能已存在旧版生命周期审计表；CREATE TABLE IF NOT EXISTS 不会扩展原有
-- action check，因此显式重建约束，允许客户复制审计事件写入。
alter table public.account_lifecycle_audit_logs
  drop constraint if exists account_lifecycle_audit_logs_action_check;
alter table public.account_lifecycle_audit_logs
  add constraint account_lifecycle_audit_logs_action_check
  check (action in ('name_change', 'disable', 'restore', 'handover', 'customer_transfer', 'customer_copy'));

-- hardened PI SELECT policy 会调用 can_view_pi(id)。INSERT ... RETURNING 在新行可被
-- helper 查询前评估 SELECT policy，导致合法创建被 RLS 拒绝。先生成 id、无 RETURNING
-- 插入，再在同一事务内单独读取编号。
create or replace function public.create_pi_with_items(
  p_customer_id uuid,
  p_customer_snapshot jsonb,
  p_currency public.currency_code,
  p_subtotal numeric,
  p_tax_rate numeric,
  p_tax_amount numeric,
  p_shipping_fee numeric,
  p_discount numeric,
  p_total numeric,
  p_notes text,
  p_terms text,
  p_items jsonb,
  p_shipping_method text default null,
  p_show_specification boolean default true,
  p_show_weight boolean default false
)
returns table (id uuid, pi_number text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_pi_id uuid := pg_catalog.gen_random_uuid();
  v_pi_no text;
  v_item jsonb;
  v_idx integer := 0;
begin
  insert into public.proforma_invoices (
    id, customer_id, customer_snapshot, currency, subtotal, tax_rate,
    tax_amount, shipping_fee, discount, total, notes, terms, shipping_method,
    show_specification, show_weight, status, created_by
  ) values (
    v_pi_id, p_customer_id, p_customer_snapshot, p_currency, p_subtotal, p_tax_rate,
    p_tax_amount, p_shipping_fee, p_discount, p_total, p_notes, p_terms, p_shipping_method,
    coalesce(p_show_specification, true), coalesce(p_show_weight, false), 'active',
    (select auth.uid())
  );

  select pi.pi_number
  into strict v_pi_no
  from public.proforma_invoices pi
  where pi.id = v_pi_id;

  for v_item in
    select value from pg_catalog.jsonb_array_elements(p_items)
  loop
    insert into public.pi_items (
      pi_id, product_id, sku, name, description, image_url, remark_image_url,
      specification, weight_g, unit, unit_price, quantity, line_total, sort_order
    ) values (
      v_pi_id,
      nullif(v_item->>'product_id', '')::uuid,
      v_item->>'sku',
      v_item->>'name',
      v_item->>'description',
      nullif(v_item->>'image_url', ''),
      nullif(v_item->>'remark_image_url', ''),
      nullif(v_item->>'specification', ''),
      nullif(v_item->>'weight_g', '')::numeric,
      coalesce(v_item->>'unit', 'pcs'),
      (v_item->>'unit_price')::numeric,
      (v_item->>'quantity')::numeric,
      (v_item->>'line_total')::numeric,
      coalesce((v_item->>'sort_order')::integer, v_idx)
    );
    v_idx := v_idx + 1;
  end loop;

  return query select v_pi_id, v_pi_no;
end;
$$;

revoke all on function public.create_pi_with_items(
  uuid, jsonb, public.currency_code, numeric, numeric, numeric, numeric, numeric,
  numeric, text, text, jsonb, text, boolean, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.create_pi_with_items(
  uuid, jsonb, public.currency_code, numeric, numeric, numeric, numeric, numeric,
  numeric, text, text, jsonb, text, boolean, boolean
) to authenticated;

-- 生产基线曾出现旧每日订单对象已存在但拒写触发器不完整的状态。
-- 每次账号交接发布都重新声明七张旧事实/流程表只读，business_orders 继续是唯一可写事实源。
create or replace function public.reject_legacy_daily_order_write()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  raise exception 'Legacy daily-order facts are read-only; write business orders through business_orders';
end;
$$;
revoke all on function public.reject_legacy_daily_order_write()
  from public, anon, authenticated, service_role;

do $$
declare
  legacy_table_name text;
  legacy_table regclass;
begin
  foreach legacy_table_name in array array[
    'finance_daily_orders',
    'finance_daily_order_screenshots',
    'finance_daily_order_workflows',
    'finance_daily_order_commissions',
    'finance_daily_order_change_requests',
    'finance_daily_order_workflow_audit_logs',
    'finance_daily_order_cost_overrides'
  ]
  loop
    legacy_table := pg_catalog.to_regclass(pg_catalog.format('public.%I', legacy_table_name));
    if legacy_table is null then
      raise exception 'Required legacy table public.% is missing', legacy_table_name;
    end if;

    execute pg_catalog.format(
      'revoke insert, update, delete, truncate on table %s from public, anon, authenticated, service_role',
      legacy_table
    );
    execute pg_catalog.format(
      'drop trigger if exists trg_reject_legacy_daily_order_write on %s',
      legacy_table
    );
    execute pg_catalog.format(
      'create trigger trg_reject_legacy_daily_order_write before insert or update or delete or truncate on %s for each statement execute function public.reject_legacy_daily_order_write()',
      legacy_table
    );
  end loop;

  foreach legacy_table_name in array array[
    'finance_daily_order_shop_groups',
    'finance_daily_order_shops',
    'finance_daily_order_shop_salespeople'
  ]
  loop
    legacy_table := pg_catalog.to_regclass(pg_catalog.format('public.%I', legacy_table_name));
    if legacy_table is not null then
      execute pg_catalog.format(
        'drop trigger if exists trg_reject_legacy_daily_order_write on %s',
        legacy_table
      );
    end if;
  end loop;
end;
$$;

-- 撤销全部旧事实/流程 mutator 的所有重载；店铺配置 RPC 保留可用。
do $$
declare
  mutator record;
begin
  for mutator in
    select procedures.oid::regprocedure as identity
    from pg_catalog.pg_proc procedures
    join pg_catalog.pg_namespace namespaces on namespaces.oid = procedures.pronamespace
    where namespaces.nspname = 'public'
      and procedures.prokind = 'f'
      and procedures.proname = any (array[
        'create_finance_daily_order',
        'update_finance_daily_order',
        'bulk_create_finance_daily_orders',
        'bulk_create_finance_daily_orders_with_totals',
        'void_finance_daily_order',
        'bind_finance_daily_order_screenshot',
        'remove_finance_daily_order_screenshot',
        'resolve_daily_order_workflow',
        'refresh_daily_order_workflow_totals',
        'sync_daily_order_workflow_totals',
        'write_daily_order_workflow_audit',
        'claim_daily_order_workflow',
        'bind_daily_order_workflow_customer',
        'submit_daily_order_performance',
        'review_daily_order_performance',
        'save_daily_order_commission',
        'request_daily_order_change',
        'review_daily_order_change',
        'cancel_daily_order_change',
        'update_finance_daily_order_unchecked_0031'
      ]::text[])
    order by procedures.oid
  loop
    execute pg_catalog.format(
      'revoke execute on function %s from public, anon, authenticated, service_role',
      mutator.identity
    );
  end loop;
end;
$$;

commit;
