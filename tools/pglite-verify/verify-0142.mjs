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

assert.equal(
  await scalar(`
    select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'finance_journal_entries'
      and column_name = 'split_group_id' and data_type = 'uuid' and is_nullable = 'YES'
  `),
  1,
  '0142 adds nullable uuid split_group_id',
)

const indexDef = await scalar(`
  select indexdef from pg_indexes
  where schemaname = 'public' and indexname = 'finance_journal_entries_split_group_idx'
`)
assert.ok(indexDef, '0142 creates the split group index')
assert.ok(
  indexDef.includes('WHERE (split_group_id IS NOT NULL)'),
  'split group index is partial',
)

const before = await scalar(`select count(*)::int from pg_indexes where schemaname = 'public'`)
await db.exec(await readFile(join(migrationsDir, '0142_journal_split_group.sql'), 'utf8'))
const after = await scalar(`select count(*)::int from pg_indexes where schemaname = 'public'`)
assert.equal(after, before, '0142 is repeatable')

const groupId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const accountId = await scalar(`
  insert into public.finance_journal_accounts (name, currency, initial_balance, is_active)
  values ('0142 演练账户', 'CNY', 0, true) returning id
`)
const categoryId = await scalar(`
  insert into public.finance_journal_categories (name, kind, is_active)
  values ('0142 演练分类', 'expense', true) returning id
`)
const adminId = await scalar(`select id from public.profiles limit 1`)
await db.query(
  `insert into public.finance_journal_entries
     (account_id, category_id, entry_date, kind, amount_original, currency,
      exchange_rate_to_cny, summary, split_group_id, created_by)
   values
     ('${accountId}', '${categoryId}', current_date, 'expense', 100, 'CNY', 1, '批次甲', '${groupId}', ${adminId ? `'${adminId}'` : 'null'}),
     ('${accountId}', '${categoryId}', current_date, 'expense', 200, 'CNY', 1, '批次甲', '${groupId}', ${adminId ? `'${adminId}'` : 'null'}),
     ('${accountId}', '${categoryId}', current_date, 'expense', 50, 'CNY', 1, '单笔', null, ${adminId ? `'${adminId}'` : 'null'})`,
)
assert.equal(
  await scalar(`select count(*)::int from public.finance_journal_entries where split_group_id = '${groupId}'`),
  2,
  'batch rows share the group id',
)
assert.equal(
  await scalar(`select sum(amount_cny)::int from public.finance_journal_entries where split_group_id = '${groupId}'`),
  300,
  'batch total sums detail rows only',
)
assert.equal(
  await scalar(`select count(*)::int from public.finance_journal_entries where split_group_id is null`),
  1,
  'standalone rows keep null group id',
)

await db.close()
console.log('VERIFY 0142 PASS')
