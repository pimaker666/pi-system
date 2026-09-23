-- 0069 业务业绩看板按产品分组统计
--
-- 背景：财务需要按“产品分组”维度查看业绩，而不是原来的“订单属性”。
-- 方案：
--   1. 移除 get_business_performance_summary / get_business_performance_by_group
--      中的 fulfillment_type 过滤参数，改为 p_product_group_ids。
--   2. 新增 group_by = 'product_group'，按明细行的产品分组聚合。
--   3. 产品分组同时覆盖普通产品（products.product_group_id）和定制产品
--      （business_custom_product_versions.product_group_id）。

begin;

-- 清理旧签名
 drop function if exists public.get_business_performance_summary(
   date, date, uuid[], uuid[], text[], text[]
 );
 drop function if exists public.get_business_performance_summary(
   date, date, uuid[], uuid[], uuid[], text[]
 );

 create or replace function public.get_business_performance_summary(
   p_date_from date default null,
   p_date_to date default null,
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
   with filtered_orders as (
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

 revoke all on function public.get_business_performance_summary(
   date, date, uuid[], uuid[], uuid[], text[]
 ) from public, anon, authenticated, service_role;
 grant execute on function public.get_business_performance_summary(
   date, date, uuid[], uuid[], uuid[], text[]
 ) to authenticated, service_role;

 drop function if exists public.get_business_performance_by_group(
   text, date, date, uuid[], uuid[], text[], text[]
 );
 drop function if exists public.get_business_performance_by_group(
   text, date, date, uuid[], uuid[], uuid[], text[]
 );

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
   if p_group_by not in ('salesperson', 'shop', 'date', 'month', 'product_group', 'shipping_category') then
     raise exception 'Unsupported group_by: %', p_group_by;
   end if;

   -- 业务
   if p_group_by = 'salesperson' then
     return query
     with filtered_orders as (
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
     with filtered_orders as (
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
     with filtered_orders as (
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
     with filtered_orders as (
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
     with filtered_orders as (
       select bo.id,
              bo.currency,
              bo.exchange_rate_to_cny,
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
         and public.can_view_business_order(bo.id)
     ),
     items as (
       select
         i.order_id,
         cv.product_group_id,
         i.line_amount,
         i.product_received_amount,
         i.daily_shipping_category
       from public.business_order_items i
       join filtered_orders fo on fo.id = i.order_id
       left join public.products p on p.id = i.product_id
       left join public.business_custom_product_versions cv on cv.id = i.custom_product_version_id
       where (p_product_group_ids is null or array_length(p_product_group_ids, 1) is null
              or cv.product_group_id = any (p_product_group_ids))
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
     with filtered_orders as (
       select bo.id,
              bo.currency,
              bo.exchange_rate_to_cny,
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
         when 'sample' then '样品'
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

 revoke all on function public.get_business_performance_by_group(
   text, date, date, uuid[], uuid[], uuid[], text[]
 ) from public, anon, authenticated, service_role;
 grant execute on function public.get_business_performance_by_group(
   text, date, date, uuid[], uuid[], uuid[], text[]
 ) to authenticated, service_role;

 commit;
