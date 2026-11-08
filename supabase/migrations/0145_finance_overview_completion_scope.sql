-- 0145_finance_overview_completion_scope.sql
-- 财务总览「已完成订单」改为业务实际口径：
--   已手动完成（status = 'completed'）
--   或 已提交/已审批订单全部发货且尾款收齐（fulfillment_status = 'fully_shipped' 且 outstanding <= 0）。
-- outstanding 与台账 0138 完全一致：
--   greatest(total_amount - coalesce(total_sales_amount, 0) - 有效分摊合计, 0)
-- 业绩、成本、工资与「进行中」数量全部按同一集合统计，避免两处口径不一致。
-- 2) 收支只认财务日记账（finance_transactions），客户转账不再计入总览与现金趋势。

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
  with order_scope as (
    select
      bo.id,
      bo.status::text as status,
      bo.currency,
      bo.total_amount,
      bo.total_cny,
      bo.fulfillment_status::text as fulfillment_status,
      greatest(
        bo.total_amount
          - coalesce(bo.total_sales_amount, 0)
          - pay.total_alloc,
        0
      ) as outstanding
    from public.business_orders bo
    left join lateral (
      select coalesce(sum(a.amount), 0) as total_alloc
      from public.business_order_payment_allocations a
      join public.business_customer_transfers t on t.id = a.transfer_id
      where a.order_id = bo.id
        and a.voided_at is null
        and t.voided_at is null
    ) pay on true
    where bo.voided_at is null
      and (p_from is null or bo.order_date >= p_from)
      and (p_to is null or bo.order_date <= p_to)
  ),
  order_state as (
    select
      os.*,
      (
        os.status = 'completed'
        or (
          os.status in ('submitted', 'approved')
          and os.fulfillment_status = 'fully_shipped'
          and os.outstanding <= 0
        )
      ) as is_completed
    from order_scope os
  ),
  business_completed as (
    select *
    from order_state
    where is_completed
  ),
  legacy_order_summary as (
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
    from business_completed
  ),
  business_in_progress as (
    select count(*) as in_progress_count
    from order_state
    where not is_completed
      and status in ('submitted', 'approved')
  ),
  business_in_progress_totals as (
    select coalesce(
      jsonb_object_agg(grouped.currency::text, grouped.amount),
      '{}'::jsonb
    ) as totals
    from (
      select currency, sum(total_amount) as amount
      from order_state
      where not is_completed
        and status in ('submitted', 'approved')
        and total_amount > 0
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
    join business_completed bc on bc.id = foc.business_order_id
  ),
  business_wage_summary as (
    select coalesce(sum(bofd.wage_amount_cny), 0) as amount
    from public.business_order_finance_details bofd
    join business_completed bc on bc.id = bofd.order_id
  )
  select
    lo.amount + bo.amount as order_revenue,
    ts.income as income,
    ts.expense as expense,
    lc.amount + bc.amount + bw.amount as order_costs,
    (lo.amount + bo.amount) - (lc.amount + bc.amount + bw.amount) as gross_profit,
    ts.income - ts.expense as cash_balance,
    bo.completed_count::integer as completed_order_count,
    ip.in_progress_count::integer as in_progress_order_count,
    ipt.totals as in_progress_totals,
    bo.unpriced_count::integer as unpriced_completed_order_count
  from legacy_order_summary lo
  cross join business_order_summary bo
  cross join business_in_progress ip
  cross join business_in_progress_totals ipt
  cross join transaction_summary ts
  cross join legacy_cost_summary lc
  cross join business_cost_summary bc
  cross join business_wage_summary bw;
$function$;

comment on function public.get_finance_overview(date, date) is
  '财务总览区间汇总：已完成=手动完成或全部发货且尾款收齐；业绩/成本/工资按同一完成集合，收支只取财务日记账。';

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
  )
  select
    ms.month,
    coalesce(tt.income, 0) as income,
    coalesce(tt.expense, 0) as expense
  from month_series ms
  left join transaction_totals tt on tt.month = ms.month
  order by ms.month;
$function$;

comment on function public.get_finance_cash_trend(integer) is
  '近 N 个自然月现金收支：收支均取财务日记账。';

revoke all on function public.get_finance_overview(date, date) from public, anon;
revoke all on function public.get_finance_cash_trend(integer) from public, anon;
grant execute on function public.get_finance_overview(date, date) to authenticated;
grant execute on function public.get_finance_cash_trend(integer) to authenticated;

commit;
