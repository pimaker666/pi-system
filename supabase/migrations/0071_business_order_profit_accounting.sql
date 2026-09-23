-- 0071 业务订单利润核算

begin;

create table if not exists public.finance_business_order_profit_fees (
  business_order_id uuid primary key references public.business_orders(id) on delete cascade,
  fee_amount numeric(18, 4) not null default 0 check (fee_amount >= 0),
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.finance_business_order_profit_fees is
  '业务订单利润核算的订单级手续费，金额与订单币种一致。';

drop trigger if exists trg_finance_business_order_profit_fees_touch
  on public.finance_business_order_profit_fees;
create trigger trg_finance_business_order_profit_fees_touch
  before update on public.finance_business_order_profit_fees
  for each row execute function public.touch_updated_at();

alter table public.finance_business_order_profit_fees enable row level security;
revoke all on table public.finance_business_order_profit_fees from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.finance_business_order_profit_fees to authenticated, service_role;

drop policy if exists "business_order_profit_fees_select"
  on public.finance_business_order_profit_fees;
create policy "business_order_profit_fees_select"
  on public.finance_business_order_profit_fees for select to authenticated
  using (public.is_finance_or_admin());
drop policy if exists "business_order_profit_fees_insert"
  on public.finance_business_order_profit_fees;
create policy "business_order_profit_fees_insert"
  on public.finance_business_order_profit_fees for insert to authenticated
  with check (public.is_finance_or_admin() and updated_by = (select auth.uid()));
drop policy if exists "business_order_profit_fees_update"
  on public.finance_business_order_profit_fees;
create policy "business_order_profit_fees_update"
  on public.finance_business_order_profit_fees for update to authenticated
  using (public.is_finance_or_admin())
  with check (public.is_finance_or_admin() and updated_by = (select auth.uid()));
drop policy if exists "business_order_profit_fees_delete"
  on public.finance_business_order_profit_fees;
create policy "business_order_profit_fees_delete"
  on public.finance_business_order_profit_fees for delete to authenticated
  using (public.is_finance_or_admin());

create or replace function public.get_business_order_profit_rows(
  p_period date default null,
  p_salesperson_ids uuid[] default null,
  p_shop_ids uuid[] default null
)
returns table (
  order_id uuid,
  profit_period date,
  order_date date,
  order_number text,
  external_order_number text,
  shop_name text,
  salesperson_name text,
  currency public.currency_code,
  received_amount numeric,
  product_cost numeric,
  freight_cost numeric,
  commission_amount numeric,
  fee_amount numeric,
  profit_amount numeric
)
language sql
security definer
set search_path = public
stable
as $$
  with eligible_orders as (
    select bo.id,
           greatest(max(s.period), max(c.period)) as profit_period
    from public.business_orders bo
    join public.business_order_items i on i.order_id = bo.id
    join public.finance_business_order_item_settlements s
      on s.business_order_item_id = i.id
    join public.finance_business_order_item_commission_clearances c
      on c.business_order_item_id = i.id and c.status = 'confirmed'
    where bo.voided_at is null
      and public.is_finance_or_admin()
      and (p_salesperson_ids is null or array_length(p_salesperson_ids, 1) is null
        or bo.salesperson_id = any (p_salesperson_ids))
      and (p_shop_ids is null or array_length(p_shop_ids, 1) is null
        or bo.shop_id = any (p_shop_ids))
    group by bo.id
    having count(*) = (select count(*) from public.business_order_items all_items where all_items.order_id = bo.id)
  ), allocations as (
    select a.order_id,
      coalesce(sum(a.amount) filter (where a.voided_at is null and t.voided_at is null), 0) as received_allocations,
      coalesce(sum(a.amount) filter (where a.voided_at is null and t.voided_at is null and a.allocation_target = 'shipping'), 0) as shipping_allocations
    from public.business_order_payment_allocations a
    join eligible_orders eo on eo.id = a.order_id
    left join public.business_customer_transfers t on t.id = a.transfer_id
    group by a.order_id
  ), product_totals as (
    select i.order_id,
      coalesce(sum(s.unit_cost * s.quantity), 0) as product_cost,
      coalesce(sum(coalesce(i.product_received_amount, 0) * coalesce(ic.commission_rate, tag.product_commission_rate, cr.product_commission_rate, 0) / 100), 0) as product_commission
    from public.business_order_items i
    join public.finance_business_order_item_settlements s on s.business_order_item_id = i.id
    join eligible_orders eo on eo.id = i.order_id
    left join public.finance_business_order_item_commissions ic on ic.business_order_item_id = i.id
    left join public.business_orders bo on bo.id = i.order_id
    left join public.customers customer on customer.id = bo.customer_id
    left join public.finance_customer_commission_tags tag on lower(tag.tag_color) = lower(customer.tag_color)
    left join public.finance_commission_category_rates cr on cr.category = i.daily_shipping_category
    group by i.order_id
  )
  select bo.id, eo.profit_period, bo.order_date, bo.order_number, bo.external_order_number,
    bo.shop_name_snapshot, coalesce(nullif(bo.salesperson_display_name_snapshot, ''), bo.salesperson_name_snapshot, ''),
    bo.currency,
    coalesce(bo.total_sales_amount, 0) + coalesce(a.received_allocations, 0),
    pt.product_cost,
    coalesce(fc.freight_cost, 0),
    pt.product_commission + ((coalesce(bo.total_shipping_received_amount, 0) + coalesce(a.shipping_allocations, 0) - coalesce(fc.freight_cost, 0)) * coalesce(fc.freight_commission_rate, 0) / 100),
    coalesce(fee.fee_amount, 0),
    (coalesce(bo.total_sales_amount, 0) + coalesce(a.received_allocations, 0))
      - pt.product_cost - coalesce(fc.freight_cost, 0)
      - pt.product_commission
      - ((coalesce(bo.total_shipping_received_amount, 0) + coalesce(a.shipping_allocations, 0) - coalesce(fc.freight_cost, 0)) * coalesce(fc.freight_commission_rate, 0) / 100)
      - coalesce(fee.fee_amount, 0)
  from eligible_orders eo
  join public.business_orders bo on bo.id = eo.id
  join product_totals pt on pt.order_id = bo.id
  left join allocations a on a.order_id = bo.id
  left join public.finance_business_order_commissions fc on fc.business_order_id = bo.id
  left join public.finance_business_order_profit_fees fee on fee.business_order_id = bo.id
  where p_period is null or eo.profit_period = p_period
  order by eo.profit_period desc, bo.order_date desc, bo.id desc;
$$;

revoke all on function public.get_business_order_profit_rows(date, uuid[], uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.get_business_order_profit_rows(date, uuid[], uuid[]) to authenticated, service_role;

commit;
