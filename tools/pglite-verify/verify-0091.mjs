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
  create schema auth; create schema extensions; create schema storage;
  create role anon nologin; create role authenticated nologin; create role service_role nologin; create role supabase_admin nologin;
  create extension if not exists pgcrypto;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
  create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now());
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, owner_id text, created_at timestamptz default now(), updated_at timestamptz default now(), metadata jsonb);
  create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
  create function extensions.digest(data text, type text) returns bytea language sql immutable as $$ select public.digest(data, type) $$;
`)

const files = (await readdir(migrationsDir)).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort()
for (const file of files) await db.exec(await readFile(join(migrationsDir, file), 'utf8'))
const migration = '0091_fix_approval_rule_uuid_generation.sql'
if (!files.includes(migration)) throw new Error('FAIL 0091 migration not found')
await db.exec(await readFile(join(migrationsDir, migration), 'utf8'))
console.log('PASS 0091 is idempotent')

await db.exec('grant select, insert, update, delete on all tables in schema public to authenticated; grant usage, select on all sequences in schema public to authenticated;')
const adminId = '11111111-1111-4111-8111-111111111111'
await db.exec(`
  alter table public.profiles disable trigger trg_profiles_protect_privileged;
  insert into auth.users (id, email) values ('${adminId}', 'admin@example.com');
  update public.profiles set role='admin', status='approved' where id='${adminId}';
  alter table public.profiles enable trigger trg_profiles_protect_privileged;
  select set_config('request.jwt.claim.sub', '${adminId}', false);
  set role authenticated;
`)

await db.query(`select public.admin_save_order_edit_approval_rule(null, '金额修改审核', true, 'business_order', array['amount_or_rate_change'], '{}'::jsonb, array['admin']::public.user_role[], '{}'::uuid[], 'any')`)
const result = await db.query('select id from public.order_edit_approval_rules')
if (result.rows.length !== 1 || !result.rows[0].id) throw new Error('FAIL approval rule UUID was not generated')
console.log('PASS approval rule save generates UUID with restricted search_path')

await db.close()
console.log('VERIFY PASS 0091')
