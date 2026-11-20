const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')

async function expectError(fn, pattern) {
  try {
    await fn()
  } catch (err) {
    assert.match(String(err.message ?? err), pattern)
    return
  }
  throw new Error(`expected failure matching ${pattern}`)
}

const SALES_ID = '11111111-1111-4111-8111-111111111111'
const PENDING_ID = '22222222-2222-4222-8222-222222222222'
const ORDER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const objectPath = (ext) =>
  `${SALES_ID}/${ORDER_ID}/cccccccc-cccc-4ccc-8ccc-cccccccccccc.${ext}`

async function main() {
  const db = new PGlite()
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    grant usage on schema public to authenticated, anon;

    create schema if not exists auth;
    create function auth.uid() returns uuid
      language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    create schema if not exists storage;
    create function storage.foldername(name text) returns text[]
      language sql immutable
      as $$ select (string_to_array(name, '/'))[1:cardinality(string_to_array(name, '/')) - 1] $$;
    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null default false,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text not null,
      name text not null,
      metadata jsonb,
      owner uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      last_accessed_at timestamptz,
      unique (bucket_id, name)
    );

    create type public.currency_code as enum ('USD', 'CNY');
    create type public.finance_record_status as enum ('active', 'void');

    create table public.profiles (
      id uuid primary key,
      role text not null default 'sales',
      status text not null default 'approved'
    );
    create table public.business_orders (
      id uuid primary key,
      salesperson_id uuid references public.profiles(id),
      status text not null default 'approved',
      voided_at timestamptz,
      closed_at timestamptz
    );
    create table public.finance_daily_orders (
      id uuid primary key,
      salesperson_id uuid
    );
    create table public.business_order_attachments (
      id uuid primary key default gen_random_uuid(),
      order_id uuid not null references public.business_orders(id) on delete restrict,
      object_path text not null unique,
      original_name text,
      mime_type text not null check (mime_type in ('image/jpeg', 'image/png')),
      size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 20971520),
      status public.finance_record_status not null default 'active',
      created_by uuid references public.profiles(id) on delete set null,
      removed_by uuid references public.profiles(id) on delete set null,
      removed_at timestamptz,
      created_at timestamptz not null default now(),
      constraint business_order_attachment_name_check check (
        original_name is null or char_length(original_name) <= 255
      ),
      constraint business_order_attachment_path_check check (
        object_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(jpe?g|png)$'
      ),
      constraint business_order_attachment_removed_check check (
        (status = 'active' and removed_at is null and removed_by is null)
        or (status = 'void' and removed_at is not null and removed_by is not null)
      )
    );

    create function public.is_approved_user() returns boolean
      language sql stable as $$ select true $$;
    create function public.is_finance_or_admin() returns boolean
      language sql stable as $$ select false $$;
    create function public.is_my_subordinate(salesperson_id uuid) returns boolean
      language sql stable as $$ select false $$;
    create function public.business_order_accepts_entry_edits(order_id uuid, actor_role text)
      returns boolean language sql stable as $$ select true $$;
    create function public.can_view_business_order(order_id uuid) returns boolean
      language sql stable as $$ select true $$;
    create function public.daily_order_screenshot_object_is_unbound(object_name text)
      returns boolean language sql stable as $$ select true $$;
  `)

  await db.exec(`
    insert into public.profiles (id, role, status) values
      ('${SALES_ID}', 'sales', 'approved'),
      ('${PENDING_ID}', 'sales', 'pending');
    insert into public.business_orders (id, salesperson_id) values ('${ORDER_ID}', '${SALES_ID}');
    insert into storage.objects (bucket_id, name, metadata) values
      ('finance-daily-order-screenshots', '${objectPath('pdf')}', '{"mimetype":"application/pdf","size":"1234"}'),
      ('finance-daily-order-screenshots', '${objectPath('docx')}', '{"mimetype":"application/vnd.openxmlformats-officedocument.wordprocessingml.document","size":"2345"}'),
      ('finance-daily-order-screenshots', '${objectPath('csv')}', '{"mimetype":"text/plain","size":"3456"}');
  `)

  const migration = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/0157_order_attachment_documents.sql'),
    'utf8',
  )
  await db.exec(migration)

  // ---- 1. 桶与列约束放宽 --------------------------------------------------
  const bucket = await db.query(
    `select file_size_limit, allowed_mime_types, public from storage.buckets where id = 'finance-daily-order-screenshots'`,
  )
  assert.equal(bucket.rows[0].public, false, 'bucket stays private')
  assert.equal(Number(bucket.rows[0].file_size_limit), 20971520, 'bucket size limit kept')
  for (const mime of [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
  ]) {
    assert.ok(bucket.rows[0].allowed_mime_types.includes(mime), `bucket allows ${mime}`)
  }

  await db.exec(`insert into public.business_order_attachments
    (order_id, object_path, original_name, mime_type, size_bytes, created_by)
    values ('${ORDER_ID}', '${objectPath('pdf')}', '报价单.pdf', 'application/pdf', 1234, '${SALES_ID}');`)
  await expectError(
    () =>
      db.exec(`insert into public.business_order_attachments
        (order_id, object_path, original_name, mime_type, size_bytes, created_by)
        values ('${ORDER_ID}', '${objectPath('txt')}', 'a.txt', 'text/plain', 10, '${SALES_ID}');`),
    /business_order_attachments?_(mime_type|path)_check/,
  )

  // ---- 2. 存储策略已重建且路径正则含文档扩展名 ----------------------------
  const policies = await db.query(
    `select policyname, qual, with_check from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname like 'finance_daily_order_screenshots_%'`,
  )
  assert.equal(policies.rows.length, 3, 'three storage policies recreated')
  const allPolicyText = policies.rows.map((row) => `${row.qual ?? ''} ${row.with_check ?? ''}`).join(' ')
  assert.match(allPolicyText, /xlsx\|xls\|csv\|docx\|doc/, 'policies accept document extensions')

  // ---- 3. bind RPC：文档可绑定、重复绑定幂等 ------------------------------
  await db.exec(`select set_config('request.jwt.claim.sub', '${SALES_ID}', false);`)
  const bound = await db.query(`select * from public.bind_business_order_attachment(
    '${ORDER_ID}', '${objectPath('pdf')}', '报价单.pdf', 'application/pdf', 1234);`)
  assert.equal(bound.rows[0].mime_type, 'application/pdf', 'pdf bound')
  const again = await db.query(`select * from public.bind_business_order_attachment(
    '${ORDER_ID}', '${objectPath('pdf')}', '报价单.pdf', 'application/pdf', 1234);`)
  assert.equal(again.rows[0].id, bound.rows[0].id, 'rebinding same object is idempotent')

  const docx = await db.query(`select * from public.bind_business_order_attachment(
    '${ORDER_ID}', '${objectPath('docx')}', '合同.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 2345);`)
  assert.equal(docx.rows[0].original_name, '合同.docx', 'docx bound')

  // ---- 4. bind RPC 仍拒绝不支持类型与元数据不符 ---------------------------
  await expectError(
    () =>
      db.query(`select * from public.bind_business_order_attachment(
        '${ORDER_ID}', '${objectPath('csv')}', '数据.csv', 'text/csv', 3456);`),
    /Invalid attachment type or size|metadata does not match/,
  )
  await expectError(
    () =>
      db.query(`select * from public.bind_business_order_attachment(
        '${ORDER_ID}', '${objectPath('docx')}', 'x.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 999999);`),
    /metadata does not match/,
  )
  await expectError(
    () =>
      db.query(`select * from public.bind_business_order_attachment(
        '${ORDER_ID}', '${objectPath('docx')}', 'x.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 20971521);`),
    /Invalid attachment type or size/,
  )

  // ---- 5. 迁移可重复执行 --------------------------------------------------
  await db.exec(migration)
  const rerun = await db.query(`select * from public.bind_business_order_attachment(
    '${ORDER_ID}', '${objectPath('pdf')}', '报价单.pdf', 'application/pdf', 1234);`)
  assert.equal(rerun.rows[0].id, bound.rows[0].id, 'rerun keeps bindings')

  console.log('✓ 0157 订单附件文档类型演练通过')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
