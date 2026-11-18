-- 0154: 提成规则表（业务 / 运营两条独立优先级线）
--
-- 口径：
--   * 每条规则 = 若干命中条件（全部满足才算命中）+ 产品提点；逗号见 conditions 列。
--   * 同一 line 内按 priority 升序逐条匹配，第一条命中即采用；都不命中提点为 0。
--   * 业务与运营各自独立排序：business 规则不影响 operator 规则，反之亦然。
--   * 业务行级手填提点仍高于所有规则（不受排序影响）。
--   * 运营线规则只支持订单级条件；发货分类条件由 0155 以「订单含该类产品行」放开。
--   * 旧表（客户标记 / 定制订单数档位 / 发货分类提点）的提点值在此播种为 legacy 规则；
--     旧设置入口继续可用，但读写的是规则表，避免两套真相。

begin;

-- ---------------------------------------------------------------------------
-- 1. 规则表
-- ---------------------------------------------------------------------------
create table if not exists public.finance_commission_rules (
  id uuid primary key default gen_random_uuid(),
  line text not null check (line in ('business', 'operator')),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  enabled boolean not null default true,
  priority integer not null default 100,
  tag_color text,
  shipping_category text,
  custom_order_count_max integer,
  order_index_max integer,
  tenure_months_max integer,
  product_commission_rate numeric(7, 4) not null,
  legacy_source text,
  legacy_key text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_commission_rules_rate_valid check (product_commission_rate >= 0),
  constraint finance_commission_rules_custom_count_valid
    check (custom_order_count_max is null or custom_order_count_max >= 0),
  constraint finance_commission_rules_order_index_valid
    check (order_index_max is null or order_index_max > 0),
  constraint finance_commission_rules_tenure_valid
    check (tenure_months_max is null or tenure_months_max >= 0),
  constraint finance_commission_rules_legacy_source_valid
    check (legacy_source is null or legacy_source in ('tag', 'category', 'custom_tier')),
  constraint finance_commission_rules_legacy_key_valid
    check ((legacy_source is null) = (legacy_key is null)),
  constraint finance_commission_rules_line_scope_valid
    check (
      line = 'business'
      or (shipping_category is null and custom_order_count_max is null)
    )
);

comment on table public.finance_commission_rules is
  '提成规则。line=business/operator 各自独立按 priority 升序匹配；全部条件为空即兜底规则。旧来源通过 legacy_source+legacy_key 同步。';

create index if not exists idx_finance_commission_rules_line_priority
  on public.finance_commission_rules (line, priority);

-- 旧来源同步键：普通唯一索引即可（NULLS DISTINCT 不会拦住手工新建的无来源规则）。
create unique index if not exists uq_finance_commission_rules_legacy
  on public.finance_commission_rules (line, legacy_source, legacy_key);

drop trigger if exists trg_finance_commission_rules_touch
  on public.finance_commission_rules;
create trigger trg_finance_commission_rules_touch
  before update on public.finance_commission_rules
  for each row execute function public.touch_updated_at();

alter table public.finance_commission_rules enable row level security;
revoke all on table public.finance_commission_rules
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.finance_commission_rules
  to authenticated, service_role;

drop policy if exists "finance_commission_rules_select" on public.finance_commission_rules;
create policy "finance_commission_rules_select"
  on public.finance_commission_rules
  for select to authenticated
  using (public.is_approved_user());

drop policy if exists "finance_commission_rules_write" on public.finance_commission_rules;
create policy "finance_commission_rules_write"
  on public.finance_commission_rules
  for all to authenticated
  using (public.is_finance_or_admin())
  with check (public.is_finance_or_admin());

-- ---------------------------------------------------------------------------
-- 2. 旧来源播种（保持现有行为：客户标记 > 定制订单数档位 > 发货分类）
-- ---------------------------------------------------------------------------
insert into public.finance_commission_rules
  (line, name, priority, tag_color, product_commission_rate, legacy_source, legacy_key)
select
  'business',
  t.label,
  100 + coalesce(t.sort_order, 0),
  lower(t.tag_color),
  t.product_commission_rate,
  'tag',
  lower(t.tag_color)
from public.finance_customer_commission_tags t
on conflict (line, legacy_source, legacy_key) do nothing;

insert into public.finance_commission_rules
  (line, name, priority, shipping_category, custom_order_count_max,
   product_commission_rate, legacy_source, legacy_key)
select
  'business',
  '定制订单 ≤ ' || r.maximum_custom_order_count || ' 单',
  200 + row_number() over (order by r.maximum_custom_order_count),
  'custom',
  r.maximum_custom_order_count,
  r.product_commission_rate,
  'custom_tier',
  r.maximum_custom_order_count::text
from public.finance_customer_custom_order_commission_rates r
on conflict (line, legacy_source, legacy_key) do nothing;

insert into public.finance_commission_rules
  (line, name, priority, shipping_category, product_commission_rate, legacy_source, legacy_key)
select
  'business',
  r.category::text,
  300,
  r.category::text,
  r.product_commission_rate,
  'category',
  r.category::text
from public.finance_commission_category_rates r
on conflict (line, legacy_source, legacy_key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. 运营规则/指定：提点来源可切换（默认固定点数，保持现状）
-- ---------------------------------------------------------------------------
alter table public.finance_shop_operator_rules
  add column if not exists rate_mode text not null default 'fixed';
alter table public.finance_shop_operator_rules
  drop constraint if exists finance_shop_operator_rules_rate_mode_valid;
alter table public.finance_shop_operator_rules
  add constraint finance_shop_operator_rules_rate_mode_valid
  check (rate_mode in ('fixed', 'rules'));

alter table public.finance_business_order_operator_assignments
  add column if not exists rate_mode text not null default 'fixed';
alter table public.finance_business_order_operator_assignments
  drop constraint if exists finance_business_order_operator_assignments_rate_mode_valid;
alter table public.finance_business_order_operator_assignments
  add constraint finance_business_order_operator_assignments_rate_mode_valid
  check (rate_mode in ('fixed', 'rules'));

-- ---------------------------------------------------------------------------
-- 4. 订单时点上下文：客户第 N 单（仅成交单）与客户年限（月）
-- ---------------------------------------------------------------------------
create or replace function public.get_business_order_commission_context(p_order_ids uuid[])
returns table (
  order_id uuid,
  customer_order_index integer,
  tenure_months integer
)
language sql
stable
security definer
set search_path = public
as $$
  with target as (
    select bo.id, bo.customer_id, bo.order_date
    from public.business_orders bo
    where bo.id = any(p_order_ids)
  ),
  valid as (
    select o.id, o.customer_id, o.order_date, o.created_at
    from public.business_orders o
    where o.voided_at is null
      and o.status in ('approved', 'completed')
      and o.customer_id in (select customer_id from target where customer_id is not null)
  ),
  deal as (
    select v.id, v.customer_id, v.order_date, v.created_at
    from valid v
    where exists (
      select 1
      from public.business_order_items i
      where i.order_id = v.id
        and coalesce(i.daily_shipping_category::text, '') not in ('sample', 'custom_sample')
    )
  ),
  ranked as (
    select
      d.id,
      row_number() over (
        partition by d.customer_id
        order by d.order_date, d.created_at, d.id
      ) as order_index
    from deal d
  ),
  firsts as (
    select d.customer_id, min(d.order_date) as first_order_date
    from deal d
    group by d.customer_id
  )
  select
    t.id as order_id,
    r.order_index::integer as customer_order_index,
    case
      when f.first_order_date is null then null
      else (
        extract(year from age(t.order_date, f.first_order_date)) * 12
        + extract(month from age(t.order_date, f.first_order_date))
      )::integer
    end as tenure_months
  from target t
  left join ranked r on r.id = t.id
  left join firsts f on f.customer_id = t.customer_id
$$;

revoke all on function public.get_business_order_commission_context(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.get_business_order_commission_context(uuid[])
  to authenticated;

commit;
