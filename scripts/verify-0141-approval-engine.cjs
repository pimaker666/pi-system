const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')

const ADMIN = '20000000-0000-4000-8000-000000000001'
const ADMIN2 = '20000000-0000-4000-8000-000000000002'
const FINANCE = '20000000-0000-4000-8000-000000000003'
const SALES = '20000000-0000-4000-8000-000000000004'
const SALES2 = '20000000-0000-4000-8000-000000000005'
const SUPERVISOR = '20000000-0000-4000-8000-000000000006'
const PENDING = '20000000-0000-4000-8000-000000000007'

const O1 = '30000000-0000-4000-8000-000000000001'
const O2 = '30000000-0000-4000-8000-000000000002'
const O3 = '30000000-0000-4000-8000-000000000003'
const O4 = '30000000-0000-4000-8000-000000000004'
const ITEM1 = '40000000-0000-4000-8000-000000000001'
const ITEM4 = '40000000-0000-4000-8000-000000000004'

const json = (value) => `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`

const V6_SIG = `uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text, uuid,
  uuid, text, date, text, public.daily_order_payment_category, numeric, boolean,
  numeric, boolean, numeric, boolean, text, text, numeric`

const V45_SIG = `uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text, uuid,
  uuid, text, date, text, public.daily_order_payment_category, numeric, boolean,
  numeric, boolean, numeric, boolean, text, text`

async function main() {
  const db = new PGlite()
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;

    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;
    grant usage on schema public to authenticated, anon;

    create type public.user_role as enum ('admin', 'finance', 'supervisor', 'sales');
    create type public.business_order_status as enum ('draft', 'submitted', 'approved', 'rejected', 'voided', 'completed');
    create type public.business_fulfillment_type as enum ('delivery', 'pickup', 'direct');
    create type public.currency_code as enum ('USD', 'CNY');
    create type public.daily_order_payment_category as enum ('deposit', 'balance', 'other');
    create type public.business_audit_action as enum ('create', 'update', 'submit', 'approve', 'reject', 'complete', 'void');

    create table public.profiles (
      id uuid primary key,
      role public.user_role not null,
      status text not null,
      chinese_name text,
      full_name text,
      email text
    );

    create table public.business_orders (
      id uuid primary key,
      order_number text not null,
      status public.business_order_status not null default 'draft',
      approval_status text not null default 'draft',
      total_sales_amount numeric,
      salesperson_id uuid,
      submitted_by uuid,
      submitted_at timestamptz,
      reviewed_by uuid,
      reviewed_at timestamptz,
      review_note text,
      version int not null default 1,
      closed_at timestamptz,
      completed_at timestamptz,
      sales_notes text
    );

    create table public.business_order_items (
      id uuid primary key,
      order_id uuid not null references public.business_orders(id) on delete cascade
    );

    create table public.finance_business_order_item_cost_overrides (
      business_order_item_id uuid primary key references public.business_order_items(id) on delete cascade,
      cost numeric not null,
      updated_by uuid,
      updated_at timestamptz not null default now()
    );
    grant select, insert, update, delete on public.finance_business_order_item_cost_overrides to authenticated;

    create table public.business_order_finance_details (
      order_id uuid primary key references public.business_orders(id) on delete cascade,
      wage_amount_cny numeric,
      calculation_notes text
    );

    create or replace function public.permission_require_admin()
    returns void language plpgsql security definer set search_path = public as $$
    declare
      v_profile public.profiles%rowtype;
    begin
      select * into v_profile from public.profiles where id = (select auth.uid());
      if not found or v_profile.role::text <> 'admin' or v_profile.status::text <> 'approved' then
        raise exception 'Admin required';
      end if;
    end;
    $$;

    create or replace function public.write_permission_audit(
      p_entity_type text, p_entity_id uuid, p_action text, p_old_data jsonb, p_new_data jsonb
    ) returns void language sql security definer set search_path = public as $$ select $$;

    create or replace function public.write_business_order_audit(
      p_order_id uuid, p_entity_type text, p_entity_id uuid, p_action public.business_audit_action,
      p_from_status public.business_order_status, p_to_status public.business_order_status,
      p_old_data jsonb, p_new_data jsonb, p_reason text, p_actor_id uuid
    ) returns void language sql security definer set search_path = public as $$ select $$;

    create or replace function public.business_refresh_order_payment_status(p_order_id uuid)
    returns void language sql security definer set search_path = public as $$ select $$;
    create or replace function public.business_refresh_order_fulfillment_status(p_order_id uuid)
    returns void language sql security definer set search_path = public as $$ select $$;

    create or replace function public.update_business_order_v6(
      p_order_id uuid, p_expected_version int, p_customer_id uuid, p_order_date date,
      p_fulfillment_type public.business_fulfillment_type, p_currency public.currency_code,
      p_exchange_rate_to_cny numeric, p_shipping_fee numeric, p_tracking_number text,
      p_sales_notes text, p_items jsonb, p_payment_due_date date, p_reason text, p_shop_id uuid,
      p_salesperson_id uuid, p_external_order_number text, p_daily_shipping_date date,
      p_daily_shipping_number text, p_daily_payment_category public.daily_order_payment_category,
      p_total_product_received_amount numeric, p_total_product_received_overridden boolean,
      p_total_shipping_received_amount numeric, p_total_shipping_received_overridden boolean,
      p_total_sales_amount numeric, p_total_sales_overridden boolean,
      p_receivable_received_difference_reason text, p_payment_account text, p_order_fee numeric
    ) returns table (id uuid, order_number text, version int)
    language plpgsql security definer set search_path = public as $$
    declare
      v_order public.business_orders%rowtype;
    begin
      update public.business_orders bo
      set sales_notes = coalesce(current_setting('app.approval_request_id', true), '')
      where bo.id = p_order_id
      returning * into v_order;
      if not found then raise exception 'order not found'; end if;
      return query select v_order.id, v_order.order_number, v_order.version;
    end;
    $$;

    create or replace function public.update_business_order_v4(
      p_order_id uuid, p_expected_version int, p_customer_id uuid, p_order_date date,
      p_fulfillment_type public.business_fulfillment_type, p_currency public.currency_code,
      p_exchange_rate_to_cny numeric, p_shipping_fee numeric, p_tracking_number text,
      p_sales_notes text, p_items jsonb, p_payment_due_date date, p_reason text, p_shop_id uuid,
      p_salesperson_id uuid, p_external_order_number text, p_daily_shipping_date date,
      p_daily_shipping_number text, p_daily_payment_category public.daily_order_payment_category,
      p_total_product_received_amount numeric, p_total_product_received_overridden boolean,
      p_total_shipping_received_amount numeric, p_total_shipping_received_overridden boolean,
      p_total_sales_amount numeric, p_total_sales_overridden boolean,
      p_receivable_received_difference_reason text
    ) returns table (id uuid, order_number text, version int)
    language sql security definer set search_path = public as $$
      select p_order_id, 'v4-stub', 1 $$;

    create or replace function public.update_business_order_v4(
      p_order_id uuid, p_expected_version int, p_customer_id uuid, p_order_date date,
      p_fulfillment_type public.business_fulfillment_type, p_currency public.currency_code,
      p_exchange_rate_to_cny numeric, p_shipping_fee numeric, p_tracking_number text,
      p_sales_notes text, p_items jsonb, p_payment_due_date date, p_reason text, p_shop_id uuid,
      p_salesperson_id uuid, p_external_order_number text, p_daily_shipping_date date,
      p_daily_shipping_number text, p_daily_payment_category public.daily_order_payment_category,
      p_total_product_received_amount numeric, p_total_product_received_overridden boolean,
      p_total_shipping_received_amount numeric, p_total_shipping_received_overridden boolean,
      p_total_sales_amount numeric, p_total_sales_overridden boolean,
      p_receivable_received_difference_reason text, p_payment_account text
    ) returns table (id uuid, order_number text, version int)
    language sql security definer set search_path = public as $$
      select p_order_id, 'v4b-stub', 1 $$;

    create or replace function public.update_business_order_v5(
      p_order_id uuid, p_expected_version int, p_customer_id uuid, p_order_date date,
      p_fulfillment_type public.business_fulfillment_type, p_currency public.currency_code,
      p_exchange_rate_to_cny numeric, p_shipping_fee numeric, p_tracking_number text,
      p_sales_notes text, p_items jsonb, p_payment_due_date date, p_reason text, p_shop_id uuid,
      p_salesperson_id uuid, p_external_order_number text, p_daily_shipping_date date,
      p_daily_shipping_number text, p_daily_payment_category public.daily_order_payment_category,
      p_total_product_received_amount numeric, p_total_product_received_overridden boolean,
      p_total_shipping_received_amount numeric, p_total_shipping_received_overridden boolean,
      p_total_sales_amount numeric, p_total_sales_overridden boolean,
      p_receivable_received_difference_reason text, p_payment_account text
    ) returns table (id uuid, order_number text, version int)
    language sql security definer set search_path = public as $$
      select p_order_id, 'v5-stub', 1 $$;

    create or replace function public.adjust_business_order_items(
      p_order_id uuid, p_expected_version int, p_items jsonb,
      p_reason_type text, p_reason text, p_idempotency_key text
    ) returns jsonb language sql security definer set search_path = public as $$
      select jsonb_build_object(
        'order_id', p_order_id,
        'marker', coalesce(current_setting('app.approval_request_id', true), '')
      ) $$;

    create or replace function public.void_business_order(
      p_order_id uuid, p_expected_version int, p_reason text, p_idempotency_key text
    ) returns public.business_orders
    language plpgsql security definer set search_path = public as $$
    declare
      v_order public.business_orders%rowtype;
    begin
      update public.business_orders bo
      set status = 'voided', version = bo.version + 1
      where bo.id = p_order_id
      returning * into v_order;
      if not found then raise exception 'order not found'; end if;
      return v_order;
    end;
    $$;

    insert into public.profiles (id, role, status, chinese_name, full_name, email) values
      ('${ADMIN}', 'admin', 'approved', '管理员A', 'Admin A', 'a@example.com'),
      ('${ADMIN2}', 'admin', 'approved', '管理员B', 'Admin B', 'b@example.com'),
      ('${FINANCE}', 'finance', 'approved', '财务', 'Finance', 'f@example.com'),
      ('${SALES}', 'sales', 'approved', '业务一', 'Sales One', 's1@example.com'),
      ('${SALES2}', 'sales', 'approved', '业务二', 'Sales Two', 's2@example.com'),
      ('${SUPERVISOR}', 'supervisor', 'approved', '主管', 'Supervisor', 'sup@example.com'),
      ('${PENDING}', 'sales', 'pending', '待审', 'Pending', 'p@example.com');

    insert into public.business_orders (id, order_number, status, approval_status, total_sales_amount, salesperson_id, submitted_by) values
      ('${O1}', 'BO-1', 'approved', 'approved', 1200, '${SALES}', '${SALES}'),
      ('${O2}', 'BO-2', 'submitted', 'submitted', 800, '${SALES}', '${SALES}'),
      ('${O3}', 'BO-3', 'submitted', 'submitted', 500, '${SALES2}', '${SALES2}');

    insert into public.business_order_items (id, order_id) values ('${ITEM1}', '${O1}');
  `)

  const as = async (uid, fn) => {
    if (uid) {
      await db.exec(`set role authenticated; set request.jwt.claim.sub = '${uid}';`)
    } else {
      await db.exec('reset role; reset request.jwt.claim.sub;')
    }
    try {
      return await fn()
    } finally {
      await db.exec('reset role; reset request.jwt.claim.sub;')
    }
  }

  const one = async (sql, params) => {
    const result = await db.query(sql, params)
    return result.rows[0]
  }

  const expectError = async (uid, sql, params, pattern) => {
    let error
    try {
      await as(uid, () => db.query(sql, params))
    } catch (err) {
      error = err
    }
    assert.ok(error, `expected error: ${pattern}`)
    assert.match(String(error.message || error), pattern)
  }

  const callAssert = (uid, action, entityId, amount) =>
    as(uid, () => db.query('select public.approval_assert($1, $2, $3)', [action, entityId, amount]))

  // ---------- 1. 首次应用 + 二次幂等 ----------
  const migration = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/0141_approval_engine.sql'),
    'utf8',
  )
  await db.exec(migration)
  const rules = await db.query(
    `select action_key, enabled, approver_roles::text[], approver_ids, mode, allow_self_approval
     from public.approval_rules order by action_key`,
  )
  assert.equal(rules.rows.length, 5)
  assert.deepEqual(
    rules.rows.map((r) => [r.action_key, r.enabled]),
    [
      ['business_order.review', true],
      ['cost_override', false],
      ['item_adjust', false],
      ['order_edit', false],
      ['void_order', false],
    ],
    '默认只有订单审核启用',
  )
  const reviewRule = rules.rows.find((r) => r.action_key === 'business_order.review')
  assert.deepEqual(reviewRule.approver_roles, ['admin'])
  assert.equal(reviewRule.allow_self_approval, false)

  await db.exec(migration) // 幂等
  const ruleCount = await one('select count(*)::int as c from public.approval_rules')
  assert.equal(ruleCount.c, 5, '重复应用不会重复插入规则')

  // ---------- 2. 规则关闭时直接执行 ----------
  await callAssert(SALES, 'order_edit', O1, 1200)
  await callAssert(SALES, 'void_order', O1, 1200)
  await callAssert(FINANCE, 'cost_override', O1, 100)

  // ---------- 3. 订单审核：默认仅管理员，自审默认拦截 ----------
  assert.equal(await one('select public.can_review_business_order($1) as v', [O2]).then((r) => r.v), false,
    '未登录或非审核人不能审核')
  assert.equal(await as(SALES, () => one('select public.can_review_business_order($1) as v', [O2])).then((r) => r.v), false,
    '业务员不能审核')
  assert.equal(await as(SUPERVISOR, () => one('select public.can_review_business_order($1) as v', [O2])).then((r) => r.v), false,
    '默认主管不能审核')
  assert.equal(await as(ADMIN, () => one('select public.can_review_business_order($1) as v', [O2])).then((r) => r.v), true,
    '管理员可审核')

  await expectError(SALES, "select public.transition_business_order($1, 'approved', 'ok')", [O2], /Invalid business order transition/)
  await as(ADMIN, () => db.query("select public.transition_business_order($1, 'rejected', '资料不全')", [O2]))
  assert.equal(await one('select status::text as s from public.business_orders where id = $1', [O2]).then((r) => r.s), 'rejected',
    '默认规则下管理员可驳回')

  // ---------- 4. 放开订单审核角色：主管可审核 ----------
  await as(ADMIN, () =>
    db.query(
      `select public.admin_save_approval_rule(
         'business_order.review', '订单审核', true, '{}'::jsonb,
         '{supervisor}'::public.user_role[], '{}'::uuid[], 'any', false
       )`,
    ),
  )
  assert.equal(await as(SUPERVISOR, () => one('select public.can_review_business_order($1) as v', [O3])).then((r) => r.v), true,
    '主管被指定后可以审核')
  assert.equal(await as(ADMIN, () => one('select public.can_review_business_order($1) as v', [O3])).then((r) => r.v), false,
    '更换审核角色后管理员不再是审核人')
  await as(SUPERVISOR, () => db.query("select public.transition_business_order($1, 'approved', '通过')", [O3]))
  assert.equal(await one('select status::text as s from public.business_orders where id = $1', [O3]).then((r) => r.s), 'approved',
    '主管审核通过')

  // 指定账号审批
  await as(ADMIN, () =>
    db.query(
      `select public.admin_save_approval_rule(
         'business_order.review', '订单审核', true, '{}'::jsonb,
         '{}'::public.user_role[], array['${ADMIN2}']::uuid[], 'any', false
       )`,
    ),
  )
  assert.equal(await as(ADMIN2, () => one('select public.can_review_business_order($1) as v', [O3])).then((r) => r.v), true,
    '指定账号可以审核')

  // ---------- 5. 订单编辑：命中规则 → 发起 → 审核 → 自动执行 ----------
  await as(ADMIN, () =>
    db.query(
      `select public.admin_save_approval_rule(
         'order_edit', '订单编辑', true, '{}'::jsonb,
         '{admin}'::public.user_role[], '{}'::uuid[], 'any', false
       )`,
    ),
  )

  await expectError(
    SALES,
    `select * from public.update_business_order_v6(
       $1, 1, null, current_date, null, null, null, 0, null, null, '[]'::jsonb, null, null,
       null, $2, null, null, null, null, null, null, null, null, null, null, null, null, null
     )`,
    [O1, SALES],
    /APPROVAL_REQUIRED:order_edit/,
  )

  const check = await as(SALES, () =>
    one("select public.approval_check('order_edit', $1, 1200) as v", [O1]),
  )
  assert.equal(check.v.required, true)
  assert.equal(check.v.rule_name, '订单编辑')
  assert.equal(check.v.approvers.length, 2, '两名管理员都列为审核人')

  const payload = {
    order_id: O1,
    expected_version: 1,
    customer_id: null,
    order_date: '2026-11-05',
    fulfillment_type: null,
    currency: null,
    exchange_rate_to_cny: null,
    shipping_fee: 0,
    tracking_number: null,
    sales_notes: '审批后写入',
    items: [],
    payment_due_date: null,
    reason: '调整',
    shop_id: null,
    salesperson_id: SALES,
    external_order_number: null,
    daily_shipping_date: null,
    daily_shipping_number: null,
    daily_payment_category: null,
    total_product_received_amount: null,
    total_product_received_overridden: null,
    total_shipping_received_amount: null,
    total_shipping_received_overridden: null,
    total_sales_amount: 1200,
    total_sales_overridden: null,
    receivable_received_difference_reason: null,
    payment_account: null,
    order_fee: null,
  }

  const requestId = await as(SALES, () =>
    one(
      `select public.approval_request_create('order_edit', 'business_order', $1, $2, '修改订单金额', 1200) as id`,
      [O1, JSON.stringify(payload)],
    ),
  ).then((r) => r.id)

  await expectError(
    SALES,
    `select public.approval_request_create('order_edit', 'business_order', $1, $2, '重复提交', 1200)`,
    [O1, JSON.stringify(payload)],
    /已有待审批申请/,
  )

  assert.equal(await as(SALES, () => one('select public.approval_pending_count() as c')).then((r) => r.c), 0,
    '提交人不是审核人，看不到待办')
  assert.equal(await as(ADMIN, () => one('select public.approval_pending_count() as c')).then((r) => r.c), 1,
    '审核人看到待办')

  const decide = await as(ADMIN, () =>
    one("select public.approval_decide($1, 'approve', '同意') as v", [requestId]),
  )
  assert.equal(decide.v.status, 'applied', '审批通过后自动执行')
  const applied = await one(
    "select status, applied_at, payload->>'sales_notes' as notes from public.approval_requests where id = $1",
    [requestId],
  )
  assert.equal(applied.status, 'applied')
  assert.ok(applied.applied_at)
  assert.equal(
    await one('select sales_notes from public.business_orders where id = $1', [O1]).then((r) => r.sales_notes),
    requestId,
    '业务函数在审批上下文中执行并通过闸门',
  )

  // ---------- 6. 自审兜底：唯一审核人是自己时允许 ----------
  await as(ADMIN, () =>
    db.query(
      `select public.admin_save_approval_rule(
         'item_adjust', '订单加单/改行', true, '{}'::jsonb,
         '{}'::public.user_role[], array['${SALES}']::uuid[], 'any', false
       )`,
    ),
  )
  const adjustPayload = {
    order_id: O1,
    expected_version: 1,
    items: [],
    reason_type: 'append',
    reason: '补充',
    idempotency_key: 'k-adjust-1',
  }
  const adjustRequest = await as(SALES, () =>
    one(
      `select public.approval_request_create('item_adjust', 'business_order', $1, $2, '追加产品', 1200) as id`,
      [O1, JSON.stringify(adjustPayload)],
    ),
  ).then((r) => r.id)
  const selfDecide = await as(SALES, () =>
    one("select public.approval_decide($1, 'approve', null) as v", [adjustRequest]),
  )
  assert.equal(selfDecide.v.status, 'applied', '唯一审核人可自审兜底')

  // ---------- 7. 作废：仅管理员/财务发起，审核后自动执行 ----------
  await as(ADMIN, () =>
    db.query(
      `select public.admin_save_approval_rule(
         'void_order', '订单作废', true, '{}'::jsonb,
         '{admin}'::public.user_role[], '{}'::uuid[], 'any', false
       )`,
    ),
  )
  await expectError(
    SALES,
    `select public.approval_request_create('void_order', 'business_order', $1, '{}'::jsonb, '作废', 1200)`,
    [O1],
    /管理员或财务/,
  )
  const voidRequest = await as(FINANCE, () =>
    one(
      `select public.approval_request_create('void_order', 'business_order', $1, $2, '客户取消', 1200) as id`,
      [O1, JSON.stringify({ order_id: O1, expected_version: 1, reason: '客户取消', idempotency_key: 'k-void-1' })],
    ),
  ).then((r) => r.id)
  const voided = await as(ADMIN, () =>
    one("select public.approval_decide($1, 'approve', null) as v", [voidRequest]),
  )
  assert.equal(voided.v.status, 'applied')
  assert.equal(
    await one('select status::text as s from public.business_orders where id = $1', [O1]).then((r) => r.s),
    'voided',
    '作废审批通过后自动执行',
  )

  // ---------- 8. 成本覆盖：直写表也会被拦截，删除同样受控 ----------
  await as(ADMIN, () =>
    db.query(
      `select public.admin_save_approval_rule(
         'cost_override', '成本覆盖', true, '{}'::jsonb,
         '{admin}'::public.user_role[], '{}'::uuid[], 'any', false
       )`,
    ),
  )
  await expectError(
    FINANCE,
    'insert into public.finance_business_order_item_cost_overrides (business_order_item_id, cost) values ($1, 88)',
    [ITEM1],
    /APPROVAL_REQUIRED:cost_override/,
  )
  const costRequest = await as(FINANCE, () =>
    one(
      `select public.approval_request_create('cost_override', 'business_order', $1, $2, '补充成本', 88) as id`,
      [O1, JSON.stringify({ order_id: O1, item_ids: [ITEM1], cost: 88 })],
    ),
  ).then((r) => r.id)
  const costApplied = await as(ADMIN, () =>
    one("select public.approval_decide($1, 'approve', null) as v", [costRequest]),
  )
  assert.equal(costApplied.v.status, 'applied')
  assert.equal(
    await one('select cost from public.finance_business_order_item_cost_overrides where business_order_item_id = $1', [ITEM1])
      .then((r) => Number(r.cost)),
    88,
  )
  await expectError(
    FINANCE,
    'delete from public.finance_business_order_item_cost_overrides where business_order_item_id = $1',
    [ITEM1],
    /APPROVAL_REQUIRED:cost_override/,
  )
  const clearRequest = await as(FINANCE, () =>
    one(
      `select public.approval_request_create('cost_override', 'business_order', $1, $2, '清空成本', null) as id`,
      [O1, JSON.stringify({ order_id: O1, item_ids: [ITEM1], cost: null })],
    ),
  ).then((r) => r.id)
  const cleared = await as(ADMIN, () =>
    one("select public.approval_decide($1, 'approve', null) as v", [clearRequest]),
  )
  assert.equal(cleared.v.status, 'applied')
  assert.equal(
    await one('select count(*)::int as c from public.finance_business_order_item_cost_overrides where business_order_item_id = $1', [ITEM1])
      .then((r) => r.c),
    0,
  )

  // ---------- 9. 执行失败可重试 ----------
  const MISSING_ITEM = '40000000-0000-4000-8000-00000000ffff'
  const failedRequest = await as(FINANCE, () =>
    one(
      `select public.approval_request_create('cost_override', 'business_order', $1, $2, '待补成本', 66) as id`,
      [O1, JSON.stringify({ order_id: O1, item_ids: [MISSING_ITEM], cost: 66 })],
    ),
  ).then((r) => r.id)
  const failed = await as(ADMIN, () =>
    one("select public.approval_decide($1, 'approve', null) as v", [failedRequest]),
  )
  assert.equal(failed.v.status, 'apply_failed')
  assert.ok(failed.v.error)
  assert.equal(
    await one('select status from public.approval_requests where id = $1', [failedRequest]).then((r) => r.status),
    'apply_failed',
  )
  await db.exec(`insert into public.business_order_items (id, order_id) values ('${MISSING_ITEM}', '${O1}')`)
  const retried = await as(ADMIN, () =>
    one('select public.approval_retry($1) as v', [failedRequest]),
  )
  assert.equal(retried.v.status, 'applied', '补数据后重试成功')
  assert.equal(
    await one('select cost from public.finance_business_order_item_cost_overrides where business_order_item_id = $1', [MISSING_ITEM])
      .then((r) => Number(r.cost)),
    66,
  )

  // ---------- 10. 审批箱 ----------
  const pendingBox = await as(ADMIN, () => one("select public.approval_inbox('pending') as v"))
  assert.ok(Array.isArray(pendingBox.v))
  const mineBox = await as(FINANCE, () => one("select public.approval_inbox('mine') as v"))
  assert.ok(mineBox.v.length >= 3, '发起人能看到自己的申请')
  const doneBox = await as(ADMIN, () => one("select public.approval_inbox('done') as v"))
  assert.ok(doneBox.v.length >= 4, '审核人能看到已处理记录')

  // ---------- 11. 旧版编辑 RPC 不再可直调 ----------
  await expectError(
    SALES,
    `select * from public.update_business_order_v4(${Array.from({ length: 27 }, (_, i) => `$${i + 1}`).join(',')})`,
    [
      O1, 1, null, '2026-11-05', null, null, null, 0, null, null, '[]', null, null, null,
      SALES, null, null, null, null, null, null, null, null, null, null, null, null,
    ],
    /permission denied/,
  )

  // ---------- 12. 不支持的规则/动作被拒绝 ----------
  await expectError(
    ADMIN,
    `select public.admin_save_approval_rule('unknown.action', 'x', false, '{}'::jsonb, '{}'::public.user_role[], '{}'::uuid[], 'any', false)`,
    [],
    /不支持的审批动作/,
  )
  await expectError(
    ADMIN,
    `select public.admin_save_approval_rule('order_edit', 'x', true, '{}'::jsonb, '{}'::public.user_role[], '{}'::uuid[], 'any', false)`,
    [],
    /至少一位审核人/,
  )
  await expectError(
    ADMIN,
    `select public.admin_save_approval_rule('order_edit', 'x', true, '{}'::jsonb, '{}'::public.user_role[], array['${PENDING}']::uuid[], 'any', false)`,
    [],
    /已通过审核的账号/,
  )

  // ---------- 13. 关闭订单审核后提交即通过 ----------
  await db.exec(`
    insert into public.business_orders (id, order_number, status, approval_status, total_sales_amount, salesperson_id)
    values ('${O4}', 'BO-4', 'draft', 'draft', 300, '${SALES}');
    insert into public.business_order_items (id, order_id) values ('${ITEM4}', '${O4}');
  `)
  await as(ADMIN, () =>
    db.query(
      `select public.admin_save_approval_rule(
         'business_order.review', '订单审核', false, '{}'::jsonb,
         '{admin}'::public.user_role[], '{}'::uuid[], 'any', false
       )`,
    ),
  )
  await as(SALES, () =>
    db.query("select public.transition_business_order($1, 'submitted', '提交')", [O4]),
  )
  const autoApproved = await one(
    `select status::text as status, approval_status as approval_status,
            reviewed_at is not null as reviewed
     from public.business_orders where id = $1`,
    [O4],
  )
  assert.deepEqual(
    [autoApproved.status, autoApproved.approval_status, autoApproved.reviewed],
    ['approved', 'approved', true],
    '订单审核关闭后提交即视为通过',
  )

  await db.close()
  console.log('verify-0141-approval-engine: all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
