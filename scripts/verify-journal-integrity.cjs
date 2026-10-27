const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')

async function main() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;
    create type public.currency_code as enum ('CNY', 'USD');
    create type public.finance_transaction_type as enum ('income', 'expense');
    create table public.profiles (id uuid primary key, role text, status text);
    create function public.is_finance_or_admin() returns boolean language sql security definer as $$
      select exists(select 1 from profiles where id = auth.uid() and role in ('admin', 'finance') and status = 'approved') $$;
    create function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
    grant usage on schema public to authenticated, anon;
    insert into profiles values ('10000000-0000-4000-8000-000000000001', 'finance', 'approved'),
      ('10000000-0000-4000-8000-000000000002', 'sales', 'approved');
  `)
  const migration = (name) => fs.readFileSync(path.join(__dirname, '../supabase/migrations', name), 'utf8')
  await db.exec(migration('0118_finance_journal.sql'))
  await db.exec(migration('0121_journal_integrity.sql'))
  await db.exec(migration('0121_journal_integrity.sql'))
  await db.exec(`set role authenticated; set request.jwt.claim.sub = '10000000-0000-4000-8000-000000000001';`)
  const account = (await db.query(`insert into finance_journal_accounts(name,currency,initial_balance,created_by)
    values ('测试CNY','CNY',1000,auth.uid()) returning id`)).rows[0].id
  const category = (await db.query(`select id from finance_journal_categories where name = '办公费'`)).rows[0].id
  const entry = (await db.query(`insert into finance_journal_entries(account_id,category_id,entry_date,kind,amount_original,currency,exchange_rate_to_cny,summary,created_by)
    values ($1,$2,'2026-09-01','expense',10.1234,'CNY',1,'办公费',auth.uid()) returning id`, [account, category])).rows[0].id
  await assert.rejects(() => db.query('delete from finance_journal_entries where id=$1', [entry]), /permission denied/)
  await assert.rejects(() => db.query(`insert into finance_journal_entries(account_id,category_id,entry_date,kind,amount_original,currency,exchange_rate_to_cny,summary,created_by)
    values ($1,$2,'2026-09-02','expense',10,'USD',7,'错误币种',auth.uid())`, [account, category]), /币种/)
  await assert.rejects(() => db.query(`update finance_journal_accounts set currency='USD' where id=$1`, [account]), /币种/)
  await assert.rejects(() => db.query(`update finance_journal_categories set kind='income' where id=$1`, [category]), /收支类型/)
  const balance = (await db.query('select balance from finance_journal_account_balances where account_id=$1', [account])).rows[0].balance
  assert.equal(Number(balance), 989.8766)
  await db.query(`update finance_journal_entries set voided_at=now(),voided_by=auth.uid(),void_reason='测试作废' where id=$1`, [entry])
  assert.equal(Number((await db.query('select balance from finance_journal_account_balances where account_id=$1', [account])).rows[0].balance), 1000)
  await assert.rejects(() => db.query(`update finance_journal_entries set summary='篡改' where id=$1`, [entry]), /作废/)
  await assert.rejects(() => db.query('delete from finance_journal_entries where id=$1', [entry]), /permission denied/)
  await db.exec(`set request.jwt.claim.sub = '10000000-0000-4000-8000-000000000002'`)
  assert.equal((await db.query('select * from finance_journal_entries')).rows.length, 0)
  await assert.rejects(() => db.query(`insert into finance_journal_accounts(name,created_by) values ('业务越权',auth.uid())`), /row-level security/)
  await db.exec('reset role')
  const grants = (await db.query(`select has_function_privilege('anon','public.finance_journal_account_guard()','EXECUTE') as account_guard,
    has_function_privilege('anon','public.finance_journal_category_guard()','EXECUTE') as category_guard,
    has_table_privilege('authenticated','public.finance_journal_entries','DELETE') as delete_entry`)).rows[0]
  assert.deepEqual(grants, { account_guard: false, category_guard: false, delete_entry: false })
  await verifyReimbursement(db, migration)
  await db.close()
  console.log('PASS: 0118~0121真实SQL/RLS、迁移重放、日记账防删除/混币/历史修改、报销原子回滚/审批权限/重提/凭证上传归属、anon拒绝')
}

async function verifyReimbursement(db, migration) {
  const owner = '10000000-0000-4000-8000-000000000002'
  const finance = '10000000-0000-4000-8000-000000000001'
  const admin = '10000000-0000-4000-8000-000000000003'
  const unapproved = '10000000-0000-4000-8000-000000000004'
  const receipt = `${owner}/20000000-0000-4000-8000-000000000001.png`
  await db.exec(`
    create function public.is_approved_user() returns boolean language sql security definer as $$
      select exists(select 1 from public.profiles where id=auth.uid() and status='approved') $$;
    grant select on public.profiles to authenticated;
    insert into public.profiles values ('${admin}', 'admin', 'approved'), ('${unapproved}', 'sales', 'pending');
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    create function storage.foldername(name text) returns text[] language sql immutable as $$
      select (string_to_array(name,'/'))[1:cardinality(string_to_array(name,'/'))-1] $$;
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated, anon;
    grant select, insert, delete on storage.objects to authenticated;
  `)
  await db.exec(migration('0119_finance_reimbursement.sql'))
  await db.exec(migration('0120_reimbursement_atomic_save.sql'))
  await db.exec(migration('0120_reimbursement_atomic_save.sql'))
  const context = async (id) => db.exec(`set role authenticated; set request.jwt.claim.sub='${id}';`)
  const save = async (id, items, date = '2026-10-01', project = '测试报销') =>
    (await db.query('select save_finance_reimbursement_request($1,$2,$3,$4::jsonb) as result',
      [id, date, project, JSON.stringify(items)])).rows[0].result
  const item = { summary: '交通费', unit_price: 10.1234, quantity: 2, receipt_path: receipt }
  await context(owner)
  await db.query(`insert into storage.objects(bucket_id,name) values ('finance-reimbursement-receipts',$1)`, [receipt])
  await assert.rejects(() => db.query(`insert into storage.objects(bucket_id,name) values ('finance-reimbursement-receipts',$1)`,
    [`${finance}/20000000-0000-4000-8000-000000000002.png`]), /row-level security/)
  const requestId = (await save(null, [item])).request_id
  assert.equal(Number((await db.query('select amount from finance_reimbursement_items where request_id=$1', [requestId])).rows[0].amount), 20.2468)
  await assert.rejects(() => save(null, []), /1 to 100/)
  await assert.rejects(() => save(null, [{ ...item, unit_price: 1000, quantity: 999999999999 }]), /range/)
  await assert.rejects(() => save(null, [{ ...item, unit_price: 1.00001 }]), /4 decimals/)
  await assert.rejects(() => save(null, [{ ...item, receipt_path: `${finance}/20000000-0000-4000-8000-000000000003.png` }]), /applicant/)
  await db.exec('reset role')
  await db.exec(`create function reject_test_item() returns trigger language plpgsql as $$
    begin if new.summary='FORCED_FAILURE' then raise exception 'forced item failure'; end if; return new; end $$;
    create trigger reject_test_item before insert on finance_reimbursement_items for each row execute function reject_test_item();`)
  await context(owner)
  await assert.rejects(() => save(requestId, [{ ...item, summary: 'FORCED_FAILURE' }], '2026-10-02', '不应保存'), /forced item failure/)
  assert.equal((await db.query('select project_name from finance_reimbursement_requests where id=$1', [requestId])).rows[0].project_name, '测试报销')
  assert.equal((await db.query('select summary from finance_reimbursement_items where request_id=$1', [requestId])).rows[0].summary, '交通费')
  assert.equal((await db.query('select * from storage.objects where name=$1', [receipt])).rows.length, 1)
  await context(finance)
  assert.equal((await db.query('select * from finance_reimbursement_requests where id=$1', [requestId])).rows.length, 1)
  assert.equal((await db.query(`update finance_reimbursement_requests set status='approved' where id=$1 returning id`, [requestId])).rows.length, 0)
  await assert.rejects(() => save(requestId, [item]), /applicant/)
  const financeId = (await save(null, [{ ...item, receipt_path: null }])).request_id
  await assert.rejects(() => db.query(`update finance_reimbursement_requests set status='approved' where id=$1`, [financeId]), /admin/)
  await context(admin)
  await assert.rejects(() => db.query(`update finance_reimbursement_requests set status='approved',project_name='篡改' where id=$1`, [requestId]), /content/)
  await assert.rejects(() => db.query(`update finance_reimbursement_requests set status='approved',reviewed_by=auth.uid() where id=$1`, [requestId]), /fields/)
  await db.query(`update finance_reimbursement_requests set status='rejected',reject_reason='补充明细' where id=$1`, [requestId])
  await context(owner)
  const saved = await save(requestId, [{ ...item, summary: '交通费补充', receipt_path: null }], '2026-10-03')
  assert.deepEqual(saved.receipt_paths, [receipt])
  assert.deepEqual((await db.query('select status,reviewed_by,reject_reason from finance_reimbursement_requests where id=$1', [requestId])).rows[0],
    { status: 'pending', reviewed_by: null, reject_reason: null })
  await context(admin)
  await db.query(`update finance_reimbursement_requests set status='approved' where id=$1`, [requestId])
  assert.equal((await db.query('select reviewed_by from finance_reimbursement_requests where id=$1', [requestId])).rows[0].reviewed_by, admin)
  await context(owner)
  await assert.rejects(() => save(requestId, [item]), /pending or rejected/)
  await db.query(`update finance_reimbursement_items set summary='越权' where request_id=$1`, [requestId])
  assert.equal((await db.query('select summary from finance_reimbursement_items where request_id=$1', [requestId])).rows[0].summary, '交通费补充')
  await context(admin)
  await db.query(`update finance_reimbursement_requests set status='completed' where id=$1`, [requestId])
  assert.equal((await db.query('select completed_by from finance_reimbursement_requests where id=$1', [requestId])).rows[0].completed_by, admin)
  await context(unapproved)
  await assert.rejects(() => save(null, [{ ...item, receipt_path: null }]), /approved/)
  await assert.rejects(() => db.query(`insert into storage.objects(bucket_id,name) values ('finance-reimbursement-receipts',$1)`,
    [`${unapproved}/20000000-0000-4000-8000-000000000004.png`]), /row-level security/)
  await db.exec('reset role')
  assert.equal((await db.query(`select has_function_privilege('anon','public.save_finance_reimbursement_request(uuid,date,text,jsonb)','EXECUTE') as allowed`)).rows[0].allowed, false)
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
