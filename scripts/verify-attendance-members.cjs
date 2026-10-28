const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')

const FINANCE = '10000000-0000-4000-8000-000000000001'
const SALES = '10000000-0000-4000-8000-000000000002'
const OTHER = '10000000-0000-4000-8000-000000000003'

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
      ('${OTHER}', 'sales', 'approved', '陈宇恒', null, 'other@test.com', '2026-03-01');
    create function public.is_finance_or_admin() returns boolean language sql security definer as $$
      select exists(select 1 from profiles where id = auth.uid() and role in ('admin', 'finance') and status = 'approved') $$;
    create function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
    grant usage on schema public to authenticated, anon;
  `)
  const migration = (name) => fs.readFileSync(path.join(__dirname, '../supabase/migrations', name), 'utf8')
  await db.exec(migration('0122_payroll_attendance.sql'))

  const as = async (uid, fn) => {
    await db.exec(`set role authenticated; set request.jwt.claim.sub = '${uid}';`)
    try {
      return await fn()
    } finally {
      await db.exec('reset role; reset request.jwt.claim.sub;')
    }
  }

  // 0128 前先有存量数据：一张表 + 两条考勤格
  const sheet = await as(FINANCE, () =>
    db.query(`insert into public.attendance_sheets(month, created_by)
      values ('2026-09-01', auth.uid()) returning id`))
  const sheetId = sheet.rows[0].id
  await as(FINANCE, () =>
    db.query(`insert into public.attendance_entries(sheet_id, profile_id, day, morning, afternoon)
      values ('${sheetId}', '${SALES}', 1, '√', '√'), ('${sheetId}', '${OTHER}', 2, '○', '')`))

  await db.exec(migration('0128_attendance_members.sql'))
  // 幂等：再跑一遍不报错、不产生重复成员
  await db.exec(migration('0128_attendance_members.sql'))

  // ---------- 回填：既有 entries 挂到成员行，姓名取 chinese_name ----------
  let members = (await db.query(`select * from public.attendance_members where sheet_id='${sheetId}' order by sort_order`)).rows
  assert.equal(members.length, 2, '回填成员数')
  assert.deepEqual(members.map((m) => m.name), ['可欣', '陈宇恒'])
  const entries = (await db.query(`select * from public.attendance_entries where sheet_id='${sheetId}' order by day`)).rows
  assert.ok(entries.every((e) => e.member_id), '回填 member_id')
  assert.equal(entries[0].profile_id, SALES, '回填保留 profile_id')
  assert.equal(entries[0].morning, '√')

  // ---------- 财务加手动成员 + 写格；profile_id 由触发器同步 ----------
  await as(FINANCE, async () => {
    const manual = await db.query(`insert into public.attendance_members(sheet_id, name, sort_order)
      values ('${sheetId}', '临时工小王', 3) returning id`)
    const manualId = manual.rows[0].id
    await db.query(`insert into public.attendance_entries(sheet_id, member_id, day, morning, afternoon)
      values ('${sheetId}', '${manualId}', 3, '▲', '')`)
    const row = (await db.query(`select profile_id from public.attendance_entries
      where member_id='${manualId}' and day=3`)).rows[0]
    assert.equal(row.profile_id, null, '手动成员 profile_id 为 null')

    // 账号成员：upsert member_id 后 profile_id 自动冗余
    const linked = members.find((m) => m.profile_id === SALES)
    await db.query(`insert into public.attendance_entries(sheet_id, member_id, day, morning, afternoon)
      values ('${sheetId}', '${linked.id}', 4, '※', '')
      on conflict (sheet_id, member_id, day) do update set morning=excluded.morning`)
    const linkedRow = (await db.query(`select profile_id from public.attendance_entries
      where member_id='${linked.id}' and day=4`)).rows[0]
    assert.equal(linkedRow.profile_id, SALES, '触发器同步 profile_id')

    // 手动成员可重名（null 不冲突）
    await db.query(`insert into public.attendance_members(sheet_id, name, sort_order)
      values ('${sheetId}', '临时工小王', 4)`)
    // 同一表内账号成员唯一
    await assert.rejects(
      () => db.query(`insert into public.attendance_members(sheet_id, profile_id, name, sort_order)
        values ('${sheetId}', '${SALES}', '重复', 9)`),
      /duplicate key/,
    )
    // 成员级联删除：entries 一并清掉
    const { rows: before } = await db.query(`select count(*)::int n from public.attendance_entries where sheet_id='${sheetId}'`)
    await db.query(`delete from public.attendance_members where id='${manualId}'`)
    const { rows: after } = await db.query(`select count(*)::int n from public.attendance_entries where sheet_id='${sheetId}'`)
    assert.equal(after[0].n, before[0].n - 1, '级联删除成员考勤格')
  })

  // ---------- 权限：员工只读本人 entries；花名册全员可见；员工写被拒 ----------
  await as(SALES, async () => {
    const own = await db.query(`select count(*)::int n from public.attendance_entries`)
    assert.ok(own.rows[0].n >= 2, '员工可见本人考勤')
    const roster = await db.query(`select count(*)::int n from public.attendance_members`)
    assert.ok(roster.rows[0].n >= 2, '花名册全员可见')
    await assert.rejects(
      () => db.query(`insert into public.attendance_members(sheet_id, name) values ('${sheetId}', 'hack')`),
      /Only finance or admin/,
    )
    await assert.rejects(
      () => db.query(`insert into public.attendance_entries(sheet_id, member_id, day) values ('${sheetId}', '${members[0].id}', 9)`),
      /Only finance or admin/,
    )
  })

  console.log('✓ 0128 考勤花名册演练通过')
}

main().catch((error) => {
  console.error('✗ 0128 演练失败：', error.message)
  process.exit(1)
})
