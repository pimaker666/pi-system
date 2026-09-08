-- 0031_unify_daily_orders_with_business_orders.sql
-- 上线后 business_orders 是唯一可写业务订单事实源。
-- 旧 finance_daily_* 事实与流程数据保持原样，仅作为只读归档；本迁移不推断、转换或补造任何业务事实。

begin;

-- 固定影响类型文本输出的会话设置，确保 jsonb::text 哈希跨重跑稳定。
set local timezone = 'UTC';
set local datestyle = 'ISO, YMD';
set local intervalstyle = 'iso_8601';

-- -----------------------------------------------------------------------------
-- 1. 归档清单：每个旧 workflow 一条，每个无 workflow 的旧订单行一条
-- -----------------------------------------------------------------------------
create table if not exists public.legacy_daily_order_archive_manifest (
  source_kind          text not null,
  source_id            uuid not null,
  payload_hash         text not null,
  row_count            bigint not null,
  original_order_number text not null,
  currency_codes       text[] not null,
  archived_at          timestamptz not null default clock_timestamp(),
  constraint legacy_daily_order_archive_manifest_source_kind_check
    check (source_kind in ('workflow', 'orphan_order')),
  constraint legacy_daily_order_archive_manifest_payload_hash_check
    check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint legacy_daily_order_archive_manifest_row_count_check
    check (
      (source_kind = 'workflow' and row_count >= 0)
      or (source_kind = 'orphan_order' and row_count = 1)
    ),
  constraint legacy_daily_order_archive_manifest_order_number_check
    check (char_length(btrim(original_order_number)) between 1 and 200),
  constraint legacy_daily_order_archive_manifest_currency_codes_check
    check (
      cardinality(currency_codes) > 0
      and currency_codes <@ array['CNY', 'USD']::text[]
    ),
  constraint legacy_daily_order_archive_manifest_source_unique
    unique (source_kind, source_id)
);

comment on table public.legacy_daily_order_archive_manifest is
  '旧每日订单只读归档完整性清单；仅证明来源快照，绝不表示已转换为 business_orders';
comment on column public.legacy_daily_order_archive_manifest.payload_hash is
  '按稳定排序聚合真实旧来源后计算的 SHA-256；重跑时来源漂移会中止迁移';

-- 锁住所有旧事实/流程来源直到只读触发器安装完毕，避免快照与冻结之间出现写入窗口。
lock table
  public.legacy_daily_order_archive_manifest,
  public.finance_daily_orders,
  public.finance_daily_order_screenshots,
  public.finance_daily_order_workflows,
  public.finance_daily_order_commissions,
  public.finance_daily_order_change_requests,
  public.finance_daily_order_workflow_audit_logs,
  public.finance_daily_order_cost_overrides
in share row exclusive mode;

create temporary table legacy_daily_order_archive_snapshot (
  source_kind           text not null,
  source_id             uuid not null,
  payload_hash          text not null,
  row_count             bigint not null,
  original_order_number text not null,
  currency_codes        text[] not null,
  primary key (source_kind, source_id)
) on commit drop;

-- workflow 快照覆盖订单头及其订单行、截图、提成、改动申请、审计日志和成本覆盖。
insert into pg_temp.legacy_daily_order_archive_snapshot (
  source_kind,
  source_id,
  payload_hash,
  row_count,
  original_order_number,
  currency_codes
)
select
  'workflow',
  workflows.id,
  encode(extensions.digest(source_payload.payload::text, 'sha256'), 'hex'),
  (
    select count(*)
    from public.finance_daily_orders as orders
    where orders.workflow_id = workflows.id
  ),
  workflows.order_number,
  array(
    select distinct currencies.currency_code
    from (
      select orders.sales_unit_price_currency::text as currency_code
      from public.finance_daily_orders as orders
      where orders.workflow_id = workflows.id
      union all
      select orders.product_received_currency::text
      from public.finance_daily_orders as orders
      where orders.workflow_id = workflows.id
      union all
      select orders.logistics_fee_currency::text
      from public.finance_daily_orders as orders
      where orders.workflow_id = workflows.id
      union all
      select orders.sales_total_currency::text
      from public.finance_daily_orders as orders
      where orders.workflow_id = workflows.id
      union all
      select workflows.total_product_received_currency::text
      union all
      select workflows.total_shipping_received_currency::text
      union all
      select workflows.total_sales_currency::text
      union all
      select commissions.commission_currency::text
      from public.finance_daily_order_commissions as commissions
      where commissions.workflow_id = workflows.id
    ) as currencies
    where currencies.currency_code is not null
    order by currencies.currency_code
  )
from public.finance_daily_order_workflows as workflows
cross join lateral (
  select jsonb_build_object(
    'source_kind', 'workflow',
    'workflow', to_jsonb(workflows),
    'orders', coalesce((
      select jsonb_agg(to_jsonb(orders) order by orders.id)
      from public.finance_daily_orders as orders
      where orders.workflow_id = workflows.id
    ), '[]'::jsonb),
    'screenshots', coalesce((
      select jsonb_agg(to_jsonb(screenshots) order by screenshots.id)
      from public.finance_daily_order_screenshots as screenshots
      join public.finance_daily_orders as orders on orders.id = screenshots.order_id
      where orders.workflow_id = workflows.id
    ), '[]'::jsonb),
    'commissions', coalesce((
      select jsonb_agg(to_jsonb(commissions) order by commissions.id)
      from public.finance_daily_order_commissions as commissions
      where commissions.workflow_id = workflows.id
    ), '[]'::jsonb),
    'change_requests', coalesce((
      select jsonb_agg(to_jsonb(change_requests) order by change_requests.id)
      from public.finance_daily_order_change_requests as change_requests
      where change_requests.workflow_id = workflows.id
    ), '[]'::jsonb),
    'workflow_audit_logs', coalesce((
      select jsonb_agg(to_jsonb(audit_logs) order by audit_logs.id)
      from public.finance_daily_order_workflow_audit_logs as audit_logs
      where audit_logs.workflow_id = workflows.id
    ), '[]'::jsonb),
    'cost_overrides', coalesce((
      select jsonb_agg(to_jsonb(cost_overrides) order by cost_overrides.daily_order_id)
      from public.finance_daily_order_cost_overrides as cost_overrides
      join public.finance_daily_orders as orders on orders.id = cost_overrides.daily_order_id
      where orders.workflow_id = workflows.id
    ), '[]'::jsonb)
  ) as payload
) as source_payload;

-- 无 workflow 行保持单行边界，不按订单号、业务员或其它字段猜测归组。
insert into pg_temp.legacy_daily_order_archive_snapshot (
  source_kind,
  source_id,
  payload_hash,
  row_count,
  original_order_number,
  currency_codes
)
select
  'orphan_order',
  orders.id,
  encode(extensions.digest(source_payload.payload::text, 'sha256'), 'hex'),
  1,
  orders.order_number,
  array(
    select distinct currencies.currency_code
    from (
      values
        (orders.sales_unit_price_currency::text),
        (orders.product_received_currency::text),
        (orders.logistics_fee_currency::text),
        (orders.sales_total_currency::text)
    ) as currencies(currency_code)
    where currencies.currency_code is not null
    order by currencies.currency_code
  )
from public.finance_daily_orders as orders
cross join lateral (
  select jsonb_build_object(
    'source_kind', 'orphan_order',
    'workflow', null,
    'orders', jsonb_build_array(to_jsonb(orders)),
    'screenshots', coalesce((
      select jsonb_agg(to_jsonb(screenshots) order by screenshots.id)
      from public.finance_daily_order_screenshots as screenshots
      where screenshots.order_id = orders.id
    ), '[]'::jsonb),
    'commissions', '[]'::jsonb,
    'change_requests', coalesce((
      select jsonb_agg(to_jsonb(change_requests) order by change_requests.id)
      from public.finance_daily_order_change_requests as change_requests
      where change_requests.order_id = orders.id
    ), '[]'::jsonb),
    'workflow_audit_logs', '[]'::jsonb,
    'cost_overrides', coalesce((
      select jsonb_agg(to_jsonb(cost_overrides) order by cost_overrides.daily_order_id)
      from public.finance_daily_order_cost_overrides as cost_overrides
      where cost_overrides.daily_order_id = orders.id
    ), '[]'::jsonb)
  ) as payload
) as source_payload
where orders.workflow_id is null;

-- 重跑只能接受完全相同的来源哈希；既有清单永不覆盖。
do $$
begin
  if exists (
    select 1
    from public.legacy_daily_order_archive_manifest as manifest
    join pg_temp.legacy_daily_order_archive_snapshot as snapshot
      on snapshot.source_kind = manifest.source_kind
     and snapshot.source_id = manifest.source_id
    where manifest.payload_hash is distinct from snapshot.payload_hash
  ) then
    raise exception 'Legacy daily-order archive source hash drift detected; manifest was not changed';
  end if;

  if exists (
    select 1
    from public.legacy_daily_order_archive_manifest as manifest
    join pg_temp.legacy_daily_order_archive_snapshot as snapshot
      on snapshot.source_kind = manifest.source_kind
     and snapshot.source_id = manifest.source_id
    where manifest.payload_hash = snapshot.payload_hash
      and (
        manifest.row_count is distinct from snapshot.row_count
        or manifest.original_order_number is distinct from snapshot.original_order_number
        or manifest.currency_codes is distinct from snapshot.currency_codes
      )
  ) then
    raise exception 'Legacy daily-order archive manifest metadata does not match its source hash';
  end if;
end;
$$;

insert into public.legacy_daily_order_archive_manifest (
  source_kind,
  source_id,
  payload_hash,
  row_count,
  original_order_number,
  currency_codes
)
select
  snapshot.source_kind,
  snapshot.source_id,
  snapshot.payload_hash,
  snapshot.row_count,
  snapshot.original_order_number,
  snapshot.currency_codes
from pg_temp.legacy_daily_order_archive_snapshot as snapshot
on conflict (source_kind, source_id) do nothing;

-- 清单仅允许已认证的 admin/finance 读取；旧表本身的 SELECT ACL 与 RLS 保持不变。
alter table public.legacy_daily_order_archive_manifest enable row level security;
revoke all on table public.legacy_daily_order_archive_manifest
  from public, anon, authenticated, service_role;
grant select on table public.legacy_daily_order_archive_manifest to authenticated;

drop policy if exists "legacy_daily_order_archive_manifest_select"
  on public.legacy_daily_order_archive_manifest;
create policy "legacy_daily_order_archive_manifest_select"
  on public.legacy_daily_order_archive_manifest
  for select
  to authenticated
  using (public.is_finance_or_admin());

-- -----------------------------------------------------------------------------
-- 2. 永久冻结旧事实/流程表；店铺组、店铺、店铺业务员等配置表不冻结
-- -----------------------------------------------------------------------------
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

  -- 若曾执行过早期草案，明确移除配置表上的同名冻结触发器。
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

-- 按 pg_proc 中真实存在的 OID 遍历全部重载，只撤销旧事实/流程 mutator；配置管理 RPC 保留。
do $$
declare
  mutator record;
begin
  for mutator in
    select procedures.oid::regprocedure as identity
    from pg_catalog.pg_proc as procedures
    join pg_catalog.pg_namespace as namespaces on namespaces.oid = procedures.pronamespace
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
        'cancel_daily_order_change'
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

-- -----------------------------------------------------------------------------
-- 3. 事务内完整性断言：覆盖、哈希和来源元数据必须与当前只读快照完全一致
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1
    from pg_temp.legacy_daily_order_archive_snapshot as snapshot
    where snapshot.payload_hash is null
       or snapshot.payload_hash !~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'Legacy daily-order archive snapshot contains an empty or invalid payload hash';
  end if;

  if exists (
    select 1
    from public.finance_daily_order_workflows as workflows
    where not exists (
      select 1
      from public.legacy_daily_order_archive_manifest as manifest
      where manifest.source_kind = 'workflow'
        and manifest.source_id = workflows.id
    )
  ) then
    raise exception 'Legacy daily-order archive manifest does not cover every workflow';
  end if;

  if exists (
    select 1
    from public.finance_daily_orders as orders
    where orders.workflow_id is null
      and not exists (
        select 1
        from public.legacy_daily_order_archive_manifest as manifest
        where manifest.source_kind = 'orphan_order'
          and manifest.source_id = orders.id
      )
  ) then
    raise exception 'Legacy daily-order archive manifest does not cover every orphan order row';
  end if;

  if exists (
    select 1
    from pg_temp.legacy_daily_order_archive_snapshot as snapshot
    left join public.legacy_daily_order_archive_manifest as manifest
      on manifest.source_kind = snapshot.source_kind
     and manifest.source_id = snapshot.source_id
    where manifest.source_id is null
       or manifest.payload_hash is distinct from snapshot.payload_hash
       or manifest.row_count is distinct from snapshot.row_count
       or manifest.original_order_number is distinct from snapshot.original_order_number
       or manifest.currency_codes is distinct from snapshot.currency_codes
  ) then
    raise exception 'Legacy daily-order archive manifest is incomplete or differs from the source snapshot';
  end if;

  if exists (
    select 1
    from public.legacy_daily_order_archive_manifest as manifest
    left join pg_temp.legacy_daily_order_archive_snapshot as snapshot
      on snapshot.source_kind = manifest.source_kind
     and snapshot.source_id = manifest.source_id
    where snapshot.source_id is null
       or manifest.payload_hash is null
       or manifest.payload_hash !~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'Legacy daily-order archive manifest contains a missing source or invalid payload hash';
  end if;
end;
$$;

-- 本迁移刻意不写入 business_orders、business_order_items、收款/分摊、发货或退货表，
-- 也不提供任何旧数据人工解析/转换 RPC。
commit;
