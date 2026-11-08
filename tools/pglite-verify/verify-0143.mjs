import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = resolve(here, '../../supabase/migrations')
const db = new PGlite({ extensions: { uuid_ossp, pgcrypto, pg_trgm } })

await db.exec(`
  create schema auth;
  create schema extensions;
  create schema storage;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create role supabase_admin nologin;
  create extension if not exists pgcrypto;
  create function public.uuid_generate_v4() returns uuid language sql volatile as $$ select gen_random_uuid() $$;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create function auth.role() returns text language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
  $$;
  create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now());
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid, owner_id text, created_at timestamptz default now(), updated_at timestamptz default now(), metadata jsonb);
  create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
  create function extensions.digest(data text, type text) returns bytea language sql immutable as $$ select public.digest(data, type) $$;
`)

const files = (await readdir(migrationsDir))
  .filter((name) => /^\d{4}.*\.sql$/.test(name))
  .sort()

for (const file of files) {
  let sql = await readFile(join(migrationsDir, file), 'utf8')
  sql = sql
    .replace(/^create extension if not exists .*;\s*$/gim, '')
    .replace(/^create index[^;]*gin_trgm_ops\);\s*$/gim, '')
    .replace(/create index concurrently if not exists/gi, 'create index if not exists')
    .replace(/create index concurrently/gi, 'create index')
  await db.exec(sql)
}
console.log(`APPLY PASS ${files.length} migrations`)

async function scalar(sql) {
  const result = await db.query(sql)
  return result.rows[0] ? Object.values(result.rows[0])[0] : null
}

async function expectFail(sql, message) {
  let error = null
  try {
    await db.exec(sql)
  } catch (caught) {
    error = caught
  }
  assert.ok(error, message)
  return error
}

// ---------------------------------------------------------------------------
// 1. 结构：字段、类型、约束
// ---------------------------------------------------------------------------
assert.equal(
  await scalar(`
    select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'leave_requests'
      and column_name = 'hours' and data_type = 'numeric' and is_nullable = 'YES'
  `),
  1,
  'leave_requests.hours exists and is nullable',
)

assert.equal(
  await scalar(`
    select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'attendance_entries'
      and (
        (column_name = 'morning_leave_hours' and data_type = 'numeric' and is_nullable = 'NO')
        or (column_name = 'afternoon_leave_hours' and data_type = 'numeric' and is_nullable = 'NO')
        or (column_name = 'morning_leave_type' and data_type = 'text' and is_nullable = 'YES')
        or (column_name = 'afternoon_leave_type' and data_type = 'text' and is_nullable = 'YES')
      )
  `),
  4,
  'attendance_entries has four hourly columns',
)

assert.equal(
  await scalar(`
    select numeric_precision::int * 100 + numeric_scale::int from information_schema.columns
    where table_schema = 'public' and table_name = 'payroll_items'
      and column_name = 'attendance_days'
  `),
  602,
  'payroll_items.attendance_days is numeric(6,2)',
)

assert.equal(
  await scalar(`
    select count(*)::int from pg_constraint
    where conname in (
      'leave_requests_hours_check',
      'attendance_entries_morning_hourly_check',
      'attendance_entries_afternoon_hourly_check'
    )
  `),
  3,
  '0143 creates the hourly check constraints',
)

const before = await scalar(`select count(*)::int from pg_constraint where connamespace = 'public'::regnamespace`)
await db.exec(await readFile(join(migrationsDir, '0143_hourly_leave.sql'), 'utf8'))
const after = await scalar(`select count(*)::int from pg_constraint where connamespace = 'public'::regnamespace`)
assert.equal(after, before, '0143 is repeatable')

// ---------------------------------------------------------------------------
// 2. 夹具：请假人 + 财务
// ---------------------------------------------------------------------------
const applicantId = '11111111-1111-4111-8111-111111111111'
const financeId = '22222222-2222-4222-8222-222222222222'
await db.exec(`
  insert into auth.users (id, email) values
    ('${applicantId}', 'applicant-0143@example.com'),
    ('${financeId}', 'finance-0143@example.com')
`)
await db.exec(`
  set session_replication_role = 'replica';
  update public.profiles
  set role = 'finance', status = 'approved', chinese_name = '财务演练'
  where id = '${financeId}';
  set session_replication_role = 'origin';
`)
await db.exec(`select set_config('request.jwt.claim.sub', '${applicantId}', false)`)

// 合法：上午 1 小时
const morningRequestId = await scalar(`
  insert into public.leave_requests
    (applicant_id, leave_type, start_date, end_date, day_part, hours, reason)
  values
    ('${applicantId}', 'personal', '2026-03-10', '2026-03-10', 'morning', 1, '上午看牙')
  returning id
`)
// 合法：下午 3.5 小时
await db.exec(`
  insert into public.leave_requests
    (applicant_id, leave_type, start_date, end_date, day_part, hours, reason)
  values
    ('${applicantId}', 'sick', '2026-03-12', '2026-03-12', 'afternoon', 3.5, '下午就医')
`)

// 非法组合应被 check 拒绝
await expectFail(
  `
    insert into public.leave_requests
      (applicant_id, leave_type, start_date, end_date, day_part, hours, reason)
    values ('${applicantId}', 'personal', '2026-03-16', '2026-03-16', 'morning', 3.5, '超上限')
  `,
  'morning hourly leave over 3.0h is rejected',
)
await expectFail(
  `
    insert into public.leave_requests
      (applicant_id, leave_type, start_date, end_date, day_part, hours, reason)
    values ('${applicantId}', 'personal', '2026-03-16', '2026-03-16', 'full', 1, '全天不能按小时')
  `,
  'hourly leave requires a half day',
)
await expectFail(
  `
    insert into public.leave_requests
      (applicant_id, leave_type, start_date, end_date, day_part, hours, reason)
    values ('${applicantId}', 'personal', '2026-03-16', '2026-03-17', 'morning', 1, '跨天')
  `,
  'hourly leave must stay within one day',
)
await expectFail(
  `
    insert into public.leave_requests
      (applicant_id, leave_type, start_date, end_date, day_part, hours, reason)
    values ('${applicantId}', 'personal', '2026-03-16', '2026-03-16', 'morning', 1.3, '非半点')
  `,
  'hourly leave must use 0.5h steps',
)

// ---------------------------------------------------------------------------
// 3. 审批 RPC：小时假写入 √ + 小时数
// ---------------------------------------------------------------------------
await db.exec(`select set_config('request.jwt.claim.sub', '${financeId}', false)`)
assert.equal(
  await scalar(`select public.review_leave_request('${morningRequestId}'::uuid, true) ->> 'written_days'`),
  '1',
  'approving an hourly request reports one written day',
)
assert.equal(
  await scalar(`
    select count(*)::int from public.attendance_entries
    where day = 10 and morning = '√'
      and morning_leave_hours = 1 and morning_leave_type = 'personal'
      and afternoon = '' and afternoon_leave_hours = 0 and afternoon_leave_type is null
  `),
  1,
  'hourly approval keeps √ and tags hours + type on the half',
)

await db.exec(`select set_config('request.jwt.claim.sub', '${applicantId}', false)`)
const conflictRequestId = await scalar(`
  insert into public.leave_requests
    (applicant_id, leave_type, start_date, end_date, day_part, hours, reason)
  values ('${applicantId}', 'vacation', '2026-03-10', '2026-03-10', 'morning', 1, '重复申请')
  returning id
`)
await db.exec(`select set_config('request.jwt.claim.sub', '${financeId}', false)`)
const conflictError = await expectFail(
  `select public.review_leave_request('${conflictRequestId}'::uuid, true)`,
  'conflicting hourly approval is rejected instead of overwriting',
)
assert.match(
  String(conflictError.message ?? ''),
  /已有小时假/,
  'conflict is reported as an existing hourly annotation',
)
assert.equal(
  await scalar(`select status from public.leave_requests where id = '${conflictRequestId}'`),
  'pending',
  'failed hourly approval leaves the request pending',
)
assert.equal(
  Number(await scalar(`select morning_leave_hours from public.attendance_entries where day = 10`)),
  1,
  'existing hourly annotation is untouched',
)

// 按天请假仍只写空白半天，且不破坏既有小时假字段
await db.exec(`select set_config('request.jwt.claim.sub', '${applicantId}', false)`)
const dayRequestId = await scalar(`
  insert into public.leave_requests
    (applicant_id, leave_type, start_date, end_date, day_part, hours, reason)
  values ('${applicantId}', 'personal', '2026-03-20', '2026-03-20', 'full', null, '全天事假')
  returning id
`)
await db.exec(`select set_config('request.jwt.claim.sub', '${financeId}', false)`)
await db.exec(`select public.review_leave_request('${dayRequestId}'::uuid, true)`)
assert.equal(
  await scalar(`
    select count(*)::int from public.attendance_entries
    where day = 20 and morning = '○' and afternoon = '○'
      and morning_leave_hours = 0 and afternoon_leave_hours = 0
      and morning_leave_type is null and afternoon_leave_type is null
  `),
  1,
  'day leave still writes leave symbols without hourly fields',
)

// ---------------------------------------------------------------------------
// 4. 考勤格约束：上限、步进、必须挂在 √ 上
// ---------------------------------------------------------------------------
const sheetId = await scalar(`select sheet_id from public.attendance_entries where day = 10`)
const memberId = await scalar(`select member_id from public.attendance_entries where day = 10`)

await db.exec(`
  insert into public.attendance_entries
    (sheet_id, member_id, day, morning, morning_leave_hours, morning_leave_type)
  values ('${sheetId}', '${memberId}', 21, '√', 3.0, 'sick')
`)
await db.exec(`
  insert into public.attendance_entries
    (sheet_id, member_id, day, afternoon, afternoon_leave_hours, afternoon_leave_type)
  values ('${sheetId}', '${memberId}', 22, '√', 3.5, 'vacation')
`)
await expectFail(
  `
    insert into public.attendance_entries
      (sheet_id, member_id, day, morning, morning_leave_hours, morning_leave_type)
    values ('${sheetId}', '${memberId}', 23, '√', 3.5, 'personal')
  `,
  'morning hours are capped at 3.0',
)
await expectFail(
  `
    insert into public.attendance_entries
      (sheet_id, member_id, day, morning, morning_leave_hours, morning_leave_type)
    values ('${sheetId}', '${memberId}', 24, '', 1, 'personal')
  `,
  'hourly leave requires the √ symbol',
)
await expectFail(
  `
    insert into public.attendance_entries
      (sheet_id, member_id, day, morning, morning_leave_hours, morning_leave_type)
    values ('${sheetId}', '${memberId}', 25, '√', 0, 'personal')
  `,
  'zero hours cannot carry a leave type',
)
await expectFail(
  `
    insert into public.attendance_entries
      (sheet_id, member_id, day, morning, morning_leave_hours, morning_leave_type)
    values ('${sheetId}', '${memberId}', 26, '√', 1.3, 'personal')
  `,
  'entry hours must use 0.5h steps',
)

await db.close()
console.log('VERIFY 0143 PASS')
