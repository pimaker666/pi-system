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
const migration = '0090_permission_management.sql'
if (!files.includes(migration)) throw new Error('FAIL 0090 migration not found')
await db.exec(await readFile(join(migrationsDir, migration), 'utf8'))
console.log('PASS 0090 is idempotent')
await db.exec('grant select, insert, update, delete on all tables in schema public to authenticated; grant usage, select on all sequences in schema public to authenticated;')
const assert = (condition, message) => { if (!condition) throw new Error(`FAIL ${message}`); console.log(`PASS ${message}`) }
const scalar = async (sql) => { const result = await db.query(sql); return result.rows[0] ? Object.values(result.rows[0])[0] : null }
async function setUser(id) { await db.exec('reset role'); await db.query(`select set_config('request.jwt.claim.sub', '${id}', false)`); await db.exec('set role authenticated') }
const adminId = '11111111-1111-4111-8111-111111111111'
const salesId = '22222222-2222-4222-8222-222222222222'
await db.exec(`
  alter table public.profiles disable trigger trg_profiles_protect_privileged;
  insert into auth.users (id, email) values ('${adminId}', 'admin@example.com'), ('${salesId}', 'sales@example.com');
  update public.profiles set role='admin', status='approved' where id='${adminId}';
  update public.profiles set role='sales', status='approved' where id='${salesId}';
  alter table public.profiles enable trigger trg_profiles_protect_privileged;
`)
await setUser(adminId)
await db.query(`select public.admin_save_profile_permission_override('${salesId}', '["orders.record_transfer"]'::jsonb, '["orders.void"]'::jsonb, 'self'::text, '{"cost":false}'::jsonb, null)`)
assert(await scalar(`select count(*) from public.profile_permission_overrides where profile_id='${salesId}'`) === 1, 'admin saves account override')
await db.query(`select public.admin_save_order_edit_approval_rule(null, '金额修改审核', true, 'business_order', array['amount_or_rate_change'], '{}'::jsonb, array['admin']::public.user_role[], '{}'::uuid[], 'any')`)
assert(await scalar(`select count(*) from public.order_edit_approval_rules`) === 1, 'admin saves approval rule')
assert(await scalar(`select count(*) from public.permission_audit_logs`) === 2, 'permission changes are audited')
await setUser(salesId)
const resolved = await scalar(`select public.get_profile_permission_resolution('${salesId}')`)
const resolvedValue = typeof resolved === 'string' ? JSON.parse(resolved) : resolved
assert(resolvedValue.denied_permissions.includes('orders.void'), 'account resolves its own effective override')
let denied = false
try { await db.query(`select public.admin_save_permission_template('sales', 'x', '', '{}'::jsonb, 'self', '{}'::jsonb)`) } catch { denied = true }
assert(denied, 'sales cannot change templates')
await db.close()
console.log('VERIFY PASS 0090')
