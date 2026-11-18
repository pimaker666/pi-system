-- 0153: 运营提成（店铺规则 / 订单指定 / 独立结清线）
--
-- 口径：
--   运营提成 = Σ 订单产品行实收 × 运营提点% ÷ 100 × 本单份额% ÷ 100
--   店铺规则是该店铺所有订单的默认运营归属；订单一旦有指定记录，店铺规则即被替代（不叠加）。
--   运营不参与运费提成，基数只取产品实收（与业务提成同口径的分摊后实收）。
--   结清按「订单 × 运营人」粒度，与业务提成（产品行粒度）互不影响。

begin;

-- ---------------------------------------------------------------------------
-- 1. 店铺运营规则（同店铺可多人，按份额分摊）
-- ---------------------------------------------------------------------------
create table if not exists public.finance_shop_operator_rules (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.finance_daily_order_shops(id) on delete cascade,
  operator_id uuid not null references public.profiles(id) on delete cascade,
  share_percent numeric(7, 4) not null default 100,
  product_commission_rate numeric(7, 4) not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_shop_operator_rules_share_valid
    check (share_percent > 0 and share_percent <= 100),
  constraint finance_shop_operator_rules_rate_valid
    check (product_commission_rate >= 0),
  constraint finance_shop_operator_rules_unique unique (shop_id, operator_id)
);

comment on table public.finance_shop_operator_rules is
  '店铺默认运营归属。同店铺多人可合计 100% 分摊，也可每人 100% 各自全额；订单有指定记录时整单不再走店铺规则。';

create index if not exists idx_finance_shop_operator_rules_operator
  on public.finance_shop_operator_rules (operator_id);

-- ---------------------------------------------------------------------------
-- 2. 订单级运营指定（业务指定运营，替代店铺规则）
-- ---------------------------------------------------------------------------
create table if not exists public.finance_business_order_operator_assignments (
  id uuid primary key default gen_random_uuid(),
  business_order_id uuid not null references public.business_orders(id) on delete cascade,
  operator_id uuid not null references public.profiles(id) on delete cascade,
  share_percent numeric(7, 4) not null default 100,
  product_commission_rate numeric(7, 4) not null default 0,
  assigned_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_business_order_operator_assignments_share_valid
    check (share_percent > 0 and share_percent <= 100),
  constraint finance_business_order_operator_assignments_rate_valid
    check (product_commission_rate >= 0),
  constraint finance_business_order_operator_assignments_unique
    unique (business_order_id, operator_id)
);

comment on table public.finance_business_order_operator_assignments is
  '订单级运营指定。存在记录时该订单的运营归属完全由本表决定，店铺规则不参与。';

create index if not exists idx_finance_business_order_operator_assignments_operator
  on public.finance_business_order_operator_assignments (operator_id);

-- ---------------------------------------------------------------------------
-- 3. 运营提成结清（订单 × 运营人）
-- ---------------------------------------------------------------------------
create table if not exists public.finance_business_order_operator_commission_clearances (
  business_order_id uuid not null references public.business_orders(id) on delete cascade,
  operator_id uuid not null references public.profiles(id) on delete cascade,
  period date not null,
  status public.commission_clearance_status not null default 'pending',
  settlement_exchange_rate_to_cny numeric,
  submitted_by uuid references public.profiles(id) on delete set null,
  submitted_at timestamptz not null default now(),
  confirmed_by uuid references public.profiles(id) on delete set null,
  confirmed_at timestamptz null,
  rejected_reason text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_order_id, operator_id),
  constraint finance_business_order_operator_commission_clearances_period_month
    check (period = date_trunc('month', period)::date)
);

comment on table public.finance_business_order_operator_commission_clearances is
  '运营提成结清（订单粒度的运营份额）。period 为结清归属月；美元订单在提交时锁定汇率。';

create index if not exists idx_finance_business_order_operator_commission_clearances_operator
  on public.finance_business_order_operator_commission_clearances (operator_id, period);
create index if not exists idx_finance_business_order_operator_commission_clearances_status
  on public.finance_business_order_operator_commission_clearances (status);

-- ---------------------------------------------------------------------------
-- 4. 份额说明
-- ---------------------------------------------------------------------------
-- 份额按人独立解释，不做合计约束：可以多人合计 100% 分摊一份提成，
-- 也可以每人 100% 各自拿全额。提成一律按 实收 × 提点 × 本人份额 计算。
drop function if exists public.assert_operator_share_total();

drop trigger if exists trg_finance_shop_operator_rules_share_total
  on public.finance_shop_operator_rules;
drop trigger if exists trg_finance_business_order_operator_assignments_share_total
  on public.finance_business_order_operator_assignments;

drop trigger if exists trg_finance_shop_operator_rules_touch
  on public.finance_shop_operator_rules;
create trigger trg_finance_shop_operator_rules_touch
  before update on public.finance_shop_operator_rules
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_finance_business_order_operator_assignments_touch
  on public.finance_business_order_operator_assignments;
create trigger trg_finance_business_order_operator_assignments_touch
  before update on public.finance_business_order_operator_assignments
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_finance_business_order_operator_commission_clearances_touch
  on public.finance_business_order_operator_commission_clearances;
create trigger trg_finance_business_order_operator_commission_clearances_touch
  before update on public.finance_business_order_operator_commission_clearances
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------------
alter table public.finance_shop_operator_rules enable row level security;
alter table public.finance_business_order_operator_assignments enable row level security;
alter table public.finance_business_order_operator_commission_clearances enable row level security;

revoke all on table public.finance_shop_operator_rules
  from public, anon, authenticated, service_role;
revoke all on table public.finance_business_order_operator_assignments
  from public, anon, authenticated, service_role;
revoke all on table public.finance_business_order_operator_commission_clearances
  from public, anon, authenticated, service_role;

grant select, insert, update, delete on table public.finance_shop_operator_rules
  to authenticated, service_role;
grant select, insert, update, delete on table public.finance_business_order_operator_assignments
  to authenticated, service_role;
grant select, insert, update, delete on table public.finance_business_order_operator_commission_clearances
  to authenticated, service_role;

drop policy if exists "finance_shop_operator_rules_select" on public.finance_shop_operator_rules;
-- 店铺规则含各运营的提点与份额，只对财务/管理员和本人可见。
create policy "finance_shop_operator_rules_select"
  on public.finance_shop_operator_rules
  for select to authenticated
  using (public.is_finance_or_admin() or operator_id = (select auth.uid()));

drop policy if exists "finance_shop_operator_rules_write" on public.finance_shop_operator_rules;
create policy "finance_shop_operator_rules_write"
  on public.finance_shop_operator_rules
  for all to authenticated
  using (public.is_finance_or_admin())
  with check (public.is_finance_or_admin());

drop policy if exists "business_order_operator_assignments_select"
  on public.finance_business_order_operator_assignments;
create policy "business_order_operator_assignments_select"
  on public.finance_business_order_operator_assignments
  for select to authenticated
  using (
    public.can_view_business_order(business_order_id)
    or operator_id = (select auth.uid())
  );

drop policy if exists "business_order_operator_assignments_write"
  on public.finance_business_order_operator_assignments;
create policy "business_order_operator_assignments_write"
  on public.finance_business_order_operator_assignments
  for all to authenticated
  using (
    public.is_finance_or_admin()
    or exists (
      select 1 from public.business_orders bo
      where bo.id = business_order_id
        and bo.salesperson_id = (select auth.uid())
        and bo.voided_at is null
    )
  )
  with check (
    public.is_finance_or_admin()
    or exists (
      select 1 from public.business_orders bo
      where bo.id = business_order_id
        and bo.salesperson_id = (select auth.uid())
        and bo.voided_at is null
    )
  );

drop policy if exists "business_order_operator_commission_clearances_select"
  on public.finance_business_order_operator_commission_clearances;
create policy "business_order_operator_commission_clearances_select"
  on public.finance_business_order_operator_commission_clearances
  for select to authenticated
  using (
    public.can_view_business_order(business_order_id)
    or operator_id = (select auth.uid())
  );

drop policy if exists "business_order_operator_commission_clearances_insert"
  on public.finance_business_order_operator_commission_clearances;
create policy "business_order_operator_commission_clearances_insert"
  on public.finance_business_order_operator_commission_clearances
  for insert to authenticated
  with check (public.is_finance_or_admin());

drop policy if exists "business_order_operator_commission_clearances_update"
  on public.finance_business_order_operator_commission_clearances;
create policy "business_order_operator_commission_clearances_update"
  on public.finance_business_order_operator_commission_clearances
  for update to authenticated
  using (
    public.is_finance_or_admin()
    or (operator_id = (select auth.uid()) and status = 'pending')
  )
  -- 确认由本人回填 confirmed_by；驳回不回填，所以只按「本人 + 已离开待确认」收口。
  with check (
    public.is_finance_or_admin()
    or (operator_id = (select auth.uid()) and status in ('confirmed', 'rejected'))
  );

drop policy if exists "business_order_operator_commission_clearances_delete"
  on public.finance_business_order_operator_commission_clearances;
create policy "business_order_operator_commission_clearances_delete"
  on public.finance_business_order_operator_commission_clearances
  for delete to authenticated
  using (public.is_finance_or_admin());

-- ---------------------------------------------------------------------------
-- 6. 订单可见性：运营按「订单指定优先、否则店铺规则」读取归属订单
-- ---------------------------------------------------------------------------
create or replace function public.can_view_business_order(p_order_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.business_orders bo
    join public.profiles me on me.id = (select auth.uid())
    left join public.customers c on c.id = bo.customer_id
    where bo.id = p_order_id
      and me.status::text = 'approved'
      and (
        me.role::text in ('admin', 'finance')
        or bo.salesperson_id = me.id
        or public.is_my_subordinate(bo.salesperson_id)
        or c.created_by = me.id
        or public.is_my_subordinate(c.created_by)
        or exists (
          select 1 from public.finance_business_order_operator_assignments a
          where a.business_order_id = bo.id
            and a.operator_id = me.id
        )
        or (
          not exists (
            select 1 from public.finance_business_order_operator_assignments a
            where a.business_order_id = bo.id
          )
          and exists (
            select 1 from public.finance_shop_operator_rules r
            where r.shop_id = bo.shop_id
              and r.operator_id = me.id
          )
        )
      )
  );
$$;
revoke all on function public.can_view_business_order(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.can_view_business_order(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. 角色修改 RPC 放开 operations
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_user_role(
  p_user_id uuid,
  p_role text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_role text := nullif(btrim(p_role), '');
begin
  if p_user_id is null then raise exception 'User ID is required'; end if;
  if v_role is null or v_role not in ('admin', 'finance', 'sales', 'supervisor', 'operations') then
    raise exception 'Invalid user role';
  end if;
  if p_user_id = (select auth.uid()) then raise exception 'You cannot change your own role'; end if;

  perform pg_advisory_xact_lock(hashtext('account_handover')::bigint);
  perform pg_advisory_xact_lock(hashtext('admin_account_status')::bigint);
  perform pg_advisory_xact_lock(hashtext('profiles_supervisor_hierarchy')::bigint);
  select * into v_actor
  from public.profiles
  where id = (select auth.uid())
  for update;
  if not found or v_actor.status::text <> 'approved' or v_actor.role::text <> 'admin' then
    raise exception 'Only approved administrators can change roles';
  end if;

  select * into v_target from public.profiles where id = p_user_id for update;
  if not found then raise exception 'User does not exist'; end if;
  if v_target.status::text = 'disabled' then
    raise exception 'Disabled accounts must be restored before changing roles';
  end if;
  if v_target.role::text = v_role then return v_target.id; end if;

  if v_target.role::text = 'admin' and v_target.status::text = 'approved'
     and v_role <> 'admin' and not exists (
       select 1 from public.profiles p
       where p.id <> v_target.id
         and p.role::text = 'admin'
         and p.status::text = 'approved'
     ) then
    raise exception 'At least one approved administrator must remain';
  end if;

  perform set_config('app.profile_mutation_rpc', 'role', true);
  if v_target.role::text in ('admin', 'supervisor')
     and v_role not in ('admin', 'supervisor') then
    update public.profiles set supervisor_id = null where supervisor_id = v_target.id;
  end if;

  update public.profiles
  set role = v_role::public.user_role,
      supervisor_id = case
        when v_role in ('admin', 'supervisor', 'sales') then supervisor_id
        else null
      end
  where id = v_target.id;
  return v_target.id;
end;
$$;
revoke all on function public.admin_set_user_role(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_set_user_role(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. 运营角色权限模板
--    没有模板行时 has_current_permission 一律返回 false，运营会连只读权限都拿不到。
--    默认只读本人归属订单，不参与建单/编辑/发货/财务敏感字段。
-- ---------------------------------------------------------------------------
insert into public.permission_templates (
  system_role, name, description, permissions, data_scope, sensitive_fields
) values (
  'operations', '运营', '查看归属本人或本店铺的订单及运营提成。',
  '{"orders":{"view":true,"create":false,"edit":false,"void":false,"approve":false,"ship":false,"export":false,"record_transfer":false},"finance":{"view":false,"financial_number":false,"cost":false,"profit":false,"exchange_rate":false},"products":{"view":true,"edit":false},"customers":{"view":true,"edit":false},"pi":{"view":false,"create":false,"edit":false,"void":false},"system":{"manage_users":false,"manage_permissions":false,"view_audit":false}}'::jsonb,
  'self',
  '{"financial_number":false,"product_name":true,"cost":false,"profit":false,"exchange_rate":false}'::jsonb
)
on conflict (system_role) do nothing;

commit;
