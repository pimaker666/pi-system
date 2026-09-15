import { PGlite } from '@electric-sql/pglite'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root =
  process.env.MIGRATIONS_DIR ?? path.resolve(here, '../../supabase/migrations')
const db = new PGlite()

await db.exec(`
  create schema auth;
  create schema extensions;
  create schema storage;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create function public.uuid_generate_v4() returns uuid language sql volatile as $$
    select gen_random_uuid()
  $$;
  create function extensions.digest(value text, algorithm text) returns bytea language sql immutable as $$
    select convert_to(value, 'UTF8')
  $$;
  create function public.digest(value text, algorithm text) returns bytea language sql immutable as $$
    select convert_to(value, 'UTF8')
  $$;
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb default '{}'::jsonb
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create function auth.role() returns text language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
  $$;
  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text not null references storage.buckets(id),
    name text not null,
    owner uuid,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    unique (bucket_id, name)
  );
  create function storage.foldername(name text) returns text[] language sql immutable as $$
    select case
      when strpos(name, '/') = 0 then array[]::text[]
      else string_to_array(regexp_replace(name, '/[^/]+$', ''), '/')
    end
  $$;
`)

const files = (await readdir(root))
  .filter((name) => /^\d{4}.*\.sql$/.test(name))
  .sort()

await db.exec('begin')
try {
  for (const file of files) {
    let sql = await readFile(path.join(root, file), 'utf8')
    sql = sql
      .replace(/^create extension if not exists .*;\s*$/gim, '')
      .replace(/^create index[^;]*gin_trgm_ops\);\s*$/gim, '')
    await db.exec(sql)
    console.log(`PASS ${file}`)
  }
  await db.exec('rollback')
  console.log(`PASS ${files.length} migrations in one transaction`)
} catch (error) {
  await db.exec('rollback').catch(() => {})
  console.error(error)
  process.exitCode = 1
} finally {
  await db.close()
}
