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
const migration = '0092_add_cancellation_approval_rules.sql'
if (!files.includes(migration)) throw new Error('FAIL 0092 migration not found')
await db.exec(await readFile(join(migrationsDir, migration), 'utf8'))
console.log('PASS 0092 is idempotent')

const seeded = await db.query(`
  select name, trigger_actions, enabled
  from public.order_edit_approval_rules
  where name in ('已结清订单取消结清审核', '已结算订单取消结算审核')
  order by name
`)
if (seeded.rows.length !== 2) throw new Error('FAIL cancellation approval rules were not seeded')
if (seeded.rows.some((row) => row.enabled !== false)) throw new Error('FAIL seeded cancellation approval rules must default disabled')
console.log('PASS cancellation approval rules are seeded disabled')

await db.close()
console.log('VERIFY PASS 0092')
