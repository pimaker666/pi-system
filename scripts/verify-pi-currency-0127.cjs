// 0127 迁移演练：company_settings / company_profiles 增加 pi_currency。
// 用 PGlite 建最小表结构，应用 0127 两次（验证幂等），并验证默认值与 check 约束。
const fs = require('fs')
const path = require('path')

const { PGlite } = require('@electric-sql/pglite')

async function main() {
  const db = new PGlite()
  try {
    await db.exec(`
      create table public.company_settings (
        id bigint primary key,
        company_name text not null default '',
        updated_at timestamptz not null default now()
      );
      create table public.company_profiles (
        id uuid primary key,
        created_by uuid not null,
        label text not null,
        is_active boolean not null default false,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      insert into public.company_settings (id) values (1);
      insert into public.company_profiles (id, created_by, label)
        values ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '旧档案');
    `)

    const sql = fs.readFileSync(
      path.join(__dirname, '../supabase/migrations/0127_company_pi_currency.sql'),
      'utf8',
    )
    await db.exec(sql)
    await db.exec(sql) // 幂等重放

    const cols = await db.query(
      `select table_name, column_name, column_default, is_nullable
       from information_schema.columns
       where column_name = 'pi_currency' order by table_name`,
    )
    const okCols =
      cols.rows.length === 2 &&
      cols.rows.every(
        (r) => r.column_default === "'USD'::text" && r.is_nullable === 'NO',
      )

    const checks = await db.query(
      `select conname from pg_constraint
       where conname in ('company_settings_pi_currency_check', 'company_profiles_pi_currency_check')
       order by conname`,
    )
    const okChecks = checks.rows.length === 2

    const backfill = await db.query(
      `select (select pi_currency from public.company_settings where id = 1) as settings_cur,
              (select pi_currency from public.company_profiles limit 1) as profile_cur`,
    )
    const okBackfill =
      backfill.rows[0].settings_cur === 'USD' && backfill.rows[0].profile_cur === 'USD'

    // check 约束应拒绝其它币种
    let rejected = false
    try {
      await db.query(`update public.company_settings set pi_currency = 'EUR' where id = 1`)
    } catch {
      rejected = true
    }

    // CNY 合法
    await db.query(`update public.company_settings set pi_currency = 'CNY' where id = 1`)
    const cny = await db.query(
      `select pi_currency from public.company_settings where id = 1`,
    )

    const pass = okCols && okChecks && okBackfill && rejected && cny.rows[0].pi_currency === 'CNY'
    console.log(
      JSON.stringify(
        {
          pass,
          okCols: cols.rows,
          okChecks: checks.rows.map((r) => r.conname),
          okBackfill: backfill.rows[0],
          rejected,
          cnyAccepted: cny.rows[0].pi_currency,
        },
        null,
        2,
      ),
    )
    if (!pass) process.exit(1)
    console.log('0127 PASS')
  } finally {
    await db.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
