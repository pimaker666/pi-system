-- 0079 业务业绩按客户国家汇总

begin;

do $$
begin
  if to_regprocedure('public.get_business_performance_by_group(text, date, date, uuid[], uuid[], uuid[], text[])') is not null
     and to_regprocedure('public.get_business_performance_by_group_base(text, date, date, uuid[], uuid[], uuid[], text[])') is null then
    alter function public.get_business_performance_by_group(
      text, date, date, uuid[], uuid[], uuid[], text[]
    ) rename to get_business_performance_by_group_base;
  end if;
end;
$$;

create or replace function public.get_business_performance_by_group(
  p_group_by text default 'salesperson',
  p_date_from date default null,
  p_date_to date default null,
  p_salesperson_ids uuid[] default null,
  p_shop_ids uuid[] default null,
  p_product_group_ids uuid[] default null,
  p_shipping_categories text[] default null
)
returns table (
  group_key text,
  group_label text,
  group_sort_order int,
  order_count bigint,
  order_total_cny numeric,
  order_total_usd numeric,
  order_total_cny_native numeric,
  received_cny numeric,
  received_usd numeric,
  received_cny_native numeric,
  outstanding_cny numeric,
  outstanding_usd numeric,
  outstanding_cny_native numeric,
  overdue_count bigint
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_today date := (current_timestamp at time zone 'Asia/Shanghai')::date;
begin
  if p_group_by <> 'country' then
    return query
    select *
    from public.get_business_performance_by_group_base(
      p_group_by,
      p_date_from,
      p_date_to,
      p_salesperson_ids,
      p_shop_ids,
      p_product_group_ids,
      p_shipping_categories
    );
    return;
  end if;

  return query
  with filtered_orders as (
    select
      bo.id,
      bo.customer_id,
      bo.currency,
      bo.total_amount,
      bo.total_cny,
      bo.exchange_rate_to_cny,
      bo.total_sales_amount,
      bo.payment_status,
      bo.payment_due_date
    from public.business_orders bo
    where bo.voided_at is null
      and (p_date_from is null or bo.order_date >= p_date_from)
      and (p_date_to is null or bo.order_date <= p_date_to)
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
             where i.order_id = bo.id
               and cv.product_group_id = any (p_product_group_ids)
           ))
      and public.can_view_business_order(bo.id)
  ),
  orders_matching_shipping as (
    select fo.*
    from filtered_orders fo
    where p_shipping_categories is null or array_length(p_shipping_categories, 1) is null
       or exists (
         select 1
         from public.business_order_items i
         where i.order_id = fo.id
           and i.daily_shipping_category::text = any (p_shipping_categories)
       )
  ),
  allocations as (
    select
      oms.id as order_id,
      coalesce(sum(a.amount) filter (where a.voided_at is null and t.voided_at is null), 0) as allocated_amount,
      coalesce(sum(a.amount * t.exchange_rate_to_cny) filter (where a.voided_at is null and t.voided_at is null), 0) as allocated_cny
    from orders_matching_shipping oms
    left join public.business_order_payment_allocations a on a.order_id = oms.id
    left join public.business_customer_transfers t on t.id = a.transfer_id
    group by oms.id
  ),
  order_amounts as (
    select
      oms.*,
      coalesce(oms.total_sales_amount, 0) * coalesce(oms.exchange_rate_to_cny, 0)
        + coalesce(a.allocated_cny, 0) as received_cny,
      greatest(
        (oms.total_amount - coalesce(oms.total_sales_amount, 0)) * coalesce(oms.exchange_rate_to_cny, 0)
        - coalesce(a.allocated_cny, 0),
        0
      ) as outstanding_cny,
      coalesce(oms.total_sales_amount, 0)
        + case
            when oms.exchange_rate_to_cny is not null and oms.exchange_rate_to_cny <> 0
            then coalesce(a.allocated_cny, 0) / oms.exchange_rate_to_cny
            else 0
          end as received_amount,
      greatest(
        oms.total_amount
        - coalesce(oms.total_sales_amount, 0)
        - case
            when oms.exchange_rate_to_cny is not null and oms.exchange_rate_to_cny <> 0
            then coalesce(a.allocated_cny, 0) / oms.exchange_rate_to_cny
            else 0
          end,
        0
      ) as outstanding_amount
    from orders_matching_shipping oms
    left join allocations a on a.order_id = oms.id
  ),
  country_orders as (
    select
      oa.*,
      coalesce(nullif(btrim(c.country), ''), '') as country
    from order_amounts oa
    left join public.customers c on c.id = oa.customer_id
  )
  select
    co.country,
    coalesce(nullif(co.country, ''), '(未填写)'),
    0,
    count(distinct co.id),
    coalesce(sum(co.total_cny), 0),
    coalesce(sum(co.total_amount) filter (where co.currency = 'USD'), 0),
    coalesce(sum(co.total_amount) filter (where co.currency = 'CNY'), 0),
    coalesce(sum(co.received_cny), 0),
    coalesce(sum(co.received_amount) filter (where co.currency = 'USD'), 0),
    coalesce(sum(co.received_amount) filter (where co.currency = 'CNY'), 0),
    coalesce(sum(co.outstanding_cny), 0),
    coalesce(sum(co.outstanding_amount) filter (where co.currency = 'USD'), 0),
    coalesce(sum(co.outstanding_amount) filter (where co.currency = 'CNY'), 0),
    count(distinct co.id) filter (
      where co.payment_status <> 'fully_paid'
        and co.payment_due_date is not null
        and co.payment_due_date < v_today
    )
  from country_orders co
  group by co.country
  order by coalesce(sum(co.total_cny), 0) desc;
end;
$$;

revoke all on function public.get_business_performance_by_group_base(
  text, date, date, uuid[], uuid[], uuid[], text[]
) from public, anon, authenticated, service_role;
revoke all on function public.get_business_performance_by_group(
  text, date, date, uuid[], uuid[], uuid[], text[]
) from public, anon, authenticated, service_role;
grant execute on function public.get_business_performance_by_group(
  text, date, date, uuid[], uuid[], uuid[], text[]
) to authenticated, service_role;

commit;
