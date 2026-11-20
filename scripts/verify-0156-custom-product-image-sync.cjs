const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')

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

const SALES_ID = '11111111-1111-4111-8111-111111111111'
const PENDING_ID = '22222222-2222-4222-8222-222222222222'
const GROUP_ID = '33333333-3333-4333-8333-333333333333'
const CP1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CP2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CP3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const V1 = 'a1111111-1111-4111-8111-111111111111'
const V2 = 'a2222222-2222-4222-8222-222222222222'
const V2B = 'b1111111-1111-4111-8111-111111111111'
const O_LIVE = 'd1111111-1111-4111-8111-111111111111'
const O_COMPLETED = 'd2222222-2222-4222-8222-222222222222'
const O_VOIDED = 'd3333333-3333-4333-8333-333333333333'
const O_CLOSED = 'd4444444-4444-4444-8444-444444444444'
const I1 = 'e1111111-1111-4111-8111-111111111111'
const I2 = 'e2222222-2222-4222-8222-222222222222'
const I3 = 'e3333333-3333-4333-8333-333333333333'
const I4 = 'e4444444-4444-4444-8444-444444444444'
const I5 = 'e5555555-5555-4555-8555-555555555555'

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

    create type public.currency_code as enum ('USD', 'CNY');

    create table public.profiles (
      id uuid primary key,
      role text not null default 'sales',
      status text not null default 'approved'
    );
    create table public.product_groups (
      id uuid primary key
    );
    create table public.business_custom_products (
      id uuid primary key,
      is_archived boolean not null default false,
      updated_by uuid
    );
    create table public.business_custom_product_versions (
      id uuid primary key default gen_random_uuid(),
      custom_product_id uuid not null references public.business_custom_products(id) on delete cascade,
      version_no integer not null,
      product_group_id uuid references public.product_groups(id),
      code text,
      name text not null,
      description text,
      specification text,
      unit text,
      image_url text,
      default_unit_price numeric(18, 4) not null default 0,
      default_currency public.currency_code not null default 'USD',
      quantity numeric(18, 4) not null default 1,
      received_amount numeric(18, 4),
      created_by uuid,
      unique (custom_product_id, version_no)
    );
    create table public.business_orders (
      id uuid primary key,
      status text not null default 'approved',
      voided_at timestamptz,
      closed_at timestamptz
    );
    create table public.business_order_items (
      id uuid primary key default gen_random_uuid(),
      order_id uuid not null references public.business_orders(id) on delete cascade,
      custom_product_id uuid references public.business_custom_products(id),
      name_snapshot text,
      image_url_snapshot text
    );

    create function public.write_business_lifecycle_audit(
      p_order_id uuid, p_customer_id uuid, p_entity_type text, p_entity_id uuid,
      p_action text, p_old_data jsonb, p_new_data jsonb, p_reason text, p_actor_id uuid
    ) returns void language sql as $$ select $$;
  `)

  await db.exec(`
    insert into public.profiles (id, role, status) values
      ('${SALES_ID}', 'sales', 'approved'),
      ('${PENDING_ID}', 'sales', 'pending');
    insert into public.product_groups (id) values ('${GROUP_ID}');
    insert into public.business_custom_products (id, is_archived) values
      ('${CP1}', false),
      ('${CP2}', false),
      ('${CP3}', true);
    insert into public.business_custom_product_versions
      (id, custom_product_id, version_no, product_group_id, name, unit, image_url, default_unit_price, default_currency, quantity)
    values
      ('${V1}', '${CP1}', 1, '${GROUP_ID}', '精华液', '瓶', 'img-v1.png', 10, 'USD', 100),
      ('${V2}', '${CP1}', 2, '${GROUP_ID}', '精华液', '瓶', 'img-v2.png', 10, 'USD', 100),
      ('${V2B}', '${CP2}', 1, '${GROUP_ID}', '面霜', '瓶', 'img2-v1.png', 10, 'USD', 100);
    insert into public.business_orders (id, status, voided_at, closed_at) values
      ('${O_LIVE}', 'approved', null, null),
      ('${O_COMPLETED}', 'completed', null, null),
      ('${O_VOIDED}', 'approved', now(), null),
      ('${O_CLOSED}', 'approved', null, now());
    insert into public.business_order_items
      (id, order_id, custom_product_id, name_snapshot, image_url_snapshot) values
      ('${I1}', '${O_LIVE}', '${CP1}', '旧名', 'img-v1.png'),
      ('${I2}', '${O_LIVE}', '${CP2}', '面霜', 'img2-v1.png'),
      ('${I3}', '${O_COMPLETED}', '${CP1}', '旧名', 'img-completed.png'),
      ('${I4}', '${O_VOIDED}', '${CP1}', '旧名', 'img-voided.png'),
      ('${I5}', '${O_CLOSED}', '${CP1}', '旧名', 'img-closed.png');
  `)

  const m0156 = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/0156_custom_product_image_sync.sql'),
    'utf8',
  )
  await db.exec(m0156)

  async function item(id) {
    const result = await db.query(
      `select name_snapshot, image_url_snapshot from public.business_order_items where id = '${id}'`,
    )
    return result.rows[0]
  }

  // ---- 1. 迁移回填：进行中订单对齐最新版本图片 --------------------------
  assert.equal((await item(I1)).image_url_snapshot, 'img-v2.png', 'live item backfilled to latest image')
  assert.equal((await item(I1)).name_snapshot, '旧名', 'backfill does not touch name')
  assert.equal((await item(I2)).image_url_snapshot, 'img2-v1.png', 'unrelated product untouched')
  assert.equal((await item(I3)).image_url_snapshot, 'img-completed.png', 'completed order keeps image')
  assert.equal((await item(I4)).image_url_snapshot, 'img-voided.png', 'voided order keeps image')
  assert.equal((await item(I5)).image_url_snapshot, 'img-closed.png', 'closed order keeps image')

  // ---- 2. 新增版本同步名称与图片到进行中订单 -----------------------------
  await db.exec(`select set_config('request.jwt.claim.sub', '${SALES_ID}', false);`)
  await db.exec(`select public.add_business_custom_product_version(
    '${CP1}', '${GROUP_ID}', 'SKU-1', '新版精华液', '', '', '瓶', 'img-v3.png', 10, 'USD', 100, null
  );`)
  assert.deepEqual(
    { ...(await item(I1)) },
    { name_snapshot: '新版精华液', image_url_snapshot: 'img-v3.png' },
    'new version syncs name and image to live order',
  )
  assert.equal((await item(I3)).image_url_snapshot, 'img-completed.png', 'completed order still untouched')

  // ---- 3. 新版本不带图片时不清空订单图片 ---------------------------------
  await db.exec(`select public.add_business_custom_product_version(
    '${CP1}', '${GROUP_ID}', 'SKU-1', '三版精华液', '', '', '瓶', '', 10, 'USD', 100, null
  );`)
  assert.deepEqual(
    { ...(await item(I1)) },
    { name_snapshot: '三版精华液', image_url_snapshot: 'img-v3.png' },
    'empty image keeps existing row image while syncing name',
  )

  // ---- 4. 归档产品拒绝新增版本 -------------------------------------------
  await expectError(
    () =>
      db.exec(`select public.add_business_custom_product_version(
        '${CP3}', '${GROUP_ID}', '', '归档产品', '', '', '', null, 10, 'USD', 1, null
      );`),
    /Archived custom product cannot receive a new version/,
  )

  // ---- 5. 未审批账号拒绝新增版本 -----------------------------------------
  await db.exec(`select set_config('request.jwt.claim.sub', '${PENDING_ID}', false);`)
  await expectError(
    () =>
      db.exec(`select public.add_business_custom_product_version(
        '${CP2}', '${GROUP_ID}', '', '面霜', '', '', '瓶', null, 10, 'USD', 1, null
      );`),
    /Approved business role required/,
  )

  // ---- 6. 迁移可重复执行 --------------------------------------------------
  await db.exec(`select set_config('request.jwt.claim.sub', '${SALES_ID}', false);`)
  await db.exec(m0156)
  assert.equal((await item(I1)).image_url_snapshot, 'img-v3.png', 'rerun keeps live image')
  assert.equal((await item(I3)).image_url_snapshot, 'img-completed.png', 'rerun keeps archived image')

  console.log('✓ 0156 定制产品图片同步演练通过')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
