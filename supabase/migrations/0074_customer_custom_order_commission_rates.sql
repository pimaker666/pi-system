-- 0074 客户定制订单数提点与实时客户标记读取
-- 产品提点优先级：手动逐行覆盖 > 客户标记 > 定制订单数 > 发货分类默认 > 0。

begin;

create table if not exists public.finance_customer_custom_order_commission_rates (
  minimum_custom_order_count integer primary key
    constraint finance_customer_custom_order_commission_rates_minimum_check
      check (minimum_custom_order_count >= 0 and minimum_custom_order_count <= 1000000),
  product_commission_rate numeric(7, 4) not null default 0
    constraint finance_customer_custom_order_commission_rates_rate_check
      check (product_commission_rate >= 0 and product_commission_rate <= 100),
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.finance_customer_custom_order_commission_rates is
  '按客户累计定制订单数设置的产品提点；取不超过当前订单数的最高门槛。优先级低于客户标记，高于发货分类默认。';

drop trigger if exists trg_finance_customer_custom_order_commission_rates_touch
  on public.finance_customer_custom_order_commission_rates;
create trigger trg_finance_customer_custom_order_commission_rates_touch
  before update on public.finance_customer_custom_order_commission_rates
  for each row execute function public.touch_updated_at();

alter table public.finance_customer_custom_order_commission_rates enable row level security;

revoke all on table public.finance_customer_custom_order_commission_rates
  from public, anon, authenticated, service_role;
grant select, insert, update, delete
  on table public.finance_customer_custom_order_commission_rates to authenticated, service_role;

drop policy if exists "customer_custom_order_commission_rates_select"
  on public.finance_customer_custom_order_commission_rates;
create policy "customer_custom_order_commission_rates_select"
  on public.finance_customer_custom_order_commission_rates
  for select to authenticated
  using (public.is_approved_user());

drop policy if exists "customer_custom_order_commission_rates_insert"
  on public.finance_customer_custom_order_commission_rates;
create policy "customer_custom_order_commission_rates_insert"
  on public.finance_customer_custom_order_commission_rates
  for insert to authenticated
  with check (public.is_finance_or_admin() and updated_by = (select auth.uid()));

drop policy if exists "customer_custom_order_commission_rates_update"
  on public.finance_customer_custom_order_commission_rates;
create policy "customer_custom_order_commission_rates_update"
  on public.finance_customer_custom_order_commission_rates
  for update to authenticated
  using (public.is_finance_or_admin())
  with check (public.is_finance_or_admin() and updated_by = (select auth.uid()));

drop policy if exists "customer_custom_order_commission_rates_delete"
  on public.finance_customer_custom_order_commission_rates;
create policy "customer_custom_order_commission_rates_delete"
  on public.finance_customer_custom_order_commission_rates
  for delete to authenticated
  using (public.is_finance_or_admin());

create or replace function public.get_business_order_customer_tag_colors(p_order_ids uuid[])
returns table (order_id uuid, tag_color text)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, c.tag_color
  from public.business_orders o
  join public.customers c on c.id = o.customer_id
  where o.id = any(p_order_ids)
    and public.can_view_business_order(o.id)
$$;

revoke all on function public.get_business_order_customer_tag_colors(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.get_business_order_customer_tag_colors(uuid[]) to authenticated;

commit;
