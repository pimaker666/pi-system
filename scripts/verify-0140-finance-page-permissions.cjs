const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')

const ADMIN = '10000000-0000-4000-8000-000000000001'
const FINANCE = '10000000-0000-4000-8000-000000000002'
const SALES = '10000000-0000-4000-8000-000000000003'
const SUPERVISOR = '10000000-0000-4000-8000-000000000004'
const PENDING = '10000000-0000-4000-8000-000000000005'
const GRANTED_LEGACY = '10000000-0000-4000-8000-000000000006'
const DENIED_LEGACY = '10000000-0000-4000-8000-000000000007'

const PAGES = [
  'finance.page.overview',
  'finance.page.journal',
  'finance.page.costs',
  'finance.page.settled_orders',
  'finance.page.profit',
  'finance.page.commission_settled',
]

const TEMPLATES = {
  admin: { finance: { view: true, financial_number: true, cost: true, profit: true, exchange_rate: true } },
  finance: { finance: { view: true, financial_number: true, cost: true, profit: true, exchange_rate: true } },
  supervisor: { finance: { view: false, financial_number: false, cost: false, profit: false, exchange_rate: false } },
  sales: { finance: { view: false, financial_number: false, cost: false, profit: false, exchange_rate: false } },
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
      ('${PENDING}', 'sales', 'pending'),
      ('${GRANTED_LEGACY}', 'supervisor', 'approved'),
      ('${DENIED_LEGACY}', 'sales', 'approved');

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
      allowed_permissions jsonb not null default '[]'::jsonb,
      denied_permissions jsonb not null default '[]'::jsonb,
      data_scope text,
      sensitive_fields jsonb not null default '{}'::jsonb,
      expires_at timestamptz,
      updated_by uuid,
      updated_at timestamptz not null default now()
    );
  `)

  for (const role of Object.keys(TEMPLATES)) {
    await db.exec(
      `insert into public.permission_templates (system_role, name, permissions)
       values ('${role}', '${role}', ${json(TEMPLATES[role])})`,
    )
  }

  await db.exec(`
    insert into public.profile_permission_overrides (profile_id, allowed_permissions, denied_permissions)
    values
      ('${GRANTED_LEGACY}', ${json(['finance.view', 'finance.financial_number'])}, '[]'::jsonb),
      ('${DENIED_LEGACY}', '[]'::jsonb, ${json(['finance.view'])});
  `)

  // 生产依赖的判定函数（0095 版本）
  await db.exec(`
    create or replace function public.has_current_permission(p_permission text)
    returns boolean
    language plpgsql
    security definer
    set search_path = public
    stable
    as $$
    declare
      v_profile public.profiles%rowtype;
      v_template public.permission_templates%rowtype;
      v_override public.profile_permission_overrides%rowtype;
    begin
      if nullif(btrim(p_permission), '') is null then
        return false;
      end if;

      select * into v_profile
      from public.profiles
      where id = (select auth.uid());
      if not found or v_profile.status::text <> 'approved' then
        return false;
      end if;

      select * into v_template
      from public.permission_templates
      where system_role = v_profile.role;

      select * into v_override
      from public.profile_permission_overrides
      where profile_id = v_profile.id
        and (expires_at is null or expires_at > now());

      if found and v_override.denied_permissions ? p_permission then
        return false;
      end if;
      if found and v_override.allowed_permissions ? p_permission then
        return true;
      end if;

      return coalesce(
        v_template.permissions #> string_to_array(p_permission, '.'),
        'false'::jsonb
      ) = 'true'::jsonb;
    end;
    $$;
  `)

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

  const templateValue = async (role, permission) => {
    const row = await db.query(
      `select permissions #> string_to_array('${permission}', '.') as v
       from public.permission_templates where system_role = '${role}'`,
    )
    return row.rows[0].v
  }

  const permissionMap = (uid, keys) =>
    as(uid, async () => {
      const row = await db.query(
        `select public.current_permission_map(array[${keys.map((k) => `'${k}'`).join(',')}]::text[]) as v`,
      )
      return row.rows[0].v
    })

  const overrideKeys = async (uid, column) => {
    const row = await db.query(
      `select ${column} as v from public.profile_permission_overrides where profile_id = '${uid}'`,
    )
    return row.rows[0].v
  }

  // ---------- 1. 应用 0140（两遍验证幂等） ----------
  const migration = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/0140_finance_page_permissions.sql'),
    'utf8',
  )
  await db.exec(migration)
  await db.exec(migration)

  // ---------- 2. 模板默认值 ----------
  for (const role of ['admin', 'finance']) {
    for (const key of PAGES) {
      assert.equal(await templateValue(role, key), true, `${role} 默认拥有 ${key}`)
    }
  }
  for (const role of ['sales', 'supervisor']) {
    for (const key of PAGES) {
      assert.equal(await templateValue(role, key), false, `${role} 默认没有 ${key}`)
    }
  }
  assert.equal(await templateValue('admin', 'finance.view'), true, '保留旧 finance.view 键')
  assert.equal(await templateValue('finance', 'finance.exchange_rate'), true, '不影响既有敏感字段类权限')

  // ---------- 3. 例外回填：放行/禁止都跟随旧键 ----------
  assert.deepEqual(
    [...(await overrideKeys(GRANTED_LEGACY, 'allowed_permissions'))].sort(),
    [...['finance.view', 'finance.financial_number', ...PAGES]].sort(),
    '原允许 finance.view 的账号回填六个页面键',
  )
  assert.deepEqual(
    [...(await overrideKeys(DENIED_LEGACY, 'denied_permissions'))].sort(),
    [...['finance.view', ...PAGES]].sort(),
    '原禁止 finance.view 的账号回填六个页面禁止键',
  )

  // ---------- 4. current_permission_map 判定 ----------
  assert.deepEqual(
    await permissionMap(ADMIN, PAGES),
    Object.fromEntries(PAGES.map((k) => [k, true])),
    '管理员六页全开',
  )
  assert.deepEqual(
    await permissionMap(SALES, PAGES),
    Object.fromEntries(PAGES.map((k) => [k, false])),
    '业务员六页全关',
  )
  assert.deepEqual(
    await permissionMap(SALES, ['finance.exchange_rate']),
    { 'finance.exchange_rate': false },
    '未知/其他键同样返回布尔值',
  )
  assert.deepEqual(
    await permissionMap(SUPERVISOR, [...PAGES, 'finance.page.unknown']),
    Object.fromEntries([...PAGES, 'finance.page.unknown'].map((k) => [k, false])),
    '未配置键返回 false',
  )

  // 单独放行的主管：只开 overview 一项
  await db.exec(`
    insert into public.profile_permission_overrides (profile_id, allowed_permissions, denied_permissions)
    values ('${SUPERVISOR}', '["finance.page.overview"]'::jsonb, '[]'::jsonb)
    on conflict (profile_id) do update
    set allowed_permissions = excluded.allowed_permissions,
        denied_permissions = excluded.denied_permissions
  `)
  assert.deepEqual(
    await permissionMap(SUPERVISOR, PAGES),
    Object.fromEntries(PAGES.map((k) => [k, k === 'finance.page.overview'])),
    '例外只放行 overview',
  )

  // 过期例外不生效
  await db.exec(`
    update public.profile_permission_overrides
    set expires_at = now() - interval '1 hour'
    where profile_id = '${SUPERVISOR}'
  `)
  assert.deepEqual(
    await permissionMap(SUPERVISOR, PAGES),
    Object.fromEntries(PAGES.map((k) => [k, false])),
    '过期例外被忽略',
  )

  assert.deepEqual(
    await permissionMap(PENDING, PAGES),
    Object.fromEntries(PAGES.map((k) => [k, false])),
    '未审核账号全部不通过',
  )
  assert.deepEqual(
    await permissionMap(null, PAGES),
    Object.fromEntries(PAGES.map((k) => [k, false])),
    '未登录全部不通过',
  )

  // ---------- 5. 入参与越权保护 ----------
  assert.deepEqual(await permissionMap(ADMIN, []), {}, '空数组返回空对象')
  await assert.rejects(
    async () => {
      const tooMany = Array.from({ length: 101 }, (_, i) => `x.${i}`)
      await as(ADMIN, () => db.query(
        `select public.current_permission_map(array[${tooMany.map((k) => `'${k}'`).join(',')}]::text[])`,
      ))
    },
    /Too many permissions/i,
    '超过 100 个权限点直接拒绝',
  )
  await assert.rejects(
    () => db.exec(`set role anon; select public.current_permission_map(array['finance.page.overview']::text[])`),
    /permission denied/i,
    'anon 不可执行 current_permission_map',
  )
  await db.exec('reset role')

  console.log('✓ 0140 财务页面级权限演练通过')
}

main().catch((error) => {
  console.error('✗ 0140 演练失败：', error.message)
  process.exit(1)
})
