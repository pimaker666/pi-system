const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')

const ADMIN = '10000000-0000-4000-8000-000000000001'
const FINANCE = '10000000-0000-4000-8000-000000000002'
const SALES = '10000000-0000-4000-8000-000000000003'
const PRODUCT = '40000000-0000-4000-8000-000000000001'

async function asUser(db, userId) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${userId}', false);`)
}

async function reset(db) {
  await db.exec(`select set_config('request.jwt.claim.sub', '', false); reset role;`)
}

async function expectError(fn, pattern) {
  let failed = false
  try {
    await fn()
  } catch (err) {
    failed = true
    assert.match(String(err.message ?? err), pattern)
  }
  assert.ok(failed, `expected failure matching ${pattern}`)
}

async function main() {
  const db = new PGlite()
  await db.exec(`
    create role anon;
    create role authenticated;
    grant usage on schema public to authenticated, anon;

    create schema if not exists auth;
    create function auth.uid() returns uuid
      language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    create type public.user_role as enum ('admin', 'finance', 'sales', 'supervisor');

    create table public.profiles (
      id uuid primary key,
      role public.user_role not null
    );

    create table public.product_financials (
      product_id uuid primary key,
      financial_number text unique,
      product_name text,
      cost numeric,
      updated_by uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    alter table public.product_financials enable row level security;
    create policy product_financials_finance on public.product_financials
      for all
      using (exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.role in ('admin', 'finance')
      ));

    insert into public.profiles (id, role) values
      ('${ADMIN}', 'admin'),
      ('${FINANCE}', 'finance'),
      ('${SALES}', 'sales');
    insert into public.product_financials (product_id, financial_number, product_name, cost)
      values ('${PRODUCT}', 'CREAM-009', 'PORE + DARK SPOT BRIGHTENING CREAM', 12.3456);

    grant select on public.profiles to authenticated;
    grant select, insert, update, delete on public.product_financials to authenticated;
  `)

  const migration = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/0164_product_financial_labels_view.sql'),
    'utf8',
  )

  // 重复执行两次，验证可重放。
  await db.exec(migration)
  await db.exec(migration)

  const columns = await db.query(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'product_financial_labels'
      order by ordinal_position`,
  )
  assert.deepEqual(
    columns.rows.map((row) => row.column_name),
    ['product_id', 'financial_number', 'product_name'],
  )

  // 销售：底层表被 RLS 挡住，视图能读到名称与编号。
  await asUser(db, SALES)
  const salesTable = await db.query('select count(*)::int as n from public.product_financials')
  assert.equal(salesTable.rows[0].n, 0)
  const salesView = await db.query(
    'select financial_number, product_name from public.product_financial_labels',
  )
  assert.equal(salesView.rows.length, 1)
  assert.equal(salesView.rows[0].financial_number, 'CREAM-009')
  assert.equal(salesView.rows[0].product_name, 'PORE + DARK SPOT BRIGHTENING CREAM')

  // 销售：只能看，不能通过视图改回原表。
  await expectError(
    () => db.exec(`update public.product_financial_labels set product_name = 'HACKED'`),
    /permission denied/i,
  )
  await expectError(
    () =>
      db.exec(
        `insert into public.product_financial_labels (product_id, financial_number, product_name) values ('50000000-0000-4000-8000-000000000000', 'X', 'X')`,
      ),
    /permission denied/i,
  )
  await expectError(
    () => db.exec(`delete from public.product_financial_labels`),
    /permission denied/i,
  )
  const stillThere = await db.query(
    'select product_name from public.product_financial_labels where product_id = $1',
    [PRODUCT],
  )
  assert.equal(stillThere.rows[0].product_name, 'PORE + DARK SPOT BRIGHTENING CREAM')
  await reset(db)

  // 财务：底层表照旧可见（成本等字段仍走原 RLS）。
  await asUser(db, FINANCE)
  const financeTable = await db.query('select cost from public.product_financials')
  assert.equal(financeTable.rows.length, 1)
  assert.equal(Number(financeTable.rows[0].cost), 12.3456)
  await reset(db)

  // 匿名：连视图都读不到。
  await db.exec('set role anon')
  await expectError(() => db.exec('select * from public.product_financial_labels'), /permission denied/i)
  await db.exec('reset role')

  await db.close()
  console.log('0164 product_financial_labels view: OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
