-- 0112 业务业绩新增「建单日期」筛选
--
-- 背景：业绩页原有「日期」筛的是订单下单日期 bo.order_date；业务还需要按订单在系统里的
-- 建单日（business_orders.created_at 的上海时区日期）单独筛选，两者可同时使用、取交集。
-- 方案：四个业绩 RPC（summary / by_group_base / by_group / by_product / multi_dimension）
-- 统一追加 p_created_from、p_created_to 两个可空参数（默认 null 即不过滤），函数体由 0102
-- 与 0079 的现有定义机械追加条件生成，聚合口径一律不变。参数带默认值属于新签名，
-- 因此先建新重载再 drop 旧签名，避免命名参数调用歧义，并重新授权。
-- 利润卡（get_business_order_profit_rows_filtered）按结清月归属，不受建单日期影响，保持原口径。

begin;

create or replace function public.get_business_performance_summary(
   p_date_from date default null,
   p_date_to date default null,
   p_created_from date default null,
   p_created_to date default null,
   p_salesperson_ids uuid[] default null,
   p_shop_ids uuid[] default null,
   p_product_group_ids uuid[] default null,
   p_shipping_categories text[] default null
 )
 returns table (
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
   return query
   with latest_custom_groups as (
     select distinct on (v.custom_product_id) v.custom_product_id, v.product_group_id
     from public.business_custom_product_versions v
     order by v.custom_product_id, v.version_no desc
   ),
   filtered_orders as (
     select bo.id,
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
   ),
   orders_matching_shipping as (
     select fo.id
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
     select oms.id as order_id,
            coalesce(sum(a.amount) filter (where a.voided_at is null and t.voided_at is null), 0) as allocated_amount,
            coalesce(sum(a.amount * t.exchange_rate_to_cny) filter (where a.voided_at is null and t.voided_at is null), 0) as allocated_cny
     from orders_matching_shipping oms
     left join public.business_order_payment_allocations a on a.order_id = oms.id
     left join public.business_customer_transfers t on t.id = a.transfer_id
     group by oms.id
   ),
   order_amounts as (
     select
       oms.id,
       bo.currency,
       bo.total_amount,
       bo.total_cny,
       bo.exchange_rate_to_cny,
       bo.total_sales_amount,
       bo.payment_status,
       bo.payment_due_date,
       coalesce(bo.total_sales_amount, 0) * coalesce(bo.exchange_rate_to_cny, 0)
         + coalesce(a.allocated_cny, 0) as received_cny,
       greatest(
         (bo.total_amount - coalesce(bo.total_sales_amount, 0)) * coalesce(bo.exchange_rate_to_cny, 0)
         - coalesce(a.allocated_cny, 0),
         0
       ) as outstanding_cny,
       coalesce(bo.total_sales_amount, 0)
         + case
             when bo.exchange_rate_to_cny is not null and bo.exchange_rate_to_cny <> 0
             then coalesce(a.allocated_cny, 0) / bo.exchange_rate_to_cny
             else 0
           end as received_amount,
       greatest(
         bo.total_amount
         - coalesce(bo.total_sales_amount, 0)
         - case
             when bo.exchange_rate_to_cny is not null and bo.exchange_rate_to_cny <> 0
             then coalesce(a.allocated_cny, 0) / bo.exchange_rate_to_cny
             else 0
           end,
         0
       ) as outstanding_amount
     from orders_matching_shipping oms
     join public.business_orders bo on bo.id = oms.id
     left join allocations a on a.order_id = oms.id
   )
   select
     count(distinct oa.id),
     coalesce(sum(oa.total_cny), 0),
     coalesce(sum(oa.total_amount) filter (where oa.currency = 'USD'), 0),
     coalesce(sum(oa.total_amount) filter (where oa.currency = 'CNY'), 0),
     coalesce(sum(oa.received_cny), 0),
     coalesce(sum(oa.received_amount) filter (where oa.currency = 'USD'), 0),
     coalesce(sum(oa.received_amount) filter (where oa.currency = 'CNY'), 0),
     coalesce(sum(oa.outstanding_cny), 0),
     coalesce(sum(oa.outstanding_amount) filter (where oa.currency = 'USD'), 0),
     coalesce(sum(oa.outstanding_amount) filter (where oa.currency = 'CNY'), 0),
     count(distinct oa.id) filter (
       where oa.payment_status <> 'fully_paid'
         and oa.payment_due_date is not null
         and oa.payment_due_date < v_today
     )
   from order_amounts oa;
 end;
 $$;

create or replace function public.get_business_performance_by_group_base(
   p_group_by text default 'salesperson',
   p_date_from date default null,
   p_date_to date default null,
   p_created_from date default null,
   p_created_to date default null,
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
   if p_group_by not in ('salesperson', 'shop', 'date', 'month', 'product_group', 'shipping_category') then
     raise exception 'Unsupported group_by: %', p_group_by;
   end if;

   -- 业务
   if p_group_by = 'salesperson' then
     return query
     with latest_custom_groups as (
       select distinct on (v.custom_product_id) v.custom_product_id, v.product_group_id
       from public.business_custom_product_versions v
       order by v.custom_product_id, v.version_no desc
     ),
     filtered_orders as (
       select bo.id,
              bo.salesperson_id,
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
     ),
     orders_matching_shipping as (
       select fo.id, fo.salesperson_id
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
       select oms.id as order_id,
              coalesce(sum(a.amount) filter (where a.voided_at is null and t.voided_at is null), 0) as allocated_amount,
              coalesce(sum(a.amount * t.exchange_rate_to_cny) filter (where a.voided_at is null and t.voided_at is null), 0) as allocated_cny
       from orders_matching_shipping oms
       left join public.business_order_payment_allocations a on a.order_id = oms.id
       left join public.business_customer_transfers t on t.id = a.transfer_id
       group by oms.id
     ),
     order_amounts as (
       select
         oms.id,
         oms.salesperson_id,
         bo.currency,
         bo.total_amount,
         bo.total_cny,
         bo.exchange_rate_to_cny,
         bo.total_sales_amount,
         bo.payment_status,
         bo.payment_due_date,
         coalesce(bo.total_sales_amount, 0) * coalesce(bo.exchange_rate_to_cny, 0)
           + coalesce(a.allocated_cny, 0) as received_cny,
         greatest(
           (bo.total_amount - coalesce(bo.total_sales_amount, 0)) * coalesce(bo.exchange_rate_to_cny, 0)
           - coalesce(a.allocated_cny, 0),
           0
         ) as outstanding_cny,
         coalesce(bo.total_sales_amount, 0)
           + case
               when bo.exchange_rate_to_cny is not null and bo.exchange_rate_to_cny <> 0
               then coalesce(a.allocated_cny, 0) / bo.exchange_rate_to_cny
               else 0
             end as received_amount,
         greatest(
           bo.total_amount
           - coalesce(bo.total_sales_amount, 0)
           - case
               when bo.exchange_rate_to_cny is not null and bo.exchange_rate_to_cny <> 0
               then coalesce(a.allocated_cny, 0) / bo.exchange_rate_to_cny
               else 0
             end,
           0
         ) as outstanding_amount
       from orders_matching_shipping oms
       join public.business_orders bo on bo.id = oms.id
       left join allocations a on a.order_id = oms.id
     )
     select
       coalesce(oa.salesperson_id::text, ''),
       coalesce(
         nullif(btrim(p.chinese_name), ''),
         nullif(btrim(p.full_name), ''),
         p.email,
         '(未分配)'
       ),
       0,
       count(distinct oa.id),
       coalesce(sum(oa.total_cny), 0),
       coalesce(sum(oa.total_amount) filter (where oa.currency = 'USD'), 0),
       coalesce(sum(oa.total_amount) filter (where oa.currency = 'CNY'), 0),
       coalesce(sum(oa.received_cny), 0),
       coalesce(sum(oa.received_amount) filter (where oa.currency = 'USD'), 0),
       coalesce(sum(oa.received_amount) filter (where oa.currency = 'CNY'), 0),
       coalesce(sum(oa.outstanding_cny), 0),
       coalesce(sum(oa.outstanding_amount) filter (where oa.currency = 'USD'), 0),
       coalesce(sum(oa.outstanding_amount) filter (where oa.currency = 'CNY'), 0),
       count(distinct oa.id) filter (
         where oa.payment_status <> 'fully_paid'
           and oa.payment_due_date is not null
           and oa.payment_due_date < v_today
       )
     from order_amounts oa
     left join public.profiles p on p.id = oa.salesperson_id
     group by oa.salesperson_id, p.chinese_name, p.full_name, p.email
     order by coalesce(sum(oa.total_cny), 0) desc;

   -- 渠道（店铺）
   elsif p_group_by = 'shop' then
     return query
     with latest_custom_groups as (
       select distinct on (v.custom_product_id) v.custom_product_id, v.product_group_id
       from public.business_custom_product_versions v
       order by v.custom_product_id, v.version_no desc
     ),
     filtered_orders as (
       select bo.id,
              bo.shop_id,
              bo.shop_name_snapshot,
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
     ),
     orders_matching_shipping as (
       select fo.id, fo.shop_id, fo.shop_name_snapshot
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
       select oms.id as order_id,
              coalesce(sum(a.amount) filter (where a.voided_at is null and t.voided_at is null), 0) as allocated_amount,
              coalesce(sum(a.amount * t.exchange_rate_to_cny) filter (where a.voided_at is null and t.voided_at is null), 0) as allocated_cny
       from orders_matching_shipping oms
       left join public.business_order_payment_allocations a on a.order_id = oms.id
       left join public.business_customer_transfers t on t.id = a.transfer_id
       group by oms.id
     ),
     order_amounts as (
       select
         oms.id,
         oms.shop_id,
         oms.shop_name_snapshot,
         bo.currency,
         bo.total_amount,
         bo.total_cny,
         bo.exchange_rate_to_cny,
         bo.total_sales_amount,
         bo.payment_status,
         bo.payment_due_date,
         coalesce(bo.total_sales_amount, 0) * coalesce(bo.exchange_rate_to_cny, 0)
           + coalesce(a.allocated_cny, 0) as received_cny,
         greatest(
           (bo.total_amount - coalesce(bo.total_sales_amount, 0)) * coalesce(bo.exchange_rate_to_cny, 0)
           - coalesce(a.allocated_cny, 0),
           0
         ) as outstanding_cny,
         coalesce(bo.total_sales_amount, 0)
           + case
               when bo.exchange_rate_to_cny is not null and bo.exchange_rate_to_cny <> 0
               then coalesce(a.allocated_cny, 0) / bo.exchange_rate_to_cny
               else 0
             end as received_amount,
         greatest(
           bo.total_amount
           - coalesce(bo.total_sales_amount, 0)
           - case
               when bo.exchange_rate_to_cny is not null and bo.exchange_rate_to_cny <> 0
               then coalesce(a.allocated_cny, 0) / bo.exchange_rate_to_cny
               else 0
             end,
           0
         ) as outstanding_amount
       from orders_matching_shipping oms
       join public.business_orders bo on bo.id = oms.id
       left join allocations a on a.order_id = oms.id
     )
     select
       coalesce(oa.shop_id::text, ''),
       coalesce(nullif(btrim(oa.shop_name_snapshot), ''), '(未分配)'),
       0,
       count(distinct oa.id),
       coalesce(sum(oa.total_cny), 0),
       coalesce(sum(oa.total_amount) filter (where oa.currency = 'USD'), 0),
       coalesce(sum(oa.total_amount) filter (where oa.currency = 'CNY'), 0),
       coalesce(sum(oa.received_cny), 0),
       coalesce(sum(oa.received_amount) filter (where oa.currency = 'USD'), 0),
       coalesce(sum(oa.received_amount) filter (where oa.currency = 'CNY'), 0),
       coalesce(sum(oa.outstanding_cny), 0),
       coalesce(sum(oa.outstanding_amount) filter (where oa.currency = 'USD'), 0),
       coalesce(sum(oa.outstanding_amount) filter (where oa.currency = 'CNY'), 0),
       count(distinct oa.id) filter (
         where oa.payment_status <> 'fully_paid'
           and oa.payment_due_date is not null
           and oa.payment_due_date < v_today
       )
     from order_amounts oa
     group by oa.shop_id, oa.shop_name_snapshot
     order by coalesce(sum(oa.total_cny), 0) desc;

   -- 日期
   elsif p_group_by = 'date' then
     return query
     with latest_custom_groups as (
       select distinct on (v.custom_product_id) v.custom_product_id, v.product_group_id
       from public.business_custom_product_versions v
       order by v.custom_product_id, v.version_no desc
     ),
     filtered_orders as (
       select bo.id,
              bo.order_date,
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
     ),
     orders_matching_shipping as (
       select fo.id, fo.order_date
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
       select oms.id as order_id,
              coalesce(sum(a.amount) filter (where a.voided_at is null and t.voided_at is null), 0) as allocated_amount,
              coalesce(sum(a.amount * t.exchange_rate_to_cny) filter (where a.voided_at is null and t.voided_at is null), 0) as allocated_cny
       from orders_matching_shipping oms
       left join public.business_order_payment_allocations a on a.order_id = oms.id
       left join public.business_customer_transfers t on t.id = a.transfer_id
       group by oms.id
     ),
     order_amounts as (
       select
         oms.id,
         oms.order_date,
         bo.currency,
         bo.total_amount,
         bo.total_cny,
         bo.exchange_rate_to_cny,
         bo.total_sales_amount,
         bo.payment_status,
         bo.payment_due_date,
         coalesce(bo.total_sales_amount, 0) * coalesce(bo.exchange_rate_to_cny, 0)
           + coalesce(a.allocated_cny, 0) as received_cny,
         greatest(
           (bo.total_amount - coalesce(bo.total_sales_amount, 0)) * coalesce(bo.exchange_rate_to_cny, 0)
           - coalesce(a.allocated_cny, 0),
           0
         ) as outstanding_cny,
         coalesce(bo.total_sales_amount, 0)
           + case
               when bo.exchange_rate_to_cny is not null and bo.exchange_rate_to_cny <> 0
               then coalesce(a.allocated_cny, 0) / bo.exchange_rate_to_cny
               else 0
             end as received_amount,
         greatest(
           bo.total_amount
           - coalesce(bo.total_sales_amount, 0)
           - case
               when bo.exchange_rate_to_cny is not null and bo.exchange_rate_to_cny <> 0
               then coalesce(a.allocated_cny, 0) / bo.exchange_rate_to_cny
               else 0
             end,
           0
         ) as outstanding_amount
       from orders_matching_shipping oms
       join public.business_orders bo on bo.id = oms.id
       left join allocations a on a.order_id = oms.id
     )
     select
       oa.order_date::text,
       oa.order_date::text,
       0,
       count(distinct oa.id),
       coalesce(sum(oa.total_cny), 0),
       coalesce(sum(oa.total_amount) filter (where oa.currency = 'USD'), 0),
       coalesce(sum(oa.total_amount) filter (where oa.currency = 'CNY'), 0),
       coalesce(sum(oa.received_cny), 0),
       coalesce(sum(oa.received_amount) filter (where oa.currency = 'USD'), 0),
       coalesce(sum(oa.received_amount) filter (where oa.currency = 'CNY'), 0),
       coalesce(sum(oa.outstanding_cny), 0),
       coalesce(sum(oa.outstanding_amount) filter (where oa.currency = 'USD'), 0),
       coalesce(sum(oa.outstanding_amount) filter (where oa.currency = 'CNY'), 0),
       count(distinct oa.id) filter (
         where oa.payment_status <> 'fully_paid'
           and oa.payment_due_date is not null
           and oa.payment_due_date < v_today
       )
     from order_amounts oa
     group by oa.order_date
     order by oa.order_date;

   -- 月份
   elsif p_group_by = 'month' then
     return query
     with latest_custom_groups as (
       select distinct on (v.custom_product_id) v.custom_product_id, v.product_group_id
       from public.business_custom_product_versions v
       order by v.custom_product_id, v.version_no desc
     ),
     filtered_orders as (
       select bo.id,
              bo.order_date,
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
     ),
     orders_matching_shipping as (
       select fo.id, fo.order_date
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
       select oms.id as order_id,
              coalesce(sum(a.amount) filter (where a.voided_at is null and t.voided_at is null), 0) as allocated_amount,
              coalesce(sum(a.amount * t.exchange_rate_to_cny) filter (where a.voided_at is null and t.voided_at is null), 0) as allocated_cny
       from orders_matching_shipping oms
       left join public.business_order_payment_allocations a on a.order_id = oms.id
       left join public.business_customer_transfers t on t.id = a.transfer_id
       group by oms.id
     ),
     order_amounts as (
       select
         oms.id,
         oms.order_date,
         bo.currency,
         bo.total_amount,
         bo.total_cny,
         bo.exchange_rate_to_cny,
         bo.total_sales_amount,
         bo.payment_status,
         bo.payment_due_date,
         coalesce(bo.total_sales_amount, 0) * coalesce(bo.exchange_rate_to_cny, 0)
           + coalesce(a.allocated_cny, 0) as received_cny,
         greatest(
           (bo.total_amount - coalesce(bo.total_sales_amount, 0)) * coalesce(bo.exchange_rate_to_cny, 0)
           - coalesce(a.allocated_cny, 0),
           0
         ) as outstanding_cny,
         coalesce(bo.total_sales_amount, 0)
           + case
               when bo.exchange_rate_to_cny is not null and bo.exchange_rate_to_cny <> 0
               then coalesce(a.allocated_cny, 0) / bo.exchange_rate_to_cny
               else 0
             end as received_amount,
         greatest(
           bo.total_amount
           - coalesce(bo.total_sales_amount, 0)
           - case
               when bo.exchange_rate_to_cny is not null and bo.exchange_rate_to_cny <> 0
               then coalesce(a.allocated_cny, 0) / bo.exchange_rate_to_cny
               else 0
             end,
           0
         ) as outstanding_amount
       from orders_matching_shipping oms
       join public.business_orders bo on bo.id = oms.id
       left join allocations a on a.order_id = oms.id
     )
     select
       to_char(oa.order_date, 'YYYY-MM'),
       to_char(oa.order_date, 'YYYY-MM'),
       0,
       count(distinct oa.id),
       coalesce(sum(oa.total_cny), 0),
       coalesce(sum(oa.total_amount) filter (where oa.currency = 'USD'), 0),
       coalesce(sum(oa.total_amount) filter (where oa.currency = 'CNY'), 0),
       coalesce(sum(oa.received_cny), 0),
       coalesce(sum(oa.received_amount) filter (where oa.currency = 'USD'), 0),
       coalesce(sum(oa.received_amount) filter (where oa.currency = 'CNY'), 0),
       coalesce(sum(oa.outstanding_cny), 0),
       coalesce(sum(oa.outstanding_amount) filter (where oa.currency = 'USD'), 0),
       coalesce(sum(oa.outstanding_amount) filter (where oa.currency = 'CNY'), 0),
       count(distinct oa.id) filter (
         where oa.payment_status <> 'fully_paid'
           and oa.payment_due_date is not null
           and oa.payment_due_date < v_today
       )
     from order_amounts oa
     group by to_char(oa.order_date, 'YYYY-MM')
     order by to_char(oa.order_date, 'YYYY-MM');

   -- 产品分组：按明细行聚合
   elsif p_group_by = 'product_group' then
     return query
     with latest_custom_groups as (
       select distinct on (v.custom_product_id) v.custom_product_id, v.product_group_id
       from public.business_custom_product_versions v
       order by v.custom_product_id, v.version_no desc
     ),
     filtered_orders as (
       select bo.id,
              bo.currency,
              bo.exchange_rate_to_cny,
              bo.payment_status,
              bo.payment_due_date
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
         and public.can_view_business_order(bo.id)
     ),
     items as (
       select
         i.order_id,
         coalesce(p.group_id, lcg.product_group_id) as product_group_id,
         i.line_amount,
         i.product_received_amount,
         i.daily_shipping_category
       from public.business_order_items i
       join filtered_orders fo on fo.id = i.order_id
       left join public.products p on p.id = i.product_id
       left join public.business_custom_product_versions cv on cv.id = i.custom_product_version_id
       left join latest_custom_groups lcg on lcg.custom_product_id = i.custom_product_id
       where (p_product_group_ids is null or array_length(p_product_group_ids, 1) is null
              or coalesce(p.group_id, lcg.product_group_id) = any (p_product_group_ids))
         and (p_shipping_categories is null or array_length(p_shipping_categories, 1) is null
              or i.daily_shipping_category::text = any (p_shipping_categories))
     )
     select
       coalesce(i.product_group_id::text, ''),
       coalesce(pg.name, '(未分组)'),
       coalesce(pg.sort_order, 0),
       count(distinct i.order_id),
       coalesce(sum(i.line_amount * coalesce(bo.exchange_rate_to_cny, 0)), 0),
       coalesce(sum(i.line_amount) filter (where bo.currency = 'USD'), 0),
       coalesce(sum(i.line_amount) filter (where bo.currency = 'CNY'), 0),
       coalesce(sum(coalesce(i.product_received_amount, 0) * coalesce(bo.exchange_rate_to_cny, 0)), 0),
       coalesce(sum(coalesce(i.product_received_amount, 0)) filter (where bo.currency = 'USD'), 0),
       coalesce(sum(coalesce(i.product_received_amount, 0)) filter (where bo.currency = 'CNY'), 0),
       coalesce(sum(
         (i.line_amount - coalesce(i.product_received_amount, 0))
         * coalesce(bo.exchange_rate_to_cny, 0)
       ), 0),
       coalesce(sum(i.line_amount - coalesce(i.product_received_amount, 0)) filter (where bo.currency = 'USD'), 0),
       coalesce(sum(i.line_amount - coalesce(i.product_received_amount, 0)) filter (where bo.currency = 'CNY'), 0),
       count(distinct i.order_id) filter (
         where bo.payment_status <> 'fully_paid'
           and bo.payment_due_date is not null
           and bo.payment_due_date < v_today
       )
     from items i
     join public.business_orders bo on bo.id = i.order_id
     left join public.product_groups pg on pg.id = i.product_group_id
     group by i.product_group_id, pg.name, pg.sort_order
     order by coalesce(sum(i.line_amount * coalesce(bo.exchange_rate_to_cny, 0)), 0) desc;

   -- 发货分类：按明细行聚合
   elsif p_group_by = 'shipping_category' then
     return query
     with latest_custom_groups as (
       select distinct on (v.custom_product_id) v.custom_product_id, v.product_group_id
       from public.business_custom_product_versions v
       order by v.custom_product_id, v.version_no desc
     ),
     filtered_orders as (
       select bo.id,
              bo.currency,
              bo.exchange_rate_to_cny,
              bo.payment_status,
              bo.payment_due_date
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
     ),
     items as (
       select i.order_id,
              i.daily_shipping_category,
              i.line_amount,
              i.product_received_amount
       from public.business_order_items i
       join filtered_orders fo on fo.id = i.order_id
       where i.daily_shipping_category is not null
         and (p_shipping_categories is null or array_length(p_shipping_categories, 1) is null
              or i.daily_shipping_category::text = any (p_shipping_categories))
     )
     select
       i.daily_shipping_category::text,
       case i.daily_shipping_category::text
         when 'custom' then '定制'
         when 'stock' then '现货'
         when 'sample' then '现货样品' when 'custom_sample' then '定制打样'
         when 'purchase' then '外采'
         else i.daily_shipping_category::text
       end,
       case i.daily_shipping_category::text
         when 'custom' then 1
         when 'stock' then 2
         when 'sample' then 3
         when 'purchase' then 4
         else 99
       end,
       count(distinct i.order_id),
       coalesce(sum(i.line_amount * coalesce(bo.exchange_rate_to_cny, 0)), 0),
       coalesce(sum(i.line_amount) filter (where bo.currency = 'USD'), 0),
       coalesce(sum(i.line_amount) filter (where bo.currency = 'CNY'), 0),
       coalesce(sum(coalesce(i.product_received_amount, 0) * coalesce(bo.exchange_rate_to_cny, 0)), 0),
       coalesce(sum(coalesce(i.product_received_amount, 0)) filter (where bo.currency = 'USD'), 0),
       coalesce(sum(coalesce(i.product_received_amount, 0)) filter (where bo.currency = 'CNY'), 0),
       coalesce(sum(
         (i.line_amount - coalesce(i.product_received_amount, 0))
         * coalesce(bo.exchange_rate_to_cny, 0)
       ), 0),
       coalesce(sum(i.line_amount - coalesce(i.product_received_amount, 0)) filter (where bo.currency = 'USD'), 0),
       coalesce(sum(i.line_amount - coalesce(i.product_received_amount, 0)) filter (where bo.currency = 'CNY'), 0),
       count(distinct i.order_id) filter (
         where bo.payment_status <> 'fully_paid'
           and bo.payment_due_date is not null
           and bo.payment_due_date < v_today
       )
     from items i
     join public.business_orders bo on bo.id = i.order_id
     group by i.daily_shipping_category
     order by case i.daily_shipping_category::text
       when 'custom' then 1
       when 'stock' then 2
       when 'sample' then 3
       when 'purchase' then 4
       else 99
     end;
   end if;
 end;
 $$;

create or replace function public.get_business_performance_by_product(
  p_source_type text,
  p_date_from date default null,
  p_date_to date default null,
  p_created_from date default null,
  p_created_to date default null,
  p_salesperson_ids uuid[] default null,
  p_shop_ids uuid[] default null,
  p_product_group_ids uuid[] default null,
  p_shipping_categories text[] default null
)
returns table (
  product_key text,
  product_name text,
  product_sku text,
  sales_quantity numeric,
  sales_amount_cny numeric,
  sales_amount_usd numeric,
  settled_sales_amount_cny numeric,
  settled_quantity numeric,
  settled_product_cost_cny numeric,
  settled_product_profit_cny numeric,
  unsettled_line_count bigint,
  missing_exchange_rate_line_count bigint
)
language sql
security definer
set search_path = public
stable
as $$
  with latest_custom_groups as (
    select distinct on (v.custom_product_id) v.custom_product_id, v.product_group_id
    from public.business_custom_product_versions v
    order by v.custom_product_id, v.version_no desc
  ),
  filtered_items as (
    select
      i.id,
      i.product_id,
      i.custom_product_id,
      i.name_snapshot,
      i.sku_snapshot,
      i.quantity,
      i.line_amount,
      bo.currency,
      fc.settlement_exchange_rate_to_cny,
      s.quantity as settled_quantity,
      s.unit_cost
    from public.business_order_items i
    join public.business_orders bo on bo.id = i.order_id
    left join public.products p on p.id = i.product_id
    left join public.business_custom_product_versions cv on cv.id = i.custom_product_version_id
    left join latest_custom_groups lcg on lcg.custom_product_id = i.custom_product_id
    left join public.finance_business_order_item_settlements s on s.business_order_item_id = i.id
    left join public.finance_business_order_commissions fc on fc.business_order_id = bo.id
    where bo.voided_at is null
      and i.source_type::text = p_source_type
      and (p_date_from is null or bo.order_date >= p_date_from)
      and (p_date_to is null or bo.order_date <= p_date_to)
      and (p_created_from is null or (bo.created_at at time zone 'Asia/Shanghai')::date >= p_created_from)
      and (p_created_to is null or (bo.created_at at time zone 'Asia/Shanghai')::date <= p_created_to)
      and (p_salesperson_ids is null or array_length(p_salesperson_ids, 1) is null
        or bo.salesperson_id = any (p_salesperson_ids))
      and (p_shop_ids is null or array_length(p_shop_ids, 1) is null
        or bo.shop_id = any (p_shop_ids))
      and (p_product_group_ids is null or array_length(p_product_group_ids, 1) is null
        or coalesce(p.group_id, lcg.product_group_id) = any (p_product_group_ids))
      and (p_shipping_categories is null or array_length(p_shipping_categories, 1) is null
        or i.daily_shipping_category::text = any (p_shipping_categories))
      and public.can_view_business_order(bo.id)
      and public.is_finance_or_admin()
  ), normalized_items as (
    select
      case
        when p_source_type = 'catalog' and product_id is not null then 'catalog:' || product_id::text
        when p_source_type = 'custom' and custom_product_id is not null then 'custom:' || custom_product_id::text
        else p_source_type || ':snapshot:' || name_snapshot || ':' || sku_snapshot
      end as product_key,
      name_snapshot as product_name,
      sku_snapshot as product_sku,
      quantity,
      line_amount,
      currency,
      settlement_exchange_rate_to_cny,
      settled_quantity,
      unit_cost
    from filtered_items
  )
  select
    product_key,
    max(product_name) as product_name,
    max(product_sku) as product_sku,
    coalesce(sum(quantity), 0) as sales_quantity,
    coalesce(sum(line_amount) filter (where currency = 'CNY'), 0) as sales_amount_cny,
    coalesce(sum(line_amount) filter (where currency = 'USD'), 0) as sales_amount_usd,
    coalesce(sum(
      line_amount * case when currency = 'USD' then settlement_exchange_rate_to_cny else 1 end
    ) filter (
      where settled_quantity is not null
        and (currency <> 'USD' or settlement_exchange_rate_to_cny is not null)
    ), 0) as settled_sales_amount_cny,
    coalesce(sum(settled_quantity) filter (
      where currency <> 'USD' or settlement_exchange_rate_to_cny is not null
    ), 0) as settled_quantity,
    coalesce(sum(unit_cost * settled_quantity) filter (
      where currency <> 'USD' or settlement_exchange_rate_to_cny is not null
    ), 0) as settled_product_cost_cny,
    coalesce(sum(
      line_amount * case when currency = 'USD' then settlement_exchange_rate_to_cny else 1 end
      - coalesce(unit_cost, 0) * settled_quantity
    ) filter (
      where settled_quantity is not null
        and (currency <> 'USD' or settlement_exchange_rate_to_cny is not null)
    ), 0) as settled_product_profit_cny,
    count(*) filter (where settled_quantity is null) as unsettled_line_count,
    count(*) filter (
      where settled_quantity is not null
        and currency = 'USD'
        and settlement_exchange_rate_to_cny is null
    ) as missing_exchange_rate_line_count
  from normalized_items
  group by product_key
  order by
    coalesce(sum(line_amount) filter (where currency = 'CNY'), 0)
      + coalesce(sum(line_amount) filter (where currency = 'USD'), 0) desc,
    max(product_name),
    max(product_sku);
$$;

create or replace function public.get_business_performance_multi_dimension(
  p_dimension_1 text default 'salesperson',
  p_dimension_2 text default null,
  p_dimension_3 text default null,
  p_date_from date default null,
  p_date_to date default null,
  p_created_from date default null,
  p_created_to date default null,
  p_salesperson_ids uuid[] default null,
  p_shop_ids uuid[] default null,
  p_product_group_ids uuid[] default null,
  p_shipping_categories text[] default null
)
returns table (
  dimension_1_key text,
  dimension_1_label text,
  dimension_2_key text,
  dimension_2_label text,
  dimension_3_key text,
  dimension_3_label text,
  order_count bigint,
  sales_quantity numeric,
  sales_amount_cny numeric,
  sales_amount_usd numeric
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if p_dimension_1 not in (
    'salesperson', 'shop', 'country', 'product', 'product_group',
    'shipping_category', 'date', 'month'
  ) then
    raise exception 'Unsupported first dimension: %', p_dimension_1;
  end if;

  if p_dimension_2 is not null and p_dimension_2 not in (
    'salesperson', 'shop', 'country', 'product', 'product_group',
    'shipping_category', 'date', 'month'
  ) then
    raise exception 'Unsupported second dimension: %', p_dimension_2;
  end if;

  if p_dimension_3 is not null and p_dimension_3 not in (
    'salesperson', 'shop', 'country', 'product', 'product_group',
    'shipping_category', 'date', 'month'
  ) then
    raise exception 'Unsupported third dimension: %', p_dimension_3;
  end if;

  if p_dimension_2 = p_dimension_1
     or p_dimension_3 = p_dimension_1
     or (p_dimension_2 is not null and p_dimension_3 = p_dimension_2) then
    raise exception 'Performance dimensions cannot repeat';
  end if;

  return query
  with latest_custom_groups as (
    select distinct on (v.custom_product_id) v.custom_product_id, v.product_group_id
    from public.business_custom_product_versions v
    order by v.custom_product_id, v.version_no desc
  ),
  base_items as (
    select
      bo.id as order_id,
      bo.salesperson_id,
      bo.shop_id,
      bo.shop_name_snapshot,
      bo.order_date,
      bo.currency,
      coalesce(nullif(btrim(c.country), ''), '') as country,
      i.product_id,
      i.custom_product_id,
      i.name_snapshot,
      i.sku_snapshot,
      i.quantity,
      i.line_amount,
      i.daily_shipping_category,
      coalesce(p.group_id, lcg.product_group_id) as product_group_id,
      pg.name as product_group_name,
      pr.chinese_name as salesperson_chinese_name,
      pr.full_name as salesperson_full_name,
      pr.email as salesperson_email
    from public.business_order_items i
    join public.business_orders bo on bo.id = i.order_id
    left join public.products p on p.id = i.product_id
    left join public.business_custom_product_versions cv on cv.id = i.custom_product_version_id
    left join latest_custom_groups lcg on lcg.custom_product_id = i.custom_product_id
    left join public.product_groups pg on pg.id = coalesce(p.group_id, lcg.product_group_id)
    left join public.customers c on c.id = bo.customer_id
    left join public.profiles pr on pr.id = bo.salesperson_id
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
        or coalesce(p.group_id, lcg.product_group_id) = any (p_product_group_ids))
      and (p_shipping_categories is null or array_length(p_shipping_categories, 1) is null
        or i.daily_shipping_category::text = any (p_shipping_categories))
      and public.can_view_business_order(bo.id)
  ), dimensioned_items as (
    select
      bi.*,
      case p_dimension_1
        when 'salesperson' then coalesce(bi.salesperson_id::text, '')
        when 'shop' then coalesce(bi.shop_id::text, '')
        when 'country' then bi.country
        when 'product' then case
          when bi.product_id is not null then 'catalog:' || bi.product_id::text
          when bi.custom_product_id is not null then 'custom:' || bi.custom_product_id::text
          else 'snapshot:' || bi.name_snapshot || ':' || bi.sku_snapshot
        end
        when 'product_group' then coalesce(bi.product_group_id::text, '')
        when 'shipping_category' then coalesce(bi.daily_shipping_category::text, '')
        when 'date' then bi.order_date::text
        when 'month' then to_char(bi.order_date, 'YYYY-MM')
      end as dimension_1_key,
      case p_dimension_1
        when 'salesperson' then coalesce(nullif(btrim(bi.salesperson_chinese_name), ''), nullif(btrim(bi.salesperson_full_name), ''), bi.salesperson_email, '(未分配)')
        when 'shop' then coalesce(nullif(btrim(bi.shop_name_snapshot), ''), '(未分配)')
        when 'country' then coalesce(nullif(bi.country, ''), '(未填写)')
        when 'product' then coalesce(nullif(btrim(bi.name_snapshot), ''), '(未命名产品)')
        when 'product_group' then coalesce(bi.product_group_name, '(未分组)')
        when 'shipping_category' then case bi.daily_shipping_category::text when 'custom' then '定制' when 'stock' then '现货' when 'sample' then '现货样品' when 'custom_sample' then '定制打样' when 'purchase' then '外采' else '(未填写)' end
        when 'date' then bi.order_date::text
        when 'month' then to_char(bi.order_date, 'YYYY-MM')
      end as dimension_1_label,
      case p_dimension_2
        when 'salesperson' then coalesce(bi.salesperson_id::text, '')
        when 'shop' then coalesce(bi.shop_id::text, '')
        when 'country' then bi.country
        when 'product' then case
          when bi.product_id is not null then 'catalog:' || bi.product_id::text
          when bi.custom_product_id is not null then 'custom:' || bi.custom_product_id::text
          else 'snapshot:' || bi.name_snapshot || ':' || bi.sku_snapshot
        end
        when 'product_group' then coalesce(bi.product_group_id::text, '')
        when 'shipping_category' then coalesce(bi.daily_shipping_category::text, '')
        when 'date' then bi.order_date::text
        when 'month' then to_char(bi.order_date, 'YYYY-MM')
      end as dimension_2_key,
      case p_dimension_2
        when 'salesperson' then coalesce(nullif(btrim(bi.salesperson_chinese_name), ''), nullif(btrim(bi.salesperson_full_name), ''), bi.salesperson_email, '(未分配)')
        when 'shop' then coalesce(nullif(btrim(bi.shop_name_snapshot), ''), '(未分配)')
        when 'country' then coalesce(nullif(bi.country, ''), '(未填写)')
        when 'product' then coalesce(nullif(btrim(bi.name_snapshot), ''), '(未命名产品)')
        when 'product_group' then coalesce(bi.product_group_name, '(未分组)')
        when 'shipping_category' then case bi.daily_shipping_category::text when 'custom' then '定制' when 'stock' then '现货' when 'sample' then '现货样品' when 'custom_sample' then '定制打样' when 'purchase' then '外采' else '(未填写)' end
        when 'date' then bi.order_date::text
        when 'month' then to_char(bi.order_date, 'YYYY-MM')
      end as dimension_2_label,
      case p_dimension_3
        when 'salesperson' then coalesce(bi.salesperson_id::text, '')
        when 'shop' then coalesce(bi.shop_id::text, '')
        when 'country' then bi.country
        when 'product' then case
          when bi.product_id is not null then 'catalog:' || bi.product_id::text
          when bi.custom_product_id is not null then 'custom:' || bi.custom_product_id::text
          else 'snapshot:' || bi.name_snapshot || ':' || bi.sku_snapshot
        end
        when 'product_group' then coalesce(bi.product_group_id::text, '')
        when 'shipping_category' then coalesce(bi.daily_shipping_category::text, '')
        when 'date' then bi.order_date::text
        when 'month' then to_char(bi.order_date, 'YYYY-MM')
      end as dimension_3_key,
      case p_dimension_3
        when 'salesperson' then coalesce(nullif(btrim(bi.salesperson_chinese_name), ''), nullif(btrim(bi.salesperson_full_name), ''), bi.salesperson_email, '(未分配)')
        when 'shop' then coalesce(nullif(btrim(bi.shop_name_snapshot), ''), '(未分配)')
        when 'country' then coalesce(nullif(bi.country, ''), '(未填写)')
        when 'product' then coalesce(nullif(btrim(bi.name_snapshot), ''), '(未命名产品)')
        when 'product_group' then coalesce(bi.product_group_name, '(未分组)')
        when 'shipping_category' then case bi.daily_shipping_category::text when 'custom' then '定制' when 'stock' then '现货' when 'sample' then '现货样品' when 'custom_sample' then '定制打样' when 'purchase' then '外采' else '(未填写)' end
        when 'date' then bi.order_date::text
        when 'month' then to_char(bi.order_date, 'YYYY-MM')
      end as dimension_3_label
    from base_items bi
  )
  select
    di.dimension_1_key,
    di.dimension_1_label,
    di.dimension_2_key,
    di.dimension_2_label,
    di.dimension_3_key,
    di.dimension_3_label,
    count(distinct di.order_id),
    coalesce(sum(di.quantity), 0),
    coalesce(sum(di.line_amount) filter (where di.currency = 'CNY'), 0),
    coalesce(sum(di.line_amount) filter (where di.currency = 'USD'), 0)
  from dimensioned_items di
  group by
    di.dimension_1_key, di.dimension_1_label,
    di.dimension_2_key, di.dimension_2_label,
    di.dimension_3_key, di.dimension_3_label
  order by
    coalesce(sum(di.line_amount) filter (where di.currency = 'CNY'), 0) desc,
    coalesce(sum(di.line_amount) filter (where di.currency = 'USD'), 0) desc,
    di.dimension_1_label, di.dimension_2_label, di.dimension_3_label;
end;
$$;

create or replace function public.get_business_performance_by_group(
  p_group_by text default 'salesperson',
  p_date_from date default null,
  p_date_to date default null,
  p_created_from date default null,
  p_created_to date default null,
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
      p_created_from,
      p_created_to,
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

drop function public.get_business_performance_by_group(
  text, date, date, uuid[], uuid[], uuid[], text[]
);
drop function public.get_business_performance_by_group_base(
  text, date, date, uuid[], uuid[], uuid[], text[]
);
drop function public.get_business_performance_summary(
  date, date, uuid[], uuid[], uuid[], text[]
);
drop function public.get_business_performance_by_product(
  text, date, date, uuid[], uuid[], uuid[], text[]
);
drop function public.get_business_performance_multi_dimension(
  text, text, text, date, date, uuid[], uuid[], uuid[], text[]
);

revoke all on function public.get_business_performance_summary(
  date, date, date, date, uuid[], uuid[], uuid[], text[]
) from public, anon, authenticated, service_role;
grant execute on function public.get_business_performance_summary(
  date, date, date, date, uuid[], uuid[], uuid[], text[]
) to authenticated, service_role;

revoke all on function public.get_business_performance_by_group_base(
  text, date, date, date, date, uuid[], uuid[], uuid[], text[]
) from public, anon, authenticated, service_role;
grant execute on function public.get_business_performance_by_group_base(
  text, date, date, date, date, uuid[], uuid[], uuid[], text[]
) to authenticated, service_role;

revoke all on function public.get_business_performance_by_group(
  text, date, date, date, date, uuid[], uuid[], uuid[], text[]
) from public, anon, authenticated, service_role;
grant execute on function public.get_business_performance_by_group(
  text, date, date, date, date, uuid[], uuid[], uuid[], text[]
) to authenticated, service_role;

revoke all on function public.get_business_performance_by_product(
  text, date, date, date, date, uuid[], uuid[], uuid[], text[]
) from public, anon, authenticated, service_role;
grant execute on function public.get_business_performance_by_product(
  text, date, date, date, date, uuid[], uuid[], uuid[], text[]
) to authenticated, service_role;

revoke all on function public.get_business_performance_multi_dimension(
  text, text, text, date, date, date, date, uuid[], uuid[], uuid[], text[]
) from public, anon, authenticated, service_role;
grant execute on function public.get_business_performance_multi_dimension(
  text, text, text, date, date, date, date, uuid[], uuid[], uuid[], text[]
) to authenticated, service_role;

commit;
