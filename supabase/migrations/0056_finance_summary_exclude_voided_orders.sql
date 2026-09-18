begin;

create or replace function public.get_finance_summary()
returns table (
  order_revenue numeric,
  income numeric,
  expense numeric,
  order_costs numeric,
  gross_profit numeric,
  cash_balance numeric
)
language sql
security invoker
set search_path = public
stable
as $$
  with legacy_order_summary as (
    select coalesce(sum(amount_cny), 0) as amount
    from public.finance_orders
    where status = 'active'
  ),
  business_order_summary as (
    select coalesce(sum(total_cny), 0) as amount
    from public.business_orders
    where status = 'completed' and voided_at is null
  ),
  transaction_summary as (
    select
      coalesce(sum(amount_cny) filter (where transaction_type = 'income'), 0) as income,
      coalesce(sum(amount_cny) filter (where transaction_type = 'expense'), 0) as expense
    from public.finance_transactions
    where status = 'active'
  ),
  business_transfer_summary as (
    select coalesce(sum(round(a.amount * t.exchange_rate_to_cny, 2)), 0) as income
    from public.business_order_payment_allocations a
    join public.business_customer_transfers t on t.id = a.transfer_id
    join public.business_orders bo on bo.id = a.order_id
    where a.voided_at is null
      and t.voided_at is null
      and bo.voided_at is null
  ),
  legacy_cost_summary as (
    select coalesce(sum(foc.amount_cny), 0) as amount
    from public.finance_order_costs foc
    where foc.finance_order_id is not null
  ),
  business_cost_summary as (
    select coalesce(sum(foc.amount_cny), 0) as amount
    from public.finance_order_costs foc
    join public.business_orders bo on bo.id = foc.business_order_id
    where bo.status = 'completed' and bo.voided_at is null
  ),
  business_wage_summary as (
    select coalesce(sum(bofd.wage_amount_cny), 0) as amount
    from public.business_order_finance_details bofd
    join public.business_orders bo on bo.id = bofd.order_id
    where bo.status = 'completed' and bo.voided_at is null
  )
  select
    lo.amount + bo.amount,
    ts.income + bt.income,
    ts.expense,
    lc.amount + bc.amount + bw.amount,
    (lo.amount + bo.amount) - (lc.amount + bc.amount + bw.amount),
    (ts.income + bt.income) - ts.expense
  from legacy_order_summary lo
  cross join business_order_summary bo
  cross join transaction_summary ts
  cross join business_transfer_summary bt
  cross join legacy_cost_summary lc
  cross join business_cost_summary bc
  cross join business_wage_summary bw;
$$;

revoke all on function public.get_finance_summary()
  from public, anon, authenticated, service_role;
grant execute on function public.get_finance_summary() to authenticated;

commit;
