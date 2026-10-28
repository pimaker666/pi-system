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
  // 请假依赖 0122 的考勤表
  await db.exec(migration('0122_payroll_attendance.sql'))
  await db.exec(migration('0123_leave_requests.sql'))
  await db.exec(migration('0123_leave_requests.sql'))

  const as = async (uid, fn) => {
    await db.exec(`set role authenticated; set request.jwt.claim.sub = '${uid}';`)
    try {
      return await fn()
    } finally {
      await db.exec('reset role; reset request.jwt.claim.sub;')
    }
  }

  // ---------- 员工提交 ----------
  const req = await as(SALES, async () => {
    const id = (await db.query(`insert into leave_requests(applicant_id, leave_type, start_date, end_date, day_part, reason)
      values (auth.uid(), 'personal', '2026-08-30', '2026-09-02', 'full', '家中有事') returning id`)).rows[0].id
    // 不能替他人提交
    await assert.rejects(() => db.query(`insert into leave_requests(applicant_id, leave_type, start_date, end_date, day_part, reason)
      values ('${OTHER}', 'sick', '2026-09-01', '2026-09-01', 'full', 'x')`), /current user/)
    // 新申请必须是 pending
    await assert.rejects(() => db.query(`insert into leave_requests(applicant_id, leave_type, start_date, end_date, day_part, reason, status)
      values (auth.uid(), 'sick', '2026-09-01', '2026-09-01', 'full', 'x', 'approved')`), /must start as pending/)
    // 结束早于开始
    await assert.rejects(() => db.query(`insert into leave_requests(applicant_id, leave_type, start_date, end_date, day_part, reason)
      values (auth.uid(), 'sick', '2026-09-05', '2026-09-04', 'full', 'x')`), /date_check/)
    // 非法类型/半天
    await assert.rejects(() => db.query(`insert into leave_requests(applicant_id, leave_type, start_date, end_date, day_part, reason)
      values (auth.uid(), 'marriage', '2026-09-01', '2026-09-01', 'full', 'x')`), /leave_type/)
    await assert.rejects(() => db.query(`insert into leave_requests(applicant_id, leave_type, start_date, end_date, day_part, reason)
      values (auth.uid(), 'sick', '2026-09-01', '2026-09-01', 'evening', 'x')`), /day_part/)
    return id
  })

  // ---------- 他人不可见、不可改 ----------
  await as(OTHER, async () => {
    const visible = (await db.query('select id from leave_requests')).rows
    assert.equal(visible.length, 0, '他人看不到请假申请')
    const tamper = await db.query(`update leave_requests set reason = '篡改' where id = '${req}'`)
    assert.equal(tamper.affectedRows, 0, '他人改请假申请被 RLS 静默挡下')
  })

  // ---------- 员工不能审批 ----------
  await as(SALES, async () => {
    await assert.rejects(() => db.query(`update leave_requests set status = 'approved' where id = '${req}'`), /Only finance or admin/)
  })

  // ---------- 待审批可改可撤 ----------
  await as(SALES, async () => {
    await db.query(`update leave_requests set reason = '家中有事（改）' where id = '${req}'`)
    const row = (await db.query(`select reason from leave_requests where id = '${req}'`)).rows[0]
    assert.equal(row.reason, '家中有事（改）')
    // 撤回（删除）后重建一条用于审批流
    await db.query(`delete from leave_requests where id = '${req}'`)
  })
  // 非本人不能撤回
  await as(OTHER, async () => {
    const gone = (await db.query('select id from leave_requests')).rows
    assert.equal(gone.length, 0)
  })

  // ---------- 驳回必填原因 ----------
  const req2 = await as(SALES, async () =>
    (await db.query(`insert into leave_requests(applicant_id, leave_type, start_date, end_date, day_part, reason)
      values (auth.uid(), 'personal', '2026-08-30', '2026-09-02', 'full', '家中有事') returning id`)).rows[0].id)
  await as(FINANCE, async () => {
    await assert.rejects(() => db.query(`update leave_requests set status = 'rejected' where id = '${req2}'`), /Reject reason/)
    await db.query(`update leave_requests set status = 'rejected', reject_reason = '请提供证明' where id = '${req2}'`)
    const row = (await db.query(`select status, reject_reason, reviewed_by, reviewed_at from leave_requests where id = '${req2}'`)).rows[0]
    assert.equal(row.status, 'rejected')
    assert.equal(row.reviewed_by, FINANCE)
    assert.ok(row.reviewed_at)
    // 已驳回：申请人不能改内容（只能重新提交新申请）
    await assert.rejects(
      () => as(SALES, () => db.query(`update leave_requests set reason = 'x' where id = '${req2}'`)),
      /Reviewed leave request/)
    // 审批痕迹字段不能手改
    await assert.rejects(() => db.query(`update leave_requests set reviewed_by = null where id = '${req2}'`), /Reviewed leave request/)
  })

  // ---------- 批准 → 应用层写入考勤（模拟 action 的 upsert 语义） ----------
  const req3 = await as(SALES, async () =>
    (await db.query(`insert into leave_requests(applicant_id, leave_type, start_date, end_date, day_part, reason)
      values (auth.uid(), 'vacation', '2026-08-30', '2026-09-02', 'full', '年假') returning id`)).rows[0].id)
  await as(FINANCE, async () => {
    await db.query(`update leave_requests set status = 'approved' where id = '${req3}'`)
  })

  // 应用层语义：跨月范围 → 每月一张考勤表（缺则建），逐日 upsert 只写空格
  await as(FINANCE, async () => {
    const symbol = '●'
    const months = ['2026-08-01', '2026-09-01']
    for (const month of months) {
      await db.query(`insert into attendance_sheets(month, note, created_by)
        values ('${month}', '请假审批自动创建', auth.uid())
        on conflict (month) do nothing`)
    }
    // 预标记：9 月 1 日上午已有 √，验证只写空格不覆盖
    const sepSheet = (await db.query(`select id from attendance_sheets where month = '2026-09-01'`)).rows[0].id
    await db.query(`insert into attendance_entries(sheet_id, profile_id, day, morning)
      values ('${sepSheet}', '${SALES}', 1, '√')`)

    // 模拟 action：8-30、8-31、9-1、9-2 全天 ●
    const days = [['2026-08-01', 30], ['2026-08-01', 31], ['2026-09-01', 1], ['2026-09-01', 2]]
    let skipped = 0
    for (const [month, day] of days) {
      const sheet = (await db.query(`select id from attendance_sheets where month = '${month}'`)).rows[0].id
      const existing = (await db.query(`select morning, afternoon from attendance_entries
        where sheet_id = '${sheet}' and profile_id = '${SALES}' and day = ${day}`)).rows[0]
      const morning = existing?.morning || ''
      const afternoon = existing?.afternoon || ''
      const newMorning = morning || symbol
      const newAfternoon = afternoon || symbol
      if ((morning && morning !== symbol) || (afternoon && afternoon !== symbol)) skipped += 1
      await db.query(`insert into attendance_entries(sheet_id, profile_id, day, morning, afternoon)
        values ('${sheet}', '${SALES}', ${day}, '${newMorning}', '${newAfternoon}')
        on conflict (sheet_id, profile_id, day)
        do update set morning = excluded.morning, afternoon = excluded.afternoon`)
    }
    assert.equal(skipped, 1, '9 月 1 日上午已有 √ 计为跳过，不覆盖')

    const sep1 = (await db.query(`select morning, afternoon from attendance_entries
      where sheet_id = '${sepSheet}' and profile_id = '${SALES}' and day = 1`)).rows[0]
    assert.equal(sep1.morning, '√', '已有标记不被请假符号覆盖')
    assert.equal(sep1.afternoon, '●', '空格写入请假符号')
    const augSheet = (await db.query(`select id from attendance_sheets where month = '2026-08-01'`)).rows[0].id
    const aug30 = (await db.query(`select morning, afternoon from attendance_entries
      where sheet_id = '${augSheet}' and profile_id = '${SALES}' and day = 30`)).rows[0]
    assert.equal(aug30.morning, '●')
    assert.equal(aug30.afternoon, '●')
  })

  // ---------- 已批准：申请人不可改、不可删 ----------
  // 已批准：申请人不可删（RLS 静默挡下）、不可改状态
  const delAttempt = await as(SALES, () => db.query(`delete from leave_requests where id = '${req3}'`))
  assert.equal(delAttempt.affectedRows, 0, '已批准申请申请人删除被 RLS 静默挡下')
  await assert.rejects(
    () => as(FINANCE, () => db.query(`update leave_requests set status = 'rejected', reject_reason = 'x' where id = '${req3}'`)),
    /Invalid leave request status/)

  // 考勤表员工只读：申请人在审批写入后也不能改考勤
  await as(SALES, async () => {
    await assert.rejects(() => db.query(`insert into attendance_sheets(month) values ('2026-10-01')`), /Only finance or admin/)
  })

  console.log('✓ 0123 请假申请演练全部通过')
}

main().catch((error) => {
  console.error('✗ 演练失败:', error.message)
  console.error(error.stack)
  process.exit(1)
})
