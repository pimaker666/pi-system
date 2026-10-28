const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')

const FINANCE = '10000000-0000-4000-8000-000000000001'
const SALES = '10000000-0000-4000-8000-000000000002'

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
      ('${SALES}', 'sales', 'approved', '朱可欣', '可欣', 'sales@test.com', '2026-02-01');
    create function public.is_finance_or_admin() returns boolean language sql security definer as $$
      select exists(select 1 from profiles where id = auth.uid() and role in ('admin', 'finance') and status = 'approved') $$;
    create function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
    grant usage on schema public to authenticated, anon;
    grant select, delete on public.profiles to authenticated;
  `)
  const migration = (name) => fs.readFileSync(path.join(__dirname, '../supabase/migrations', name), 'utf8')
  await db.exec(migration('0122_payroll_attendance.sql'))
  await db.exec(migration('0129_payroll_autofill.sql'))
  // 幂等：再跑一遍不报错
  await db.exec(migration('0129_payroll_autofill.sql'))

  const as = async (uid, fn) => {
    await db.exec(`set role authenticated; set request.jwt.claim.sub = '${uid}';`)
    try {
      return await fn()
    } finally {
      await db.exec('reset role; reset request.jwt.claim.sub;')
    }
  }

  // ---------- 满勤天数：默认值带法、check 约束 ----------
  await as(FINANCE, async () => {
    const sheet = await db.query(`insert into public.payroll_sheets(period_month, full_attendance_days, created_by)
      values ('2026-10-01', 19, auth.uid()) returning id, full_attendance_days`)
    assert.equal(sheet.rows[0].full_attendance_days, 19, '满勤天数写入')
    await assert.rejects(
      () => db.query(`insert into public.payroll_sheets(period_month, full_attendance_days) values ('2026-11-01', 0)`),
      /check/i,
    )
    await assert.rejects(
      () => db.query(`insert into public.payroll_sheets(period_month, full_attendance_days) values ('2026-12-01', 32)`),
      /check/i,
    )
  })

  // ---------- 薪资档案：财务维护，员工不可见不可写 ----------
  await as(FINANCE, async () => {
    await db.query(`insert into public.payroll_salary_profiles(profile_id, base_salary, social_insurance, housing_fund, updated_by)
      values ('${SALES}', 8000, 500.5, 400, auth.uid())`)
    await db.query(`insert into public.payroll_salary_profiles(profile_id, base_salary, social_insurance, housing_fund, updated_by)
      values ('${SALES}', 8500, 520, 420, auth.uid())
      on conflict (profile_id) do update set
        base_salary=excluded.base_salary,
        social_insurance=excluded.social_insurance,
        housing_fund=excluded.housing_fund,
        updated_by=excluded.updated_by`)
    const row = (await db.query(`select base_salary, social_insurance, housing_fund from public.payroll_salary_profiles where profile_id='${SALES}'`)).rows[0]
    assert.equal(Number(row.base_salary), 8500, '档案 upsert 后底薪')
    assert.equal(Number(row.social_insurance), 520, '档案 upsert 后社保')
    await assert.rejects(
      () => db.query(`insert into public.payroll_salary_profiles(profile_id, base_salary) values ('${FINANCE}', -1)`),
      /check|守卫|Only finance/i,
    )
  })
  await as(SALES, async () => {
    const visible = await db.query(`select count(*)::int n from public.payroll_salary_profiles`)
    assert.equal(visible.rows[0].n, 0, '员工 RLS 看不见薪资档案')
    await assert.rejects(
      () => db.query(`insert into public.payroll_salary_profiles(profile_id, base_salary) values ('${SALES}', 1)`),
      /Only finance or admin/,
    )
    // 员工 update 被 RLS 挡下：不报错但 0 行生效
    const blocked = await db.query(`update public.payroll_salary_profiles set base_salary=1 where profile_id='${SALES}'`)
    assert.equal(blocked.affectedRows ?? 0, 0, '员工改档案 0 行生效')
  })

  // ---------- 档案随账号删除级联清理（以财务身份删账号，级联触发器需要 JWT 通过守卫） ----------
  await as(FINANCE, () => db.query(`delete from public.profiles where id='${SALES}'`))
  const remaining = (await db.query(`select count(*)::int n from public.payroll_salary_profiles`)).rows[0]
  assert.equal(remaining.n, 0, '删除账号级联清档案')

  console.log('✓ 0129 工资表自动取数演练通过')
}

main().catch((error) => {
  console.error('✗ 0129 演练失败：', error.message)
  process.exit(1)
})
