const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')

const OWNER = '10000000-0000-4000-8000-000000000002'
const FINANCE = '10000000-0000-4000-8000-000000000001'
const ADMIN = '10000000-0000-4000-8000-000000000003'

const receipt = (n) =>
  `${OWNER}/20000000-0000-4000-8000-${String(n).padStart(12, '0')}.png`

async function main() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;
    create table public.profiles (id uuid primary key, role text not null, status text not null);
    grant usage on schema public to authenticated, anon;
    grant select on public.profiles to authenticated;
    insert into profiles values
      ('${OWNER}', 'sales', 'approved'),
      ('${FINANCE}', 'finance', 'approved'),
      ('${ADMIN}', 'admin', 'approved');
    create function public.is_approved_user() returns boolean language sql security definer as $$
      select exists(select 1 from public.profiles where id=auth.uid() and status='approved') $$;
    create function public.is_finance_or_admin() returns boolean language sql security definer as $$
      select exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','finance') and status='approved') $$;
    create function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    create function storage.foldername(name text) returns text[] language sql immutable as $$
      select (string_to_array(name,'/'))[1:cardinality(string_to_array(name,'/'))-1] $$;
    grant usage on schema storage to authenticated, anon;
    grant select, insert, delete on storage.objects to authenticated;
  `)
  const migration = (name) => fs.readFileSync(path.join(__dirname, '../supabase/migrations', name), 'utf8')
  await db.exec(migration('0119_finance_reimbursement.sql'))
  await db.exec(migration('0120_reimbursement_atomic_save.sql'))
  await db.exec(migration('0126_reimbursement_multi_receipts.sql'))
  await db.exec(migration('0126_reimbursement_multi_receipts.sql'))

  const as = async (uid, fn) => {
    await db.exec(`set role authenticated; set request.jwt.claim.sub = '${uid}';`)
    try {
      return await fn()
    } finally {
      await db.exec('reset role; reset request.jwt.claim.sub;')
    }
  }
  const save = (id, items, date = '2026-10-01', project = '多图报销') =>
    db
      .query('select save_finance_reimbursement_request($1,$2,$3,$4::jsonb) as result', [
        id,
        date,
        project,
        JSON.stringify(items),
      ])
      .then((r) => r.rows[0].result)
  const item = (over = {}) => ({ summary: '交通费', unit_price: 10, quantity: 1, receipt_paths: [], ...over })
  const storedPaths = async (requestId) =>
    (await db.query('select receipt_paths from finance_reimbursement_items where request_id=$1 order by sort_order', [requestId])).rows.map(
      (r) => r.receipt_paths,
    )

  // ---------- 列结构：receipt_path 已切换为 text[] ----------
  const cols = (await db.query(`select data_type, udt_name, is_nullable, column_default
    from information_schema.columns where table_schema='public' and table_name='finance_reimbursement_items' and column_name='receipt_paths'`)).rows[0]
  assert.equal(cols.udt_name, '_text', 'receipt_paths 必须是 text[]')
  assert.equal(cols.is_nullable, 'NO')
  const legacy = (await db.query(`select count(*) from information_schema.columns
    where table_schema='public' and table_name='finance_reimbursement_items' and column_name='receipt_path'`)).rows[0].count
  assert.equal(Number(legacy), 0, '旧 receipt_path 列必须已删除')

  // ---------- 创建：多图写入与顺序保持 ----------
  const r1 = await as(OWNER, () =>
    save(null, [item({ receipt_paths: [receipt(1), receipt(2), receipt(3)] }), item()]))
  assert.deepEqual(await storedPaths(r1.request_id), [[receipt(1), receipt(2), receipt(3)], []])

  // ---------- 校验拒绝 ----------
  await as(OWNER, async () => {
    await assert.rejects(() => save(null, [item({ receipt_paths: 'not-array' })]), /receipt paths/)
    await assert.rejects(() => save(null, [item({ receipt_paths: Array.from({ length: 10 }, (_, i) => receipt(i + 10)) })]), /at most 9/)
    await assert.rejects(() => save(null, [item({ receipt_paths: [`${FINANCE}/20000000-0000-4000-8000-000000000099.png`] })]), /applicant/)
    await assert.rejects(() => save(null, [item({ receipt_paths: [`${OWNER}/bad-name.png`] })]), /valid image/)
  })

  // ---------- 编辑：去掉一张 → 仅被移除的进入待清理 ----------
  const r2 = await as(OWNER, () =>
    save(null, [item({ receipt_paths: [receipt(4), receipt(5)] }), item({ receipt_paths: [receipt(6)] })]))
  const edited = await as(OWNER, () =>
    save(r2.request_id, [item({ receipt_paths: [receipt(5)] }), item({ receipt_paths: [receipt(6)] })]))
  assert.deepEqual(edited.receipt_paths, [receipt(4)], '仅未再被引用的凭证进入待清理')
  assert.deepEqual(await storedPaths(r2.request_id), [[receipt(5)], [receipt(6)]])

  // ---------- 跨单复用：仍被其他报销单引用的路径不能清理 ----------
  const r3 = await as(OWNER, () => save(null, [item({ receipt_paths: [receipt(5)] })]))
  assert.equal(r3.receipt_paths.length, 0, '复用中的凭证不能被判为未使用')
  await as(OWNER, () => save(r2.request_id, [item({ receipt_paths: [] }), item({ receipt_paths: [receipt(6)] })]))
  assert.deepEqual(await storedPaths(r2.request_id), [[], [receipt(6)]])

  // ---------- 状态锁：审批后不可再保存 ----------
  await as(ADMIN, () => db.query(`update finance_reimbursement_requests set status='approved' where id='${r2.request_id}'`))
  await as(OWNER, () => assert.rejects(() => save(r2.request_id, [item()]), /pending or rejected/))

  // ---------- 权限：anon 不能执行 RPC ----------
  const grants = (await db.query(`select
    has_function_privilege('anon','public.save_finance_reimbursement_request(uuid,date,text,jsonb)','EXECUTE') as anon_rpc,
    has_function_privilege('authenticated','public.save_finance_reimbursement_request(uuid,date,text,jsonb)','EXECUTE') as auth_rpc`)).rows[0]
  assert.equal(grants.anon_rpc, false)
  assert.equal(grants.auth_rpc, true)

  await db.close()
  console.log('PASS: 0126 报销多凭证图——数组列/顺序/上限9张/归属正则/编辑清理/跨单复用/审批锁/匿名拒绝')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
