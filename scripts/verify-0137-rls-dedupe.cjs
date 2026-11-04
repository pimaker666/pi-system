const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')

const FINANCE = '10000000-0000-4000-8000-000000000001'
const SALES = '10000000-0000-4000-8000-000000000002'
const OTHER = '10000000-0000-4000-8000-000000000003'
const ORDER_1 = '30000000-0000-4000-8000-000000000001'
const ORDER_2 = '30000000-0000-4000-8000-000000000002'
const ORDER_3 = '30000000-0000-4000-8000-000000000003'
const ITEM_1 = '20000000-0000-4000-8000-000000000001'
const ITEM_2 = '20000000-0000-4000-8000-000000000002'
const ITEM_3 = '20000000-0000-4000-8000-000000000003'

async function main() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;

    create table public.profiles (id uuid primary key, role text not null, status text not null);
    insert into profiles values
      ('${FINANCE}', 'finance', 'approved'),
      ('${SALES}', 'sales', 'approved'),
      ('${OTHER}', 'sales', 'approved');

    create function public.is_finance_or_admin() returns boolean language sql security definer as $$
      select exists(select 1 from profiles where id = auth.uid() and role in ('admin', 'finance') and status = 'approved') $$;
    grant usage on schema public to authenticated, anon;
    grant execute on function public.is_finance_or_admin() to authenticated, anon;

    -- 用探针表统计 can_view_business_order 被调用的次数
    create table public.rls_probe (fn text not null);
    grant insert, select, truncate on public.rls_probe to authenticated;

    create table public.business_orders (
      id uuid primary key,
      salesperson_id uuid not null references public.profiles(id)
    );
    insert into business_orders values
      ('${ORDER_1}', '${SALES}'),
      ('${ORDER_2}', '${SALES}'),
      ('${ORDER_3}', '${OTHER}');

    create table public.business_order_items (
      id uuid primary key,
      order_id uuid not null references public.business_orders(id)
    );
    insert into business_order_items values
      ('${ITEM_1}', '${ORDER_1}'),
      ('${ITEM_2}', '${ORDER_2}'),
      ('${ITEM_3}', '${ORDER_3}');

    create or replace function public.can_view_business_order(p_order_id uuid)
    returns boolean language plpgsql security definer as $$
    begin
      insert into public.rls_probe(fn) values ('can_view');
      return exists (
        select 1 from public.business_orders o
        where o.id = p_order_id
          and (public.is_finance_or_admin() or o.salesperson_id = auth.uid())
      );
    end;
    $$;
    grant execute on function public.can_view_business_order(uuid) to authenticated, anon;

    alter table public.business_orders enable row level security;
    alter table public.business_order_items enable row level security;
    grant select on public.business_orders, public.business_order_items to authenticated;
    create policy orders_select on public.business_orders
      for select to authenticated using (public.can_view_business_order(id));
    create policy items_select on public.business_order_items
      for select to authenticated using (public.can_view_business_order(order_id));

    create table public.finance_business_order_item_commissions (
      business_order_item_id uuid primary key references public.business_order_items(id),
      commission_rate numeric not null default 0
    );
    insert into finance_business_order_item_commissions values
      ('${ITEM_1}', 5), ('${ITEM_2}', 5), ('${ITEM_3}', 5);

    create table public.finance_business_order_item_commission_clearances (
      business_order_item_id uuid primary key references public.business_order_items(id),
      status text not null default 'pending'
    );
    insert into finance_business_order_item_commission_clearances values
      ('${ITEM_1}', 'pending'), ('${ITEM_2}', 'pending'), ('${ITEM_3}', 'pending');

    alter table public.finance_business_order_item_commissions enable row level security;
    alter table public.finance_business_order_item_commission_clearances enable row level security;
    grant select on public.finance_business_order_item_commissions,
                    public.finance_business_order_item_commission_clearances to authenticated;

    create policy business_order_item_commissions_select
      on public.finance_business_order_item_commissions for select to authenticated
      using (
        exists (
          select 1 from public.business_order_items as items
          where items.id = business_order_item_id
            and public.can_view_business_order(items.order_id)
        )
      );
    create policy business_order_item_commission_clearances_select
      on public.finance_business_order_item_commission_clearances for select to authenticated
      using (
        exists (
          select 1 from public.business_order_items as items
          where items.id = business_order_item_id
            and public.can_view_business_order(items.order_id)
        )
      );
  `)

  const as = async (uid, fn) => {
    if (uid) {
      await db.exec(`set role authenticated; set request.jwt.claim.sub = '${uid}';`)
    } else {
      await db.exec(`reset role; reset request.jwt.claim.sub;`)
    }
    try {
      return await fn()
    } finally {
      await db.exec('reset role; reset request.jwt.claim.sub;')
    }
  }

  const probeCount = async () =>
    Number((await db.query(`select count(*)::int c from public.rls_probe`)).rows[0].c)
  const resetProbe = () => db.exec('truncate public.rls_probe')

  // ---------- 1. 旧策略：每条记录对 can_view_business_order 求值两次 ----------
  await resetProbe()
  const beforeCommissions = await as(SALES, async () => {
    const visible = Number(
      (await db.query(`select count(*)::int c from public.finance_business_order_item_commissions`))
        .rows[0].c,
    )
    return { visible, calls: await probeCount() }
  })
  assert.equal(beforeCommissions.visible, 2, '业务员只能看到本人订单的提点记录')
  // 可见行：明细子查询 1 次 + 显式判断 1 次；不可见行在子查询处即被过滤，只算 1 次。
  assert.equal(beforeCommissions.calls, 5, '旧策略可见行每条求值两次（2×2 + 1 = 5 次）')

  // ---------- 2. 应用 0137：每条记录只求值一次 ----------
  const migration = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/0137_rls_dedupe_commission_item_visibility.sql'),
    'utf8',
  )
  await db.exec(migration)
  // 幂等：再跑一遍不报错
  await db.exec(migration)

  await resetProbe()
  const afterCommissions = await as(SALES, async () => {
    const visible = Number(
      (await db.query(`select count(*)::int c from public.finance_business_order_item_commissions`))
        .rows[0].c,
    )
    return { visible, calls: await probeCount() }
  })
  assert.equal(afterCommissions.visible, 2, '提点可见范围保持不变')
  assert.equal(afterCommissions.calls, 3, '新策略每条记录只调用一次可见性（3 条 = 3 次）')

  await resetProbe()
  const afterClearances = await as(SALES, async () => {
    const visible = Number(
      (
        await db.query(
          `select count(*)::int c from public.finance_business_order_item_commission_clearances`,
        )
      ).rows[0].c,
    )
    return { visible, calls: await probeCount() }
  })
  assert.equal(afterClearances.visible, 2, '结清可见范围保持不变')
  assert.equal(afterClearances.calls, 3, '结清策略同样每条只求值一次')

  // ---------- 3. 财务仍可见全部 ----------
  const financeVisible = await as(FINANCE, async () => ({
    commissions: Number(
      (await db.query(`select count(*)::int c from public.finance_business_order_item_commissions`))
        .rows[0].c,
    ),
    clearances: Number(
      (
        await db.query(
          `select count(*)::int c from public.finance_business_order_item_commission_clearances`,
        )
      ).rows[0].c,
    ),
  }))
  assert.deepEqual(financeVisible, { commissions: 3, clearances: 3 }, '财务可见全部记录')

  // ---------- 4. 未登录角色不能直接调用帮助函数 ----------
  await assert.rejects(
    () => db.exec(`grant usage on schema public to anon; set role anon; select public.can_view_business_order_item('${ITEM_1}')`),
    /permission denied/i,
    'anon 不可执行帮助函数',
  )
  await db.exec('reset role')

  console.log('✓ 0137 提点/结清 RLS 可见性去重复求值演练通过')
}

main().catch((error) => {
  console.error('✗ 0137 演练失败：', error.message)
  process.exit(1)
})
