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
      ('${SALES}', 'sales', 'approved', '朱可欣', null, 'sales@test.com', '2026-02-01'),
      ('${OTHER}', 'sales', 'approved', '陈宇恒', null, 'other@test.com', '2026-03-01');
    create function public.is_finance_or_admin() returns boolean language sql security definer as $$
      select exists(select 1 from profiles where id = auth.uid() and role in ('admin', 'finance') and status = 'approved') $$;
    create function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
    grant usage on schema public to authenticated, anon;
  `)
  const migration = (name) => fs.readFileSync(path.join(__dirname, '../supabase/migrations', name), 'utf8')
  await db.exec(migration('0122_payroll_attendance.sql'))
  // 幂等：再跑一遍不报错
  await db.exec(migration('0122_payroll_attendance.sql'))

  const as = async (uid, fn) => {
    await db.exec(`set role authenticated; set request.jwt.claim.sub = '${uid}';`)
    try {
      return await fn()
    } finally {
      await db.exec('reset role; reset request.jwt.claim.sub;')
    }
  }

  // ---------- 工资表：财务建单/推送 ----------
  const sheet = await as(FINANCE, async () =>
    (await db.query(`insert into payroll_sheets(period_month, payout_month, created_by)
      values ('2026-09-01','2026-10-01', auth.uid()) returning id`)).rows[0].id)
  await as(FINANCE, async () => {
    await db.query(`insert into payroll_items(sheet_id, profile_id, sort_order, base_salary)
      values ('${sheet}','${SALES}',1,5000), ('${sheet}','${OTHER}',2,4500)`)
    // 非每月1日的月份被拒
    await assert.rejects(() => db.query(`insert into payroll_sheets(period_month) values ('2026-09-15')`), /month_check/)
    // 重复月份唯一约束
    await assert.rejects(() => db.query(`insert into payroll_sheets(period_month) values ('2026-09-01')`), /duplicate key/)
    // 同员工重复入表被拒
    await assert.rejects(() => db.query(`insert into payroll_items(sheet_id, profile_id) values ('${sheet}','${SALES}')`), /duplicate key/)
  })
  // 员工不能建单
  await as(SALES, async () => {
    await assert.rejects(() => db.query(`insert into payroll_sheets(period_month) values ('2026-10-01')`), /Only finance or admin/)
  })

  // ---------- 草稿期：员工不可见、不能确认 ----------
  await as(SALES, async () => {
    const visible = (await db.query('select id from payroll_sheets')).rows
    assert.equal(visible.length, 0, 'draft 工资表员工不可见')
    const own = (await db.query(`select id from payroll_items where profile_id = '${SALES}'`)).rows
    assert.equal(own.length, 1, '员工可见本人明细行（RLS 放行）')
    await assert.rejects(
      () => db.query(`update payroll_items set confirmation = 'confirmed' where id = '${own[0].id}'`),
      /has not been published/)
  })

  // ---------- 推送 ----------
  await as(FINANCE, async () => {
    await db.query(`update payroll_sheets set status = 'published' where id = '${sheet}'`)
    const row = (await db.query(`select status, published_by, published_at from payroll_sheets where id = '${sheet}'`)).rows[0]
    assert.equal(row.status, 'published')
    assert.equal(row.published_by, FINANCE)
    assert.ok(row.published_at)
    // 已推送不可改所属月份、不可删表
    await assert.rejects(() => db.query(`update payroll_sheets set period_month = '2026-08-01' where id = '${sheet}'`), /cannot change its period/)
    await assert.rejects(() => db.query(`delete from payroll_sheets where id = '${sheet}'`), /cannot be deleted/)
    // 推送后可改发放月份
    await db.query(`update payroll_sheets set payout_month = '2026-11-01' where id = '${sheet}'`)
    // 财务不能代员工确认
    await assert.rejects(() => db.query(`update payroll_items set confirmation = 'confirmed' where profile_id = '${SALES}'`), /on behalf/)
  })

  // 员工可见已推送单
  await as(SALES, async () => {
    const visible = (await db.query('select id, status from payroll_sheets')).rows
    assert.equal(visible.length, 1, '员工可见本人所在已推送工资表')
  })

  // ---------- 员工确认/驳回 ----------
  const salesItem = await as(SALES, async () => {
    const row = (await db.query(`select id from payroll_items where profile_id = '${SALES}'`)).rows[0]
    // 驳回必填原因
    await assert.rejects(() => db.query(`update payroll_items set confirmation = 'rejected', rejected_at = now() where id = '${row.id}'`), /Reject reason/)
    // 驳回别人：RLS 静默挡下（0 行生效）
    const otherUpdate = await db.query(`update payroll_items set confirmation = 'rejected', rejected_reason = 'x' where profile_id = '${OTHER}'`)
    assert.equal(otherUpdate.affectedRows, 0, '员工不能改他人工资条')
    // 正常驳回
    await db.query(`update payroll_items set confirmation = 'rejected', rejected_reason = '提成金额不对' where id = '${row.id}'`)
    const updated = (await db.query(`select confirmation, rejected_at, rejected_reason from payroll_items where id = '${row.id}'`)).rows[0]
    assert.equal(updated.confirmation, 'rejected')
    assert.ok(updated.rejected_at)
    // 已驳回不能再确认
    await assert.rejects(() => db.query(`update payroll_items set confirmation = 'confirmed' where id = '${row.id}'`), /Invalid payroll confirmation/)
    // 财务修正金额 → 自动回到待确认
    return row.id
  })
  await as(FINANCE, async () => {
    await db.query(`update payroll_items set commission = 1200 where id = '${salesItem}'`)
    const updated = (await db.query(`select confirmation, rejected_reason from payroll_items where id = '${salesItem}'`)).rows[0]
    assert.equal(updated.confirmation, 'pending', '财务改金额后自动回到待确认')
    assert.equal(updated.rejected_reason, null)
  })
  await as(SALES, async () => {
    await db.query(`update payroll_items set confirmation = 'confirmed' where id = '${salesItem}'`)
    const updated = (await db.query(`select confirmation, confirmed_at from payroll_items where id = '${salesItem}'`)).rows[0]
    assert.equal(updated.confirmation, 'confirmed')
    assert.ok(updated.confirmed_at)
  })

  // 员工不能改金额
  await assert.rejects(
    () => as(SALES, () => db.query(`update payroll_items set base_salary = 9999 where id = '${salesItem}'`)),
    /Employees can only confirm/)

  // 已推送明细不可删
  await assert.rejects(
    () => as(FINANCE, () => db.query(`delete from payroll_items where id = '${salesItem}'`)),
    /locked after publish/)

  // ---------- 考勤表 ----------
  const attSheet = await as(FINANCE, async () =>
    (await db.query(`insert into attendance_sheets(month, note, created_by)
      values ('2026-09-01','9月考勤', auth.uid()) returning id`)).rows[0].id)
  await as(FINANCE, async () => {
    await db.query(`insert into attendance_entries(sheet_id, profile_id, day, morning, afternoon)
      values ('${attSheet}','${SALES}',1,'√','√'), ('${attSheet}','${SALES}',2,'√','※')`)
    // 非法符号被拒
    await assert.rejects(() => db.query(`insert into attendance_entries(sheet_id, profile_id, day, morning) values ('${attSheet}','${SALES}',3,'X')`), /attendance_entries_morning_check/)
    // 非每月1日被拒
    await assert.rejects(() => db.query(`insert into attendance_sheets(month) values ('2026-09-10')`), /month_check/)
    // 合并语义：同一人同一天 upsert
    await db.query(`insert into attendance_entries(sheet_id, profile_id, day, morning, afternoon)
      values ('${attSheet}','${SALES}',2,'●','●') on conflict (sheet_id, profile_id, day)
      do update set morning = excluded.morning, afternoon = excluded.afternoon`)
    const cell = (await db.query(`select morning, afternoon from attendance_entries
      where sheet_id = '${attSheet}' and profile_id = '${SALES}' and day = 2`)).rows[0]
    assert.equal(cell.morning, '●')
  })
  await as(SALES, async () => {
    // 员工可见本人考勤
    const own = (await db.query(`select count(*)::int as n from attendance_entries where sheet_id = '${attSheet}'`)).rows[0]
    assert.equal(own.n, 2, '员工只见本人考勤格')
    // 员工不能改考勤
    await assert.rejects(() => db.query(`insert into attendance_entries(sheet_id, profile_id, day, morning) values ('${attSheet}','${SALES}',5,'√')`), /Only finance or admin/)
  })
  await as(FINANCE, async () => {
    // 清空两个单元格 → 删除行语义（走应用层 upsert 空值删除），这里直接验证守卫放行删除
    await db.query(`delete from attendance_entries where sheet_id = '${attSheet}' and profile_id = '${SALES}' and day = 2`)
    const left = (await db.query(`select count(*)::int as n from attendance_entries where sheet_id = '${attSheet}'`)).rows[0]
    assert.equal(left.n, 1)
  })

  console.log('✓ 0122 工资表+考勤表演练全部通过')
}

main().catch((error) => {
  console.error('✗ 演练失败:', error.message)
  console.error(error.stack)
  process.exit(1)
})
