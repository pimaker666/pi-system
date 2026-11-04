const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')

const ADMIN = '10000000-0000-4000-8000-000000000001'
const FINANCE = '10000000-0000-4000-8000-000000000002'
const SALES = '10000000-0000-4000-8000-000000000003'
const SUPERVISOR = '10000000-0000-4000-8000-000000000004'
const PENDING = '10000000-0000-4000-8000-000000000005'

// 0090 种子模板（与本迁移相关的键）
const TEMPLATES = {
  admin: {
    orders: { view: true, create: true, edit: true, void: true, approve: true, ship: true, export: true, record_transfer: true },
    finance: { view: true, financial_number: true, cost: true, profit: true, exchange_rate: true },
    products: { view: true, edit: true },
    customers: { view: true, edit: true },
    pi: { view: true, create: true, edit: true, void: true },
    system: { manage_users: true, manage_permissions: true, view_audit: true },
  },
  finance: {
    orders: { view: true, create: false, edit: false, void: false, approve: false, ship: false, export: true, record_transfer: true },
    finance: { view: true, financial_number: true, cost: true, profit: true, exchange_rate: true },
    products: { view: true, edit: false },
    customers: { view: true, edit: false },
    pi: { view: true, create: false, edit: false, void: false },
    system: { manage_users: false, manage_permissions: false, view_audit: true },
  },
  supervisor: {
    orders: { view: true, create: true, edit: true, void: false, approve: false, ship: true, export: true, record_transfer: false },
    finance: { view: false, financial_number: false, cost: false, profit: false, exchange_rate: false },
    products: { view: true, edit: true },
    customers: { view: true, edit: true },
    pi: { view: true, create: true, edit: true, void: true },
    system: { manage_users: false, manage_permissions: false, view_audit: false },
  },
  sales: {
    orders: { view: true, create: true, edit: true, void: false, approve: false, ship: true, export: true, record_transfer: false },
    finance: { view: false, financial_number: false, cost: false, profit: false, exchange_rate: false },
    products: { view: true, edit: true },
    customers: { view: true, edit: true },
    pi: { view: true, create: true, edit: true, void: true },
    system: { manage_users: false, manage_permissions: false, view_audit: false },
  },
}

const SENSITIVE = {
  admin: { financial_number: true, product_name: true, cost: true, profit: true, exchange_rate: true },
  finance: { financial_number: true, product_name: true, cost: true, profit: true, exchange_rate: true },
  supervisor: { financial_number: false, product_name: true, cost: false, profit: false, exchange_rate: false },
  sales: { financial_number: false, product_name: true, cost: false, profit: false, exchange_rate: false },
}

function json(value) {
  return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`
}

async function main() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;
    grant usage on schema public to authenticated, anon;

    create table public.profiles (
      id uuid primary key,
      role text not null,
      status text not null
    );
    insert into profiles values
      ('${ADMIN}', 'admin', 'approved'),
      ('${FINANCE}', 'finance', 'approved'),
      ('${SALES}', 'sales', 'approved'),
      ('${SUPERVISOR}', 'supervisor', 'approved'),
      ('${PENDING}', 'sales', 'pending');

    create table public.permission_templates (
      system_role text primary key,
      name text,
      description text not null default '',
      permissions jsonb not null default '{}'::jsonb,
      data_scope text not null default 'self',
      sensitive_fields jsonb not null default '{}'::jsonb,
      updated_by uuid,
      updated_at timestamptz not null default now()
    );

    create table public.profile_permission_overrides (
      profile_id uuid primary key references public.profiles(id),
      allowed_permissions text[] not null default '{}',
      denied_permissions text[] not null default '{}',
      data_scope text,
      sensitive_fields jsonb not null default '{}'::jsonb,
      expires_at timestamptz,
      updated_by uuid,
      updated_at timestamptz not null default now()
    );
  `)

  for (const role of Object.keys(TEMPLATES)) {
    await db.exec(
      `insert into public.permission_templates (system_role, name, permissions, data_scope, sensitive_fields)
       values ('${role}', '${role}', ${json(TEMPLATES[role])}, 'self', ${json(SENSITIVE[role])})`,
    )
  }

  const as = async (uid, fn) => {
    if (uid) {
      await db.exec(`set role authenticated; set request.jwt.claim.sub = '${uid}';`)
    } else {
      await db.exec(`reset role; reset request.jwt.claim.sub;`)
    }
    try {
      return await fn()
    } finally {
      await db.exec('reset role; reset request.jwt.claim.sub;')
    }
  }

  const templateValue = async (role, path) => {
    const row = await db.query(
      `select permissions #> string_to_array('${path}', '.') as v
       from public.permission_templates where system_role = '${role}'`,
    )
    return row.rows[0].v
  }

  const sensitiveFields = (uid) =>
    as(uid, async () => {
      const row = await db.query(`select public.current_sensitive_fields() as v`)
      return row.rows[0].v
    })

  // ---------- 1. 应用 0139（两遍验证幂等） ----------
  const migration = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/0139_permission_wiring.sql'),
    'utf8',
  )
  await db.exec(migration)
  await db.exec(migration)

  // ---------- 2. 模板默认值：接线不回退既有能力 ----------
  assert.equal(await templateValue('finance', 'orders.void'), true, '财务模板 orders.void 补 true（现状财务可作废）')
  assert.equal(await templateValue('sales', 'orders.record_transfer'), true, '业务员模板 record_transfer 补 true（现状业务可登记转账）')
  assert.equal(await templateValue('supervisor', 'orders.record_transfer'), true, '主管模板 record_transfer 补 true')
  assert.equal(await templateValue('admin', 'orders.void'), true, '管理员模板 orders.void 保持 true')

  // ---------- 3. 新权限点 ----------
  assert.equal(await templateValue('admin', 'attendance.manage'), true, '管理员有考勤工资管理')
  assert.equal(await templateValue('admin', 'company.settings'), true, '管理员有公司设置')
  assert.equal(await templateValue('admin', 'reimbursement.review'), true, '管理员有报销审批')
  assert.equal(await templateValue('finance', 'attendance.manage'), true, '财务有考勤工资管理（现状即可维护）')
  assert.equal(await templateValue('finance', 'company.settings'), false, '财务默认无公司设置（保持现状仅管理员）')
  assert.equal(await templateValue('finance', 'reimbursement.review'), false, '财务默认无报销审批（保持现状仅管理员）')
  assert.equal(await templateValue('sales', 'attendance.manage'), false, '业务员无考勤工资管理')
  assert.equal(await templateValue('sales', 'company.settings'), false, '业务员无公司设置')
  assert.equal(await templateValue('sales', 'reimbursement.review'), false, '业务员无报销审批')
  assert.equal(await templateValue('supervisor', 'attendance.manage'), false, '主管无考勤工资管理')

  // ---------- 4. current_sensitive_fields：模板口径 ----------
  assert.deepEqual(
    await sensitiveFields(FINANCE),
    { financial_number: true, product_name: true, cost: true, profit: true, exchange_rate: true },
    '财务敏感字段=模板全量',
  )
  assert.deepEqual(
    await sensitiveFields(SALES),
    { financial_number: false, product_name: true, cost: false, profit: false, exchange_rate: false },
    '业务员敏感字段=模板',
  )

  // ---------- 5. 例外按键合并：未设置的键继承模板 ----------
  await db.exec(
    `insert into public.profile_permission_overrides (profile_id, sensitive_fields)
     values ('${SALES}', '{"cost": true}')`,
  )
  assert.deepEqual(
    await sensitiveFields(SALES),
    { financial_number: false, product_name: true, cost: true, profit: false, exchange_rate: false },
    '例外只覆盖 cost，其余键继承模板',
  )

  // 过期例外不生效
  await db.exec(
    `update public.profile_permission_overrides
     set sensitive_fields = '{"cost": true, "profit": true}', expires_at = now() - interval '1 hour'
     where profile_id = '${SALES}'`,
  )
  assert.deepEqual(
    await sensitiveFields(SALES),
    { financial_number: false, product_name: true, cost: false, profit: false, exchange_rate: false },
    '过期例外被忽略',
  )

  // ---------- 6. 未审核/未登录返回空对象 ----------
  assert.deepEqual(await sensitiveFields(PENDING), {}, '未审核账号返回空对象')
  assert.deepEqual(await sensitiveFields(null), {}, '未登录返回空对象')

  // ---------- 7. anon 不可执行 ----------
  await assert.rejects(
    () => db.exec(`set role anon; select public.current_sensitive_fields()`),
    /permission denied/i,
    'anon 不可执行 current_sensitive_fields',
  )
  await db.exec('reset role')

  console.log('✓ 0139 权限接线演练通过')
}

main().catch((error) => {
  console.error('✗ 0139 演练失败：', error.message)
  process.exit(1)
})
