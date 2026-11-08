-- 0144_finance_overview_range.sql
-- 财务总览改为区间口径，并补齐「已完成 / 进行中」与现金趋势所需的数据。
-- 1) get_finance_overview(p_from, p_to)：按订单日期/记账日期/到账日期过滤；
--    订单业绩与毛利只计已完成订单，现金收支来自财务日记账与客户转账。
-- 2) get_finance_cash_trend(p_months)：按自然月返回最近 N 个月的收入/支出，
--    收入含客户转账折合人民币，支出为日记账支出。
-- 3) 进行中金额按原币分币种返回（jsonb），缺汇率时仍可展示，不强行折人民币。

begin;

create or replace function public.get_finance_overview(
  p_from date default null,
  p_to date default null
)
returns table (
  order_revenue numeric,
  income numeric,
  expense numeric,
  order_costs numeric,
  gross_profit numeric,
  cash_balance numeric,
  completed_order_count integer,
  in_progress_order_count integer,
  in_progress_totals jsonb,
  unpriced_completed_order_count integer
)
language sql
stable
set search_path to 'public'
as $function$
  with legacy_order_summary as (
    select coalesce(sum(amount_cny), 0) as amount
    from public.finance_orders
    where status = 'active'
      and (p_from is null or order_date >= p_from)
      and (p_to is null or order_date <= p_to)
  ),
  business_order_summary as (
    select
      coalesce(sum(total_cny), 0) as amount,
      count(*) as completed_count,
      count(*) filter (where total_cny is null) as unpriced_count
    from public.business_orders
    where status = 'completed'
      and voided_at is null
      and (p_from is null or order_date >= p_from)
      and (p_to is null or order_date <= p_to)
  ),
  business_in_progress as (
    select
      count(*) as in_progress_count
    from public.business_orders
    where status in ('submitted', 'approved')
      and voided_at is null
      and (p_from is null or order_date >= p_from)
      and (p_to is null or order_date <= p_to)
  ),
  business_in_progress_totals as (
    select coalesce(
      jsonb_object_agg(grouped.currency::text, grouped.amount),
      '{}'::jsonb
    ) as totals
    from (
      select currency, sum(total_amount) as amount
      from public.business_orders
      where status in ('submitted', 'approved')
        and voided_at is null
        and total_amount > 0
        and (p_from is null or order_date >= p_from)
        and (p_to is null or order_date <= p_to)
      group by currency
    ) grouped
  ),
  transaction_summary as (
    select
      coalesce(sum(amount_cny) filter (where transaction_type = 'income'), 0) as income,
      coalesce(sum(amount_cny) filter (where transaction_type = 'expense'), 0) as expense
    from public.finance_transactions
    where status = 'active'
      and (p_from is null or transaction_date >= p_from)
      and (p_to is null or transaction_date <= p_to)
  ),
  business_transfer_summary as (
    select coalesce(sum(round(a.amount * t.exchange_rate_to_cny, 4)), 0) as income
    from public.business_order_payment_allocations a
    join public.business_customer_transfers t on t.id = a.transfer_id
    join public.business_orders bo on bo.id = a.order_id
    where a.voided_at is null
      and t.voided_at is null
      and bo.voided_at is null
      and (
        p_from is null
        or (t.received_at at time zone 'Asia/Shanghai')::date >= p_from
      )
      and (
        p_to is null
        or (t.received_at at time zone 'Asia/Shanghai')::date <= p_to
      )
  ),
  legacy_cost_summary as (
    select coalesce(sum(foc.amount_cny), 0) as amount
    from public.finance_order_costs foc
    join public.finance_orders fo on fo.id = foc.finance_order_id
    where fo.status = 'active'
      and (p_from is null or fo.order_date >= p_from)
      and (p_to is null or fo.order_date <= p_to)
  ),
  business_cost_summary as (
    select coalesce(sum(foc.amount_cny), 0) as amount
    from public.finance_order_costs foc
    join public.business_orders bo on bo.id = foc.business_order_id
    where bo.status = 'completed'
      and bo.voided_at is null
      and (p_from is null or bo.order_date >= p_from)
      and (p_to is null or bo.order_date <= p_to)
  ),
  business_wage_summary as (
    select coalesce(sum(bofd.wage_amount_cny), 0) as amount
    from public.business_order_finance_details bofd
    join public.business_orders bo on bo.id = bofd.order_id
    where bo.status = 'completed'
      and bo.voided_at is null
      and (p_from is null or bo.order_date >= p_from)
      and (p_to is null or bo.order_date <= p_to)
  )
  select
    lo.amount + bo.amount as order_revenue,
    ts.income + bt.income as income,
    ts.expense as expense,
    lc.amount + bc.amount + bw.amount as order_costs,
    (lo.amount + bo.amount) - (lc.amount + bc.amount + bw.amount) as gross_profit,
    (ts.income + bt.income) - ts.expense as cash_balance,
    bo.completed_count::integer as completed_order_count,
    ip.in_progress_count::integer as in_progress_order_count,
    ipt.totals as in_progress_totals,
    bo.unpriced_count::integer as unpriced_completed_order_count
  from legacy_order_summary lo
  cross join business_order_summary bo
  cross join business_in_progress ip
  cross join business_in_progress_totals ipt
  cross join transaction_summary ts
  cross join business_transfer_summary bt
  cross join legacy_cost_summary lc
  cross join business_cost_summary bc
  cross join business_wage_summary bw;
$function$;

comment on function public.get_finance_overview(date, date) is
  '财务总览区间汇总：订单业绩/毛利只计已完成订单，现金收支含客户转账；进行中金额按原币返回。';

create or replace function public.get_finance_cash_trend(p_months integer default 6)
returns table (
  month text,
  income numeric,
  expense numeric
)
language sql
stable
set search_path to 'public'
as $function$
  with params as (
    select
      greatest(1, least(coalesce(p_months, 6), 24)) as months,
      (date_trunc('month', (now() at time zone 'Asia/Shanghai'))::date) as this_month
  ),
  month_series as (
    select to_char(series.month, 'YYYY-MM') as month
    from params,
    generate_series(
      params.this_month - make_interval(months => params.months - 1),
      params.this_month,
      interval '1 month'
    ) as series(month)
  ),
  transaction_totals as (
    select
      to_char(t.transaction_date, 'YYYY-MM') as month,
      coalesce(sum(t.amount_cny) filter (where t.transaction_type = 'income'), 0) as income,
      coalesce(sum(t.amount_cny) filter (where t.transaction_type = 'expense'), 0) as expense
    from public.finance_transactions t
    where t.status = 'active'
      and t.transaction_date >= (
        select params.this_month - make_interval(months => params.months - 1)
        from params
      )
    group by 1
  ),
  transfer_totals as (
    select
      to_char((tr.received_at at time zone 'Asia/Shanghai')::date, 'YYYY-MM') as month,
      coalesce(sum(round(a.amount * tr.exchange_rate_to_cny, 4)), 0) as income
    from public.business_order_payment_allocations a
    join public.business_customer_transfers tr on tr.id = a.transfer_id
    join public.business_orders bo on bo.id = a.order_id
    where a.voided_at is null
      and tr.voided_at is null
      and bo.voided_at is null
      and (tr.received_at at time zone 'Asia/Shanghai')::date >= (
        select params.this_month - make_interval(months => params.months - 1)
        from params
      )
    group by 1
  )
  select
    ms.month,
    coalesce(tt.income, 0) + coalesce(tr.income, 0) as income,
    coalesce(tt.expense, 0) as expense
  from month_series ms
  left join transaction_totals tt on tt.month = ms.month
  left join transfer_totals tr on tr.month = ms.month
  order by ms.month;
$function$;

comment on function public.get_finance_cash_trend(integer) is
  '近 N 个自然月现金收支：收入=日记账收入+客户转账折合，支出=日记账支出。';

revoke all on function public.get_finance_overview(date, date) from public, anon;
revoke all on function public.get_finance_cash_trend(integer) from public, anon;
grant execute on function public.get_finance_overview(date, date) to authenticated;
grant execute on function public.get_finance_cash_trend(integer) to authenticated;

commit;
