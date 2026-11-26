-- 0165 业务业绩：新老客户成交看板
--
-- 口径（已与使用方确认）：
--   - 新客：客户首单日期落在统计期间内。首单日期取该客户在所有未作废、当前账号可见订单中的
--     最早下单日期，不受上方筛选（下单日期/收款日期/业务/渠道/产品分组/发货分类）影响。
--   - 成交额：订单总额（business_orders.total_amount 原币），CNY 与 USD 分列；另返回按订单
--     记账汇率折算的人民币口径（total_cny），仅供柱高与占比使用。作废订单不计。
--   - 期间：月度序列（默认近 12 个月，显式传下单日期时按区间生成）＋年度块；年度块同时返回
--     「自然年」与「滚动 12 个月」两套，前端本地切换，无需再回服务端。
--   - 客户年限：按订单日期距首单日期的月数分档（≤12 个月 / 12–24 个月 / ≥24 个月）。
--   - 未绑定客户（customer_id is null）单独返回，不计入新老客户。
--   - 订单集合沿用 0163 的筛选与权限逻辑（含追加行收款日命中、can_view_business_order）。
--
-- 另含「选定区间新客户首年成交」（get_business_performance_new_customer_first_year）：
--   - 首单日期落在区间内的客户即新客；其「首单起 12 个月内」全部订单（含首单）都计入首年成交。
--   - 区间只决定哪些客户算新客；首年内订单不受下单/收款日期筛选影响，
--     但仍遵循业务/渠道/产品分组/发货分类筛选与 can_view_business_order。
--
-- 新函数；create or replace + 先 drop 旧签名，可重复执行。

begin;

drop function if exists public.get_business_performance_customer_cohorts(
  date, date, date, date, date, date, uuid[], uuid[], uuid[], text[]
);

create or replace function public.get_business_performance_customer_cohorts(
  p_date_from date default null,
  p_date_to date default null,
  p_received_from date default null,
  p_received_to date default null,
  p_created_from date default null,
  p_created_to date default null,
  p_salesperson_ids uuid[] default null,
  p_shop_ids uuid[] default null,
  p_product_group_ids uuid[] default null,
  p_shipping_categories text[] default null
)
returns table (
  section text,
  period_key text,
  period_label text,
  period_start date,
  period_end date,
  new_customer_count bigint,
  new_order_count bigint,
  new_amount_cny numeric,
  new_amount_usd numeric,
  new_amount_cny_equivalent numeric,
  old_customer_count bigint,
  old_order_count bigint,
  old_amount_cny numeric,
  old_amount_usd numeric,
  old_amount_cny_equivalent numeric,
  unbound_order_count bigint,
  unbound_amount_cny numeric,
  unbound_amount_usd numeric,
  unbound_amount_cny_equivalent numeric,
  first_year_amount_cny numeric,
  first_year_amount_usd numeric,
  one_two_year_amount_cny numeric,
  one_two_year_amount_usd numeric,
  two_plus_year_amount_cny numeric,
  two_plus_year_amount_usd numeric,
  active_customer_count bigint,
  prior_active_customer_count bigint,
  retained_customer_count bigint
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_today date := (current_timestamp at time zone 'Asia/Shanghai')::date;
begin
  return query
  with latest_custom_groups as (
    select distinct on (v.custom_product_id) v.custom_product_id, v.product_group_id
    from public.business_custom_product_versions v
    order by v.custom_product_id, v.version_no desc
  ),
  filtered_orders as (
    select bo.id,
           bo.customer_id,
           bo.order_date,
           bo.currency,
           coalesce(bo.total_amount, 0) as total_amount,
           coalesce(bo.total_cny, 0) as total_cny
    from public.business_orders bo
    where bo.voided_at is null
      and (p_date_from is null or bo.order_date >= p_date_from)
      and (p_date_to is null or bo.order_date <= p_date_to)
      and (p_created_from is null or (bo.created_at at time zone 'Asia/Shanghai')::date >= p_created_from)
      and (p_created_to is null or (bo.created_at at time zone 'Asia/Shanghai')::date <= p_created_to)
      and (p_salesperson_ids is null or array_length(p_salesperson_ids, 1) is null
           or bo.salesperson_id = any (p_salesperson_ids))
      and (p_shop_ids is null or array_length(p_shop_ids, 1) is null
           or bo.shop_id = any (p_shop_ids))
      and (p_product_group_ids is null or array_length(p_product_group_ids, 1) is null
           or exists (
             select 1
             from public.business_order_items i
             left join public.products p on p.id = i.product_id
             left join public.business_custom_product_versions cv on cv.id = i.custom_product_version_id
             left join latest_custom_groups lcg on lcg.custom_product_id = i.custom_product_id
             where i.order_id = bo.id
               and coalesce(p.group_id, lcg.product_group_id) = any (p_product_group_ids)
           ))
      and public.can_view_business_order(bo.id)
      and (
        (p_received_from is null and p_received_to is null)
        or (coalesce(bo.total_sales_amount, 0) <> 0
            and (p_received_from is null or bo.order_date >= p_received_from)
            and (p_received_to is null or bo.order_date <= p_received_to))
        or exists (
          select 1
          from public.business_order_payment_allocations a
          join public.business_customer_transfers t on t.id = a.transfer_id
          where a.order_id = bo.id
            and a.voided_at is null
            and t.voided_at is null
            and (p_received_from is null or (t.received_at at time zone 'Asia/Shanghai')::date >= p_received_from)
            and (p_received_to is null or (t.received_at at time zone 'Asia/Shanghai')::date <= p_received_to)
        )
        or exists (
          select 1
          from public.business_order_items i
          where i.order_id = bo.id
            and i.origin = 'append'
            and coalesce(i.sales_total_amount, 0) <> 0
            and (p_received_from is null or (i.created_at at time zone 'Asia/Shanghai')::date >= p_received_from)
            and (p_received_to is null or (i.created_at at time zone 'Asia/Shanghai')::date <= p_received_to)
        )
      )
  ),
  amount_orders as (
    select fo.id, fo.customer_id, fo.order_date, fo.currency, fo.total_amount, fo.total_cny
    from filtered_orders fo
    where p_shipping_categories is null or array_length(p_shipping_categories, 1) is null
       or exists (
         select 1
         from public.business_order_items i
         where i.order_id = fo.id
           and i.daily_shipping_category::text = any (p_shipping_categories)
       )
  ),
  customer_first_orders as (
    select bo.customer_id, min(bo.order_date) as first_order_date
    from public.business_orders bo
    where bo.voided_at is null
      and bo.customer_id in (
        select distinct ao.customer_id from amount_orders ao where ao.customer_id is not null
      )
      and public.can_view_business_order(bo.id)
    group by bo.customer_id
  ),
  classified as (
    select ao.id,
           ao.customer_id,
           ao.order_date,
           ao.currency,
           ao.total_amount,
           ao.total_cny,
           date_trunc('month', ao.order_date)::date as order_month,
           cfo.first_order_date,
           date_trunc('month', cfo.first_order_date)::date as first_order_month
    from amount_orders ao
    left join customer_first_orders cfo on cfo.customer_id = ao.customer_id
  ),
  month_bounds as (
    select date_trunc('month', coalesce(p_date_from, (v_today - interval '11 months')::date))::date as start_month,
           date_trunc('month', coalesce(p_date_to, v_today))::date as end_month
  ),
  month_series as (
    select generate_series(mb.start_month, mb.end_month, interval '1 month')::date as month_start
    from month_bounds mb
  ),
  month_agg as (
    select c.order_month as month_start,
           count(distinct c.customer_id) filter (where c.customer_id is not null and c.first_order_month = c.order_month) as new_customer_count,
           count(*) filter (where c.customer_id is not null and c.first_order_month = c.order_month) as new_order_count,
           coalesce(sum(c.total_amount) filter (where c.customer_id is not null and c.first_order_month = c.order_month and c.currency = 'CNY'), 0) as new_amount_cny,
           coalesce(sum(c.total_amount) filter (where c.customer_id is not null and c.first_order_month = c.order_month and c.currency = 'USD'), 0) as new_amount_usd,
           coalesce(sum(c.total_cny) filter (where c.customer_id is not null and c.first_order_month = c.order_month), 0) as new_amount_cny_equivalent,
           count(distinct c.customer_id) filter (where c.customer_id is not null and c.first_order_month < c.order_month) as old_customer_count,
           count(*) filter (where c.customer_id is not null and c.first_order_month < c.order_month) as old_order_count,
           coalesce(sum(c.total_amount) filter (where c.customer_id is not null and c.first_order_month < c.order_month and c.currency = 'CNY'), 0) as old_amount_cny,
           coalesce(sum(c.total_amount) filter (where c.customer_id is not null and c.first_order_month < c.order_month and c.currency = 'USD'), 0) as old_amount_usd,
           coalesce(sum(c.total_cny) filter (where c.customer_id is not null and c.first_order_month < c.order_month), 0) as old_amount_cny_equivalent,
           count(*) filter (where c.customer_id is null) as unbound_order_count,
           coalesce(sum(c.total_amount) filter (where c.customer_id is null and c.currency = 'CNY'), 0) as unbound_amount_cny,
           coalesce(sum(c.total_amount) filter (where c.customer_id is null and c.currency = 'USD'), 0) as unbound_amount_usd,
           coalesce(sum(c.total_cny) filter (where c.customer_id is null), 0) as unbound_amount_cny_equivalent
    from classified c
    group by c.order_month
  ),
  month_rows as (
    select 'month'::text as section,
           to_char(ms.month_start, 'YYYY-MM') as period_key,
           to_char(ms.month_start, 'YYYY-MM') as period_label,
           ms.month_start as period_start,
           (ms.month_start + interval '1 month - 1 day')::date as period_end,
           coalesce(ma.new_customer_count, 0) as new_customer_count,
           coalesce(ma.new_order_count, 0) as new_order_count,
           coalesce(ma.new_amount_cny, 0) as new_amount_cny,
           coalesce(ma.new_amount_usd, 0) as new_amount_usd,
           coalesce(ma.new_amount_cny_equivalent, 0) as new_amount_cny_equivalent,
           coalesce(ma.old_customer_count, 0) as old_customer_count,
           coalesce(ma.old_order_count, 0) as old_order_count,
           coalesce(ma.old_amount_cny, 0) as old_amount_cny,
           coalesce(ma.old_amount_usd, 0) as old_amount_usd,
           coalesce(ma.old_amount_cny_equivalent, 0) as old_amount_cny_equivalent,
           coalesce(ma.unbound_order_count, 0) as unbound_order_count,
           coalesce(ma.unbound_amount_cny, 0) as unbound_amount_cny,
           coalesce(ma.unbound_amount_usd, 0) as unbound_amount_usd,
           coalesce(ma.unbound_amount_cny_equivalent, 0) as unbound_amount_cny_equivalent,
           0::numeric as first_year_amount_cny,
           0::numeric as first_year_amount_usd,
           0::numeric as one_two_year_amount_cny,
           0::numeric as one_two_year_amount_usd,
           0::numeric as two_plus_amount_cny,
           0::numeric as two_plus_amount_usd,
           0::bigint as active_customer_count,
           0::bigint as prior_active_customer_count,
           0::bigint as retained_customer_count
    from month_series ms
    left join month_agg ma on ma.month_start = ms.month_start
  ),
  calendar_periods as (
    select distinct
           date_trunc('year', c.order_date)::date as period_start,
           (date_trunc('year', c.order_date) + interval '1 year - 1 day')::date as period_end,
           to_char(c.order_date, 'YYYY') as period_key,
           to_char(c.order_date, 'YYYY') || ' 年' as period_label
    from classified c
  ),
  rolling_periods as (
    select p.period_start,
           p.period_end,
           to_char(p.period_start, 'YYYY-MM') || '~' || to_char(p.period_end, 'YYYY-MM') as period_key,
           to_char(p.period_start, 'YYYY-MM') || ' ~ ' || to_char(p.period_end, 'YYYY-MM') as period_label
    from (
      select (date_trunc('month', v_today::timestamp) - ((k * 12 + 11) * interval '1 month'))::date as period_start,
             (date_trunc('month', v_today::timestamp) + interval '1 month' - ((k * 12) * interval '1 month'))::date - 1 as period_end
      from generate_series(0, 9) as k
    ) p
    where exists (
      select 1 from classified c
      where c.order_date between p.period_start and p.period_end
    )
  ),
  periods as (
    select 'period_calendar'::text as section, cp.period_start, cp.period_end, cp.period_key, cp.period_label
    from calendar_periods cp
    union all
    select 'period_rolling'::text as section, rp.period_start, rp.period_end, rp.period_key, rp.period_label
    from rolling_periods rp
  ),
  periods_with_prev as (
    select p.section,
           p.period_start,
           p.period_end,
           p.period_key,
           p.period_label,
           lag(p.period_start) over (partition by p.section order by p.period_start) as prev_start
    from periods p
  ),
  period_agg as (
    select pp.section,
           pp.period_key,
           pp.period_label,
           pp.period_start,
           pp.period_end,
           count(distinct c.customer_id) filter (where c.customer_id is not null and c.first_order_date between pp.period_start and pp.period_end) as new_customer_count,
           count(*) filter (where c.customer_id is not null and c.first_order_date between pp.period_start and pp.period_end) as new_order_count,
           coalesce(sum(c.total_amount) filter (where c.customer_id is not null and c.first_order_date between pp.period_start and pp.period_end and c.currency = 'CNY'), 0) as new_amount_cny,
           coalesce(sum(c.total_amount) filter (where c.customer_id is not null and c.first_order_date between pp.period_start and pp.period_end and c.currency = 'USD'), 0) as new_amount_usd,
           coalesce(sum(c.total_cny) filter (where c.customer_id is not null and c.first_order_date between pp.period_start and pp.period_end), 0) as new_amount_cny_equivalent,
           count(distinct c.customer_id) filter (where c.customer_id is not null and c.first_order_date < pp.period_start) as old_customer_count,
           count(*) filter (where c.customer_id is not null and c.first_order_date < pp.period_start) as old_order_count,
           coalesce(sum(c.total_amount) filter (where c.customer_id is not null and c.first_order_date < pp.period_start and c.currency = 'CNY'), 0) as old_amount_cny,
           coalesce(sum(c.total_amount) filter (where c.customer_id is not null and c.first_order_date < pp.period_start and c.currency = 'USD'), 0) as old_amount_usd,
           coalesce(sum(c.total_cny) filter (where c.customer_id is not null and c.first_order_date < pp.period_start), 0) as old_amount_cny_equivalent,
           count(*) filter (where c.customer_id is null) as unbound_order_count,
           coalesce(sum(c.total_amount) filter (where c.customer_id is null and c.currency = 'CNY'), 0) as unbound_amount_cny,
           coalesce(sum(c.total_amount) filter (where c.customer_id is null and c.currency = 'USD'), 0) as unbound_amount_usd,
           coalesce(sum(c.total_cny) filter (where c.customer_id is null), 0) as unbound_amount_cny_equivalent,
           coalesce(sum(c.total_amount) filter (where c.customer_id is not null and c.currency = 'CNY' and c.order_date < c.first_order_date + interval '12 months'), 0) as first_year_amount_cny,
           coalesce(sum(c.total_amount) filter (where c.customer_id is not null and c.currency = 'USD' and c.order_date < c.first_order_date + interval '12 months'), 0) as first_year_amount_usd,
           coalesce(sum(c.total_amount) filter (where c.customer_id is not null and c.currency = 'CNY' and c.order_date >= c.first_order_date + interval '12 months' and c.order_date < c.first_order_date + interval '24 months'), 0) as one_two_year_amount_cny,
           coalesce(sum(c.total_amount) filter (where c.customer_id is not null and c.currency = 'USD' and c.order_date >= c.first_order_date + interval '12 months' and c.order_date < c.first_order_date + interval '24 months'), 0) as one_two_year_amount_usd,
           coalesce(sum(c.total_amount) filter (where c.customer_id is not null and c.currency = 'CNY' and c.order_date >= c.first_order_date + interval '24 months'), 0) as two_plus_amount_cny,
           coalesce(sum(c.total_amount) filter (where c.customer_id is not null and c.currency = 'USD' and c.order_date >= c.first_order_date + interval '24 months'), 0) as two_plus_amount_usd
    from periods_with_prev pp
    left join classified c on c.order_date between pp.period_start and pp.period_end
    group by pp.section, pp.period_key, pp.period_label, pp.period_start, pp.period_end
  ),
  period_customer_sets as (
    select pp.section, pp.period_start, c.customer_id
    from periods_with_prev pp
    join classified c on c.customer_id is not null
      and c.order_date between pp.period_start and pp.period_end
    group by pp.section, pp.period_start, c.customer_id
  ),
  period_retention as (
    select pp.section,
           pp.period_start,
           (select count(*) from period_customer_sets s
             where s.section = pp.section and s.period_start = pp.period_start) as active_customer_count,
           (select count(*) from period_customer_sets s
             where s.section = pp.section and s.period_start = pp.prev_start) as prior_active_customer_count,
           (select count(*)
              from period_customer_sets cur
              join period_customer_sets prev
                on prev.section = cur.section
               and prev.period_start = pp.prev_start
               and prev.customer_id = cur.customer_id
             where cur.section = pp.section and cur.period_start = pp.period_start) as retained_customer_count
    from periods_with_prev pp
  ),
  period_rows as (
    select pa.section,
           pa.period_key,
           pa.period_label,
           pa.period_start,
           pa.period_end,
           pa.new_customer_count,
           pa.new_order_count,
           pa.new_amount_cny,
           pa.new_amount_usd,
           pa.new_amount_cny_equivalent,
           pa.old_customer_count,
           pa.old_order_count,
           pa.old_amount_cny,
           pa.old_amount_usd,
           pa.old_amount_cny_equivalent,
           pa.unbound_order_count,
           pa.unbound_amount_cny,
           pa.unbound_amount_usd,
           pa.unbound_amount_cny_equivalent,
           pa.first_year_amount_cny,
           pa.first_year_amount_usd,
           pa.one_two_year_amount_cny,
           pa.one_two_year_amount_usd,
           pa.two_plus_amount_cny,
           pa.two_plus_amount_usd,
           coalesce(pr.active_customer_count, 0) as active_customer_count,
           coalesce(pr.prior_active_customer_count, 0) as prior_active_customer_count,
           coalesce(pr.retained_customer_count, 0) as retained_customer_count
    from period_agg pa
    left join period_retention pr
      on pr.section = pa.section and pr.period_start = pa.period_start
  )
  select *
  from (
    select * from month_rows
    union all
    select * from period_rows
  ) cohort_rows
  order by cohort_rows.section, cohort_rows.period_start;
end;
$$;

revoke all on function public.get_business_performance_customer_cohorts(
  date, date, date, date, date, date, uuid[], uuid[], uuid[], text[]
) from public, anon, authenticated, service_role;
grant execute on function public.get_business_performance_customer_cohorts(
  date, date, date, date, date, date, uuid[], uuid[], uuid[], text[]
) to authenticated, service_role;

-- 选定区间新客户首年成交：首单日期落在 [p_window_from, p_window_to] 的客户即新客，
-- 其首单起 12 个月内（order_date < 首单日期 + 12 个月）全部订单都计入首年成交。
-- 区间只决定哪些客户算新客；首年内订单不受下单/收款日期筛选影响。

drop function if exists public.get_business_performance_new_customer_first_year(
  date, date, uuid[], uuid[], uuid[], text[]
);

create or replace function public.get_business_performance_new_customer_first_year(
  p_window_from date,
  p_window_to date,
  p_salesperson_ids uuid[] default null,
  p_shop_ids uuid[] default null,
  p_product_group_ids uuid[] default null,
  p_shipping_categories text[] default null
)
returns table (
  period_key text,
  period_start date,
  customer_count bigint,
  first_order_count bigint,
  first_order_amount_cny numeric,
  first_order_amount_usd numeric,
  follow_up_order_count bigint,
  follow_up_amount_cny numeric,
  follow_up_amount_usd numeric,
  first_year_order_count bigint,
  first_year_amount_cny numeric,
  first_year_amount_usd numeric
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  return query
  with latest_custom_groups as (
    select distinct on (v.custom_product_id) v.custom_product_id, v.product_group_id
    from public.business_custom_product_versions v
    order by v.custom_product_id, v.version_no desc
  ),
  visible_orders as (
    select bo.id,
           bo.customer_id,
           bo.order_date,
           bo.currency,
           coalesce(bo.total_amount, 0) as total_amount
    from public.business_orders bo
    where bo.voided_at is null
      and bo.customer_id is not null
      and (p_salesperson_ids is null or array_length(p_salesperson_ids, 1) is null
           or bo.salesperson_id = any (p_salesperson_ids))
      and (p_shop_ids is null or array_length(p_shop_ids, 1) is null
           or bo.shop_id = any (p_shop_ids))
      and (p_product_group_ids is null or array_length(p_product_group_ids, 1) is null
           or exists (
             select 1
             from public.business_order_items i
             left join public.products p on p.id = i.product_id
             left join public.business_custom_product_versions cv on cv.id = i.custom_product_version_id
             left join latest_custom_groups lcg on lcg.custom_product_id = i.custom_product_id
             where i.order_id = bo.id
               and coalesce(p.group_id, lcg.product_group_id) = any (p_product_group_ids)
           ))
      and (p_shipping_categories is null or array_length(p_shipping_categories, 1) is null
           or exists (
             select 1
             from public.business_order_items i
             where i.order_id = bo.id
               and i.daily_shipping_category::text = any (p_shipping_categories)
           ))
      and public.can_view_business_order(bo.id)
  ),
  customer_first_orders as (
    select bo.customer_id, min(bo.order_date) as first_order_date
    from public.business_orders bo
    where bo.voided_at is null
      and bo.customer_id in (select distinct vo.customer_id from visible_orders vo)
      and public.can_view_business_order(bo.id)
    group by bo.customer_id
  ),
  cohort as (
    select cfo.customer_id, cfo.first_order_date
    from customer_first_orders cfo
    where cfo.first_order_date between p_window_from and p_window_to
  ),
  cohort_orders as (
    select vo.customer_id,
           date_trunc('month', c.first_order_date)::date as first_order_month,
           (vo.order_date = c.first_order_date) as is_first_order,
           vo.currency,
           vo.total_amount
    from visible_orders vo
    join cohort c on c.customer_id = vo.customer_id
    where vo.order_date >= c.first_order_date
      and vo.order_date < c.first_order_date + interval '12 months'
  )
  select to_char(co.first_order_month, 'YYYY-MM') as period_key,
         co.first_order_month as period_start,
         count(distinct co.customer_id) as customer_count,
         count(*) filter (where co.is_first_order) as first_order_count,
         coalesce(sum(co.total_amount) filter (where co.is_first_order and co.currency = 'CNY'), 0) as first_order_amount_cny,
         coalesce(sum(co.total_amount) filter (where co.is_first_order and co.currency = 'USD'), 0) as first_order_amount_usd,
         count(*) filter (where not co.is_first_order) as follow_up_order_count,
         coalesce(sum(co.total_amount) filter (where not co.is_first_order and co.currency = 'CNY'), 0) as follow_up_amount_cny,
         coalesce(sum(co.total_amount) filter (where not co.is_first_order and co.currency = 'USD'), 0) as follow_up_amount_usd,
         count(*) as first_year_order_count,
         coalesce(sum(co.total_amount) filter (where co.currency = 'CNY'), 0) as first_year_amount_cny,
         coalesce(sum(co.total_amount) filter (where co.currency = 'USD'), 0) as first_year_amount_usd
  from cohort_orders co
  group by co.first_order_month
  order by co.first_order_month;
end;
$$;

revoke all on function public.get_business_performance_new_customer_first_year(
  date, date, uuid[], uuid[], uuid[], text[]
) from public, anon, authenticated, service_role;
grant execute on function public.get_business_performance_new_customer_first_year(
  date, date, uuid[], uuid[], uuid[], text[]
) to authenticated, service_role;

commit;
