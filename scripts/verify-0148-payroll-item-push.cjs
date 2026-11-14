const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')

const FINANCE = '10000000-0000-4000-8000-000000000001'
const SALES = '10000000-0000-4000-8000-000000000002'
const OPS = '10000000-0000-4000-8000-000000000003'

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
      ('${OPS}', 'admin', 'approved', '运营甲', null, 'ops@test.com', '2026-03-01');
    create function public.is_finance_or_admin() returns boolean language sql security definer as $$
      select exists(select 1 from profiles where id = auth.uid() and role in ('admin', 'finance') and status = 'approved') $$;
    create function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
    grant usage on schema public to authenticated, anon;
    grant select, delete on public.profiles to authenticated;
  `)

  await db.exec(migration('0122_payroll_attendance.sql'))
  await db.exec(migration('0129_payroll_autofill.sql'))
  await db.exec(migration('0133_payroll_publish_lock.sql'))
  await db.exec(migration('0147_payroll_staff_roster.sql'))

  const as = async (uid, fn) => {
    await db.exec(`set role authenticated; set request.jwt.claim.sub = '${uid}';`)
    try {
      return await fn()
    } finally {
      await db.exec('reset role; reset request.jwt.claim.sub;')
    }
  }

  const seed = await as(FINANCE, async () => {
    const sheet = await db.query(`insert into public.payroll_sheets(period_month, full_attendance_days, created_by)
      values ('2026-10-01', 19, auth.uid()) returning id`)
    const item = await db.query(`insert into public.payroll_items(sheet_id, profile_id, employee_name, sort_order, base_salary)
      values ('${sheet.rows[0].id}', '${SALES}', '朱可欣', 1, 8500) returning id`)
    const manual = await db.query(`insert into public.payroll_items(sheet_id, profile_id, employee_name, sort_order, base_salary)
      values ('${sheet.rows[0].id}', null, '临时工', 2, 3000) returning id`)
    return { sheetId: sheet.rows[0].id, itemId: item.rows[0].id, manualId: manual.rows[0].id }
  })

  // ---------- 1. 灰度前：草稿表员工看不到 ----------
  const before = await as(SALES, async () => {
    const sheets = await db.query('select id from public.payroll_sheets')
    return sheets.rows.length
  })
  assert.equal(before, 0, '草稿表员工看不到表头（页面按表过滤）')

  await db.exec(migration('0148_payroll_item_push.sql'))

  // ---------- 2. 结构：pushed_at 列存在 ----------
  const col = await db.query(`
    select data_type, is_nullable from information_schema.columns
    where table_schema='public' and table_name='payroll_items' and column_name='pushed_at'`)
  assert.equal(col.rows.length, 1, 'pushed_at 列已创建')
  assert.equal(col.rows[0].is_nullable, 'YES', 'pushed_at 可空')

  // ---------- 3. 无账号人员不能推送 ----------
  await db.exec(migration('0148_payroll_item_push.sql'))
  const publishAsFinance = () =>
    as(FINANCE, () => db.query(`select public.publish_payroll_sheet('${seed.sheetId}')`))

  // ---------- 4. 整表推送：账号行有 pushed_at，无账号行为空 ----------
  await publishAsFinance()
  const rows = await db.query(
    `select id, profile_id, pushed_at from public.payroll_items where sheet_id='${seed.sheetId}' order by sort_order`,
  )
  const salesRow = rows.rows.find((row) => row.id === seed.itemId)
  const manualRow = rows.rows.find((row) => row.id === seed.manualId)
  assert.ok(salesRow.pushed_at, '账号员工整表推送后有 pushed_at')
  assert.equal(manualRow.pushed_at, null, '无账号人员不推送')

  // ---------- 5. 员工可见性：只看到本人已推送行 ----------
  const afterPublish = await as(SALES, async () => {
    const items = await db.query('select id, base_salary from public.payroll_items')
    const sheets = await db.query('select id from public.payroll_sheets')
    return { items: items.rows, sheets: sheets.rows }
  })
  assert.equal(afterPublish.items.length, 1, '员工只看到本人工资条')
  assert.equal(afterPublish.items[0].id, seed.itemId, '看到的正是本人行')
  assert.equal(afterPublish.sheets.length, 1, '员工能看到所属工资表')

  // ---------- 6. 员工无写权限（确认/驳回入口已移除） ----------
  await as(SALES, async () => {
    const updated = await db.query(
      `update public.payroll_items set confirmation='confirmed' where id='${seed.itemId}' returning id`,
    )
    assert.equal(updated.rows.length, 0, '员工不能写工资明细')
  })

  // ---------- 7. 已推送行财务不能直接改数 ----------
  await as(FINANCE, async () => {
    await assert.rejects(
      () =>
        db.query(
          `update public.payroll_items set base_salary=9000 where id='${seed.itemId}'`,
        ),
      /withdraw this payslip before editing/i,
      '已推送行改数被守卫拒绝',
    )
  })

  // ---------- 8. 单行撤回：员工立刻看不到，改数放行，重新推送后看到新数 ----------
  await as(FINANCE, () =>
    db.query(`update public.payroll_items set pushed_at=null where id='${seed.itemId}'`),
  )
  const afterUnpush = await as(SALES, async () => {
    const items = await db.query('select id from public.payroll_items')
    const sheets = await db.query('select id from public.payroll_sheets')
    return { items: items.rows.length, sheets: sheets.rows.length }
  })
  assert.equal(afterUnpush.items, 0, '撤回后员工立即看不到工资条')
  assert.equal(afterUnpush.sheets, 0, '撤回后员工也看不到工资表')

  await as(FINANCE, async () => {
    await db.query(
      `update public.payroll_items set base_salary=9000 where id='${seed.itemId}'`,
    )
    const check = await db.query(
      `select pushed_at from public.payroll_items where id='${seed.itemId}'`,
    )
    assert.equal(check.rows[0].pushed_at, null, '改数不会自动推送')
  })

  await as(FINANCE, async () => {
    await assert.rejects(
      () => db.query(`update public.payroll_items set pushed_at=now() where id='${seed.manualId}'`),
      /without an account cannot receive payslips/i,
      '无账号行不能推送',
    )
  })

  await as(FINANCE, () =>
    db.query(`update public.payroll_items set pushed_at=now() where id='${seed.itemId}'`),
  )
  const afterRepush = await as(SALES, async () => {
    const items = await db.query('select id, base_salary from public.payroll_items')
    return items.rows
  })
  assert.equal(afterRepush.length, 1, '重新推送后员工可见')
  assert.equal(Number(afterRepush[0].base_salary), 9000, '员工看到修改后的金额')

  // ---------- 9. 整表撤回：全部 pushed_at 清空 ----------
  await as(FINANCE, () =>
    db.query(`select public.unpublish_payroll_sheet('${seed.sheetId}')`),
  )
  const afterUnpublish = await db.query(
    `select count(*)::int as c from public.payroll_items where sheet_id='${seed.sheetId}' and pushed_at is not null`,
  )
  assert.equal(afterUnpublish.rows[0].c, 0, '整表撤回后无已推送行')

  // ---------- 10. 存量回填：已发布表按发布时间补 pushed_at ----------
  await db.exec(`set session_replication_role = replica;`)
  const legacy = await db.query(`insert into public.payroll_sheets(period_month, status, published_by, published_at, created_by)
    values ('2026-09-01', 'published', '${FINANCE}', '2026-09-30 10:00+08', '${FINANCE}') returning id`)
  await db.query(`insert into public.payroll_items(sheet_id, profile_id, employee_name, sort_order, base_salary)
    values ('${legacy.rows[0].id}', '${SALES}', '朱可欣', 1, 8000)`)
  await db.exec(`set session_replication_role = origin;`)

  await db.exec(migration('0148_payroll_item_push.sql'))
  const backfilled = await db.query(
    `select pushed_at from public.payroll_items where sheet_id='${legacy.rows[0].id}'`,
  )
  assert.ok(backfilled.rows[0].pushed_at, '存量已发布行回填 pushed_at')

  console.log('✓ 0148 单行撤回/推送演练通过')
  await db.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
