const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')

const FINANCE = '10000000-0000-4000-8000-000000000001'
const SALES = '10000000-0000-4000-8000-000000000002'
const OPS = '10000000-0000-4000-8000-000000000003'
const PENDING = '10000000-0000-4000-8000-000000000004'

const migration = (name) =>
  fs.readFileSync(path.join(__dirname, '../supabase/migrations', name), 'utf8')

async function main() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;
    create table public.profiles (
      id uuid primary key,
      role text not null,
      status text not null,
      full_name text,
      chinese_name text,
      email text,
      created_at timestamptz not null default now()
    );
    insert into profiles values
      ('${FINANCE}', 'finance', 'approved', '周乐晶', null, 'fin@test.com', '2026-01-01'),
      ('${SALES}', 'sales', 'approved', '朱可欣', '可欣', 'sales@test.com', '2026-02-01'),
      ('${OPS}', 'admin', 'approved', '运营甲', null, 'ops@test.com', '2026-03-01'),
      ('${PENDING}', 'sales', 'pending', '待审乙', null, 'pending@test.com', '2026-04-01');
    create function public.is_finance_or_admin() returns boolean language sql security definer as $$
      select exists(select 1 from profiles where id = auth.uid() and role in ('admin', 'finance') and status = 'approved') $$;
    create function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
    grant usage on schema public to authenticated, anon;
    grant select, delete on public.profiles to authenticated;
  `)

  await db.exec(migration('0122_payroll_attendance.sql'))
  await db.exec(migration('0129_payroll_autofill.sql'))
  await db.exec(migration('0133_payroll_publish_lock.sql'))

  const as = async (uid, fn) => {
    await db.exec(`set role authenticated; set request.jwt.claim.sub = '${uid}';`)
    try {
      return await fn()
    } finally {
      await db.exec('reset role; reset request.jwt.claim.sub;')
    }
  }

  // 存量数据：朱可欣已有薪资档案与一条工资明细，运营甲尚未建档案，待审乙不该进档案
  const seeded = await as(FINANCE, async () => {
    const sheet = await db.query(`insert into public.payroll_sheets(period_month, full_attendance_days, created_by)
      values ('2026-10-01', 19, auth.uid()) returning id`)
    await db.query(`insert into public.payroll_salary_profiles(profile_id, base_salary, social_insurance, housing_fund, updated_by)
      values ('${SALES}', 8500, 520.5, 420, auth.uid())`)
    await db.query(`insert into public.payroll_items(sheet_id, profile_id, sort_order, base_salary)
      values ('${sheet.rows[0].id}', '${SALES}', 1, 8500)`)
    return { sheetId: sheet.rows[0].id }
  })

  await db.exec(migration('0147_payroll_staff_roster.sql'))

  // ---------- 1. 结构：代理主键、可空 profile、姓名、排序 ----------
  const cols = await db.query(`
    select column_name, is_nullable, data_type from information_schema.columns
    where table_schema='public' and table_name='payroll_salary_profiles'
      and column_name in ('id','profile_id','name','sort_order') order by column_name`)
  const byName = Object.fromEntries(cols.rows.map((row) => [row.column_name, row]))
  assert.equal(byName.id.is_nullable, 'NO', 'id 非空')
  assert.equal(byName.profile_id.is_nullable, 'YES', 'profile_id 可空')
  assert.equal(byName.name.is_nullable, 'NO', 'name 非空')
  assert.equal(byName.sort_order.is_nullable, 'NO', 'sort_order 非空')

  const pk = await db.query(`
    select a.attname from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
    where i.indrelid='public.payroll_salary_profiles'::regclass and i.indisprimary`)
  assert.deepEqual(pk.rows.map((row) => row.attname), ['id'], '主键改为 id')

  const itemCols = await db.query(`
    select column_name, is_nullable from information_schema.columns
    where table_schema='public' and table_name='payroll_items'
      and column_name in ('salary_profile_id','employee_name','profile_id')`)
  const itemByName = Object.fromEntries(itemCols.rows.map((row) => [row.column_name, row]))
  assert.equal(itemByName.profile_id.is_nullable, 'YES', '明细 profile_id 可空')
  assert.equal(itemByName.employee_name.is_nullable, 'NO', '明细姓名快照非空')
  assert.ok(itemByName.salary_profile_id, '明细有 salary_profile_id')

  // ---------- 2. 回填：已启用账号自动建档，待审账号不建 ----------
  const roster = await db.query(`
    select sp.id, sp.profile_id, sp.name, sp.base_salary, sp.sort_order
    from public.payroll_salary_profiles sp order by sp.profile_id`)
  assert.equal(roster.rows.length, 3, '三个已启用账号（含财务）都建档')
  const salesRow = roster.rows.find((row) => row.profile_id === SALES)
  const opsRow = roster.rows.find((row) => row.profile_id === OPS)
  assert.ok(salesRow && opsRow, '朱可欣、运营甲都在档案中')
  assert.ok(
    roster.rows.some((row) => row.profile_id === FINANCE),
    '财务账号一并建档',
  )
  assert.equal(salesRow.name, '可欣', '姓名取中文名')
  assert.equal(Number(salesRow.base_salary), 8500, '存量档案金额保留')
  assert.ok(!roster.rows.some((row) => row.profile_id === PENDING), '待审账号不建档')
  assert.ok(Number(opsRow.sort_order) > 0 && Number(salesRow.sort_order) > 0, '排序已回填')

  const item = await db.query(
    `select employee_name, salary_profile_id from public.payroll_items where sheet_id='${seeded.sheetId}'`,
  )
  assert.equal(item.rows[0].employee_name, '可欣', '明细姓名快照回填')
  assert.equal(item.rows[0].salary_profile_id, salesRow.id, '明细关联档案回填')

  // ---------- 3. 无账号人员：可建档、可入表、档案删除保留快照 ----------
  const manual = await as(FINANCE, async () => {
    const created = await db.query(`
      insert into public.payroll_salary_profiles(profile_id, name, base_salary, social_insurance, housing_fund, sort_order)
      values (null, '临时包装工', 6000, 0, 0, 99) returning id`)
    const id = created.rows[0].id
    await db.query(`insert into public.payroll_items(sheet_id, profile_id, salary_profile_id, employee_name, sort_order, base_salary)
      values ('${seeded.sheetId}', null, '${id}', '临时包装工', 2, 6000)`)
    // 同表同档案只能一行
    await assert.rejects(
      () =>
        db.query(`insert into public.payroll_items(sheet_id, profile_id, salary_profile_id, employee_name, sort_order)
          values ('${seeded.sheetId}', null, '${id}', '临时包装工', 3)`),
      /uq_payroll_items_sheet_salary_profile|duplicate key/i,
    )
    // 再建一个无账号人员：多个 NULL profile_id 不冲突
    const second = await db.query(`
      insert into public.payroll_salary_profiles(name, sort_order) values ('临时司机', 100) returning id`)
    assert.ok(second.rows[0].id, '允许第二名无账号人员')
    return { id, secondId: second.rows[0].id }
  })

  await as(FINANCE, async () => {
    await db.query(`delete from public.payroll_salary_profiles where id='${manual.id}'`)
    const kept = await db.query(
      `select salary_profile_id, employee_name from public.payroll_items where employee_name='临时包装工'`,
    )
    assert.equal(kept.rows[0].salary_profile_id, null, '删除档案后明细归档为空')
    assert.equal(kept.rows[0].employee_name, '临时包装工', '删除档案后姓名快照保留')
  })

  // ---------- 4. 守卫：内容变更纳入新列；员工仍不能动金额 ----------
  const guardBody = await db.query(
    `select prosrc from pg_proc where proname='payroll_item_guard' limit 1`,
  )
  assert.match(guardBody.rows[0].prosrc, /salary_profile_id is distinct from old\.salary_profile_id/)
  assert.match(guardBody.rows[0].prosrc, /employee_name is distinct from old\.employee_name/)

  await as(SALES, async () => {
    await assert.rejects(
      () =>
        db.query(
          `update public.payroll_items set base_salary = 9999 where employee_name='可欣'`,
        ),
      /Employees can only confirm or reject/,
    )
  })

  console.log('✓ 0147 工资花名册演练通过')
}

main().catch((error) => {
  console.error('✗ 0147 演练失败：', error.message)
  process.exit(1)
})
