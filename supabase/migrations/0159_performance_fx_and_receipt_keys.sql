-- 0159 业务业绩：币种换算修正 + 日期 / 月份按实际收款日归行
--
-- 一、币种换算（summary / by_group_base / by_group 三个 RPC）
--   1. 分摊金额折人民币按「转账币种」：CNY 记 1，其余取转账登记汇率；
--   2. 订单本币口径的已收 / 未收改为同币种分摊直接取原值，不再依赖订单
--      汇率（USD 订单汇率留空时，原算法把分摊静默算成 0）；
--   3. 订单金额折人民币按「CNY 记 1，其余取订单汇率」，为空仍记 0。
--   数据侧回填 7 笔缺失汇率的 USD 转账（6.70，与历史两笔一致）。
-- 二、日期 / 月份分组：已收按实际收款日归行
--   建单录入的实收归下单日；转账分摊归转账收款日（上海时区）。订单数、
--   订单总额、未收、逾期仍按订单归属行（下单日期），合计口径与汇总卡一致。
--
-- by_product / multi_dimension 不涉及以上口径，保持不动。

begin;


create or replace function public.get_business_performance_summary(
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
            coalesce(sum(a.amount * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end))
              filter (where a.voided_at is null and t.voided_at is null), 0) as allocated_cny,
            coalesce(sum(
              case
                when t.currency = bo.currency then a.amount
                when bo.currency = 'CNY' then a.amount
                  * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end)
                when t.currency = 'CNY' then a.amount
                  / nullif(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
                else a.amount
                  * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end)
                  / nullif(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
              end
            ) filter (where a.voided_at is null and t.voided_at is null), 0) as allocated_native,
            coalesce(sum(a.amount * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end))
              filter (where a.voided_at is null and t.voided_at is null
                and (p_received_from is null or (t.received_at at time zone 'Asia/Shanghai')::date >= p_received_from)
                and (p_received_to is null or (t.received_at at time zone 'Asia/Shanghai')::date <= p_received_to)), 0) as allocated_cny_period,
            coalesce(sum(
              case
                when t.currency = bo.currency then a.amount
                when bo.currency = 'CNY' then a.amount
                  * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end)
                when t.currency = 'CNY' then a.amount
                  / nullif(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
                else a.amount
                  * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end)
                  / nullif(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
              end
            ) filter (where a.voided_at is null and t.voided_at is null
              and (p_received_from is null or (t.received_at at time zone 'Asia/Shanghai')::date >= p_received_from)
              and (p_received_to is null or (t.received_at at time zone 'Asia/Shanghai')::date <= p_received_to)), 0) as allocated_native_period
     from orders_matching_shipping oms
     join public.business_orders bo on bo.id = oms.id
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
       case
         when (p_received_from is null or bo.order_date >= p_received_from)
           and (p_received_to is null or bo.order_date <= p_received_to)
         then coalesce(bo.total_sales_amount, 0) * coalesce(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
         else 0
       end
         + coalesce(a.allocated_cny_period, 0) as received_cny,
       greatest(
         (bo.total_amount - coalesce(bo.total_sales_amount, 0)) * coalesce(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
         - coalesce(a.allocated_cny, 0),
         0
       ) as outstanding_cny,
       case
         when (p_received_from is null or bo.order_date >= p_received_from)
           and (p_received_to is null or bo.order_date <= p_received_to)
         then coalesce(bo.total_sales_amount, 0)
         else 0
       end
         + coalesce(a.allocated_native_period, 0) as received_amount,
       greatest(
         bo.total_amount
         - coalesce(bo.total_sales_amount, 0)
         - coalesce(a.allocated_native, 0),
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
              coalesce(sum(a.amount * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end))
                filter (where a.voided_at is null and t.voided_at is null), 0) as allocated_cny,
              coalesce(sum(
                case
                  when t.currency = bo.currency then a.amount
                  when bo.currency = 'CNY' then a.amount
                    * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end)
                  when t.currency = 'CNY' then a.amount
                    / nullif(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
                  else a.amount
                    * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end)
                    / nullif(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
                end
              ) filter (where a.voided_at is null and t.voided_at is null), 0) as allocated_native,
              coalesce(sum(a.amount * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end))
                filter (where a.voided_at is null and t.voided_at is null
                  and (p_received_from is null or (t.received_at at time zone 'Asia/Shanghai')::date >= p_received_from)
                  and (p_received_to is null or (t.received_at at time zone 'Asia/Shanghai')::date <= p_received_to)), 0) as allocated_cny_period,
              coalesce(sum(
                case
                  when t.currency = bo.currency then a.amount
                  when bo.currency = 'CNY' then a.amount
                    * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end)
                  when t.currency = 'CNY' then a.amount
                    / nullif(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
                  else a.amount
                    * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end)
                    / nullif(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
                end
              ) filter (where a.voided_at is null and t.voided_at is null
                and (p_received_from is null or (t.received_at at time zone 'Asia/Shanghai')::date >= p_received_from)
                and (p_received_to is null or (t.received_at at time zone 'Asia/Shanghai')::date <= p_received_to)), 0) as allocated_native_period
       from orders_matching_shipping oms
       join public.business_orders bo on bo.id = oms.id
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
         case
           when (p_received_from is null or bo.order_date >= p_received_from)
             and (p_received_to is null or bo.order_date <= p_received_to)
           then coalesce(bo.total_sales_amount, 0) * coalesce(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
           else 0
         end
           + coalesce(a.allocated_cny_period, 0) as received_cny,
         greatest(
           (bo.total_amount - coalesce(bo.total_sales_amount, 0)) * coalesce(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
           - coalesce(a.allocated_cny, 0),
           0
         ) as outstanding_cny,
         case
           when (p_received_from is null or bo.order_date >= p_received_from)
             and (p_received_to is null or bo.order_date <= p_received_to)
           then coalesce(bo.total_sales_amount, 0)
           else 0
         end
           + coalesce(a.allocated_native_period, 0) as received_amount,
         greatest(
           bo.total_amount
           - coalesce(bo.total_sales_amount, 0)
           - coalesce(a.allocated_native, 0),
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
              coalesce(sum(a.amount * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end))
                filter (where a.voided_at is null and t.voided_at is null), 0) as allocated_cny,
              coalesce(sum(
                case
                  when t.currency = bo.currency then a.amount
                  when bo.currency = 'CNY' then a.amount
                    * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end)
                  when t.currency = 'CNY' then a.amount
                    / nullif(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
                  else a.amount
                    * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end)
                    / nullif(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
                end
              ) filter (where a.voided_at is null and t.voided_at is null), 0) as allocated_native,
              coalesce(sum(a.amount * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end))
                filter (where a.voided_at is null and t.voided_at is null
                  and (p_received_from is null or (t.received_at at time zone 'Asia/Shanghai')::date >= p_received_from)
                  and (p_received_to is null or (t.received_at at time zone 'Asia/Shanghai')::date <= p_received_to)), 0) as allocated_cny_period,
              coalesce(sum(
                case
                  when t.currency = bo.currency then a.amount
                  when bo.currency = 'CNY' then a.amount
                    * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end)
                  when t.currency = 'CNY' then a.amount
                    / nullif(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
                  else a.amount
                    * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end)
                    / nullif(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
                end
              ) filter (where a.voided_at is null and t.voided_at is null
                and (p_received_from is null or (t.received_at at time zone 'Asia/Shanghai')::date >= p_received_from)
                and (p_received_to is null or (t.received_at at time zone 'Asia/Shanghai')::date <= p_received_to)), 0) as allocated_native_period
       from orders_matching_shipping oms
       join public.business_orders bo on bo.id = oms.id
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
         case
           when (p_received_from is null or bo.order_date >= p_received_from)
             and (p_received_to is null or bo.order_date <= p_received_to)
           then coalesce(bo.total_sales_amount, 0) * coalesce(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
           else 0
         end
           + coalesce(a.allocated_cny_period, 0) as received_cny,
         greatest(
           (bo.total_amount - coalesce(bo.total_sales_amount, 0)) * coalesce(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
           - coalesce(a.allocated_cny, 0),
           0
         ) as outstanding_cny,
         case
           when (p_received_from is null or bo.order_date >= p_received_from)
             and (p_received_to is null or bo.order_date <= p_received_to)
           then coalesce(bo.total_sales_amount, 0)
           else 0
         end
           + coalesce(a.allocated_native_period, 0) as received_amount,
         greatest(
           bo.total_amount
           - coalesce(bo.total_sales_amount, 0)
           - coalesce(a.allocated_native, 0),
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

   -- 日期 / 月份：已收按实际收款日归行
   --   - 下单金额类指标（订单数 / 订单总额 / 未收 / 逾期）仍按订单归属行（下单日期）
   --   - 已收拆成两部分：建单录入的实收归下单日；登记转账形成的分摊归转账收款日
   --   同一订单可能出现在多个月份，各月只承担落在本月的已收部分，合计口径不变。
   elsif p_group_by in ('date', 'month') then
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
     allocation_rows as (
       select oms.id as order_id,
              (t.received_at at time zone 'Asia/Shanghai')::date as received_date,
              bo.currency as order_currency,
              case
                when t.currency = bo.currency then a.amount
                when bo.currency = 'CNY' then a.amount
                     * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end)
                when t.currency = 'CNY' then a.amount
                     / nullif(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
                else a.amount
                     * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end)
                     / nullif(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
              end as amount_native,
              a.amount
                * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end) as amount_cny
       from orders_matching_shipping oms
       join public.business_orders bo on bo.id = oms.id
       join public.business_order_payment_allocations a
         on a.order_id = oms.id and a.voided_at is null
       join public.business_customer_transfers t
         on t.id = a.transfer_id and t.voided_at is null
     ),
     allocations as (
       select order_id,
              coalesce(sum(amount_cny), 0) as allocated_cny,
              coalesce(sum(amount_native), 0) as allocated_native
       from allocation_rows
       group by order_id
     ),
     order_amounts as (
       select oms.id,
              oms.order_date,
              bo.currency,
              bo.total_amount,
              bo.total_cny,
              bo.total_sales_amount,
              bo.payment_status,
              bo.payment_due_date,
              greatest(
                (bo.total_amount - coalesce(bo.total_sales_amount, 0))
                * coalesce(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
                - coalesce(a.allocated_cny, 0),
                0
              ) as outstanding_cny,
              greatest(
                bo.total_amount
                - coalesce(bo.total_sales_amount, 0)
                - coalesce(a.allocated_native, 0),
                0
              ) as outstanding_amount
       from orders_matching_shipping oms
       join public.business_orders bo on bo.id = oms.id
       left join allocations a on a.order_id = oms.id
     ),
     row_parts as (
       select oa.order_date as row_date,
              oa.id as order_id,
              1 as is_order,
              oa.currency,
              oa.total_amount,
              oa.total_cny,
              oa.payment_status,
              oa.payment_due_date,
              oa.outstanding_cny,
              oa.outstanding_amount,
              0::numeric as received_cny,
              0::numeric as received_amount
       from order_amounts oa
       union all
       select ar.received_date,
              ar.order_id,
              0,
              ar.order_currency,
              0,
              0,
              null::text,
              null::date,
              0,
              0,
              coalesce(ar.amount_cny, 0),
              coalesce(ar.amount_native, 0)
       from allocation_rows ar
       where (p_received_from is null or ar.received_date >= p_received_from)
         and (p_received_to is null or ar.received_date <= p_received_to)
       union all
       select bo.order_date,
              bo.id,
              0,
              bo.currency,
              0,
              0,
              null::text,
              null::date,
              0,
              0,
              case
                when (p_received_from is null or bo.order_date >= p_received_from)
                  and (p_received_to is null or bo.order_date <= p_received_to)
                then coalesce(bo.total_sales_amount, 0)
                  * coalesce(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
                else 0
              end,
              case
                when (p_received_from is null or bo.order_date >= p_received_from)
                  and (p_received_to is null or bo.order_date <= p_received_to)
                then coalesce(bo.total_sales_amount, 0)
                else 0
              end
       from orders_matching_shipping oms
       join public.business_orders bo on bo.id = oms.id
       where coalesce(bo.total_sales_amount, 0) <> 0
     )
     select
       case when p_group_by = 'month' then to_char(rp.row_date, 'YYYY-MM') else rp.row_date::text end,
       case when p_group_by = 'month' then to_char(rp.row_date, 'YYYY-MM') else rp.row_date::text end,
       0,
       count(distinct rp.order_id) filter (where rp.is_order = 1),
       coalesce(sum(rp.total_cny), 0),
       coalesce(sum(rp.total_amount) filter (where rp.currency = 'USD'), 0),
       coalesce(sum(rp.total_amount) filter (where rp.currency = 'CNY'), 0),
       coalesce(sum(rp.received_cny), 0),
       coalesce(sum(rp.received_amount) filter (where rp.currency = 'USD'), 0),
       coalesce(sum(rp.received_amount) filter (where rp.currency = 'CNY'), 0),
       coalesce(sum(rp.outstanding_cny), 0),
       coalesce(sum(rp.outstanding_amount) filter (where rp.currency = 'USD'), 0),
       coalesce(sum(rp.outstanding_amount) filter (where rp.currency = 'CNY'), 0),
       count(distinct rp.order_id) filter (
         where rp.is_order = 1
           and rp.payment_status <> 'fully_paid'
           and rp.payment_due_date is not null
           and rp.payment_due_date < v_today
       )
     from row_parts rp
     group by case when p_group_by = 'month' then to_char(rp.row_date, 'YYYY-MM') else rp.row_date::text end
     order by case when p_group_by = 'month' then to_char(rp.row_date, 'YYYY-MM') else rp.row_date::text end;


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
       coalesce(sum(
         case when (p_received_from is null or bo.order_date >= p_received_from)
               and (p_received_to is null or bo.order_date <= p_received_to)
           then coalesce(i.product_received_amount, 0) * coalesce(bo.exchange_rate_to_cny, 0)
           else 0 end
         ), 0),
       coalesce(sum(
         case when (p_received_from is null or bo.order_date >= p_received_from)
               and (p_received_to is null or bo.order_date <= p_received_to)
           then coalesce(i.product_received_amount, 0)
           else 0 end
         ) filter (where bo.currency = 'USD'), 0),
       coalesce(sum(
         case when (p_received_from is null or bo.order_date >= p_received_from)
               and (p_received_to is null or bo.order_date <= p_received_to)
           then coalesce(i.product_received_amount, 0)
           else 0 end
         ) filter (where bo.currency = 'CNY'), 0),
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
       coalesce(sum(
         case when (p_received_from is null or bo.order_date >= p_received_from)
               and (p_received_to is null or bo.order_date <= p_received_to)
           then coalesce(i.product_received_amount, 0) * coalesce(bo.exchange_rate_to_cny, 0)
           else 0 end
         ), 0),
       coalesce(sum(
         case when (p_received_from is null or bo.order_date >= p_received_from)
               and (p_received_to is null or bo.order_date <= p_received_to)
           then coalesce(i.product_received_amount, 0)
           else 0 end
         ) filter (where bo.currency = 'USD'), 0),
       coalesce(sum(
         case when (p_received_from is null or bo.order_date >= p_received_from)
               and (p_received_to is null or bo.order_date <= p_received_to)
           then coalesce(i.product_received_amount, 0)
           else 0 end
         ) filter (where bo.currency = 'CNY'), 0),
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

create or replace function public.get_business_performance_by_group(
  p_group_by text default 'salesperson',
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
      p_received_from,
      p_received_to,
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
      bo.order_date,
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
      coalesce(sum(a.amount * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end))
        filter (where a.voided_at is null and t.voided_at is null), 0) as allocated_cny,
      coalesce(sum(
        case
          when t.currency = bo.currency then a.amount
          when bo.currency = 'CNY' then a.amount
            * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end)
          when t.currency = 'CNY' then a.amount
            / nullif(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
          else a.amount
            * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end)
            / nullif(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
        end
      ) filter (where a.voided_at is null and t.voided_at is null), 0) as allocated_native,
      coalesce(sum(a.amount * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end))
        filter (where a.voided_at is null and t.voided_at is null
          and (p_received_from is null or (t.received_at at time zone 'Asia/Shanghai')::date >= p_received_from)
          and (p_received_to is null or (t.received_at at time zone 'Asia/Shanghai')::date <= p_received_to)), 0) as allocated_cny_period,
      coalesce(sum(
        case
          when t.currency = bo.currency then a.amount
          when bo.currency = 'CNY' then a.amount
            * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end)
          when t.currency = 'CNY' then a.amount
            / nullif(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
          else a.amount
            * (case when t.currency = 'CNY' then 1 else t.exchange_rate_to_cny end)
            / nullif(case when bo.currency = 'CNY' then 1 else bo.exchange_rate_to_cny end, 0)
        end
      ) filter (where a.voided_at is null and t.voided_at is null
        and (p_received_from is null or (t.received_at at time zone 'Asia/Shanghai')::date >= p_received_from)
        and (p_received_to is null or (t.received_at at time zone 'Asia/Shanghai')::date <= p_received_to)), 0) as allocated_native_period
    from orders_matching_shipping oms
    join public.business_orders bo on bo.id = oms.id
    left join public.business_order_payment_allocations a on a.order_id = oms.id
    left join public.business_customer_transfers t on t.id = a.transfer_id
    group by oms.id
  ),
  order_amounts as (
    select
      oms.*,
      case
        when (p_received_from is null or oms.order_date >= p_received_from)
          and (p_received_to is null or oms.order_date <= p_received_to)
        then coalesce(oms.total_sales_amount, 0) * coalesce(case when oms.currency = 'CNY' then 1 else oms.exchange_rate_to_cny end, 0)
        else 0
      end
        + coalesce(a.allocated_cny_period, 0) as received_cny,
      greatest(
        (oms.total_amount - coalesce(oms.total_sales_amount, 0)) * coalesce(case when oms.currency = 'CNY' then 1 else oms.exchange_rate_to_cny end, 0)
        - coalesce(a.allocated_cny, 0),
        0
      ) as outstanding_cny,
      case
        when (p_received_from is null or oms.order_date >= p_received_from)
          and (p_received_to is null or oms.order_date <= p_received_to)
        then coalesce(oms.total_sales_amount, 0)
        else 0
      end
        + coalesce(a.allocated_native_period, 0) as received_amount,
      greatest(
        oms.total_amount
        - coalesce(oms.total_sales_amount, 0)
        - coalesce(a.allocated_native, 0),
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

drop function if exists public.get_business_performance_summary(
  date, date, date, date, uuid[], uuid[], uuid[], text[]
);
drop function if exists public.get_business_performance_by_group_base(
  text, date, date, date, date, uuid[], uuid[], uuid[], text[]
);
drop function if exists public.get_business_performance_by_group(
  text, date, date, date, date, uuid[], uuid[], uuid[], text[]
);

revoke all on function public.get_business_performance_summary(
  date, date, date, date, date, date, uuid[], uuid[], uuid[], text[]
) from public, anon, authenticated, service_role;
grant execute on function public.get_business_performance_summary(
  date, date, date, date, date, date, uuid[], uuid[], uuid[], text[]
) to authenticated, service_role;

revoke all on function public.get_business_performance_by_group_base(
  text, date, date, date, date, date, date, uuid[], uuid[], uuid[], text[]
) from public, anon, authenticated, service_role;
grant execute on function public.get_business_performance_by_group_base(
  text, date, date, date, date, date, date, uuid[], uuid[], uuid[], text[]
) to authenticated, service_role;

revoke all on function public.get_business_performance_by_group(
  text, date, date, date, date, date, date, uuid[], uuid[], uuid[], text[]
) from public, anon, authenticated, service_role;
grant execute on function public.get_business_performance_by_group(
  text, date, date, date, date, date, date, uuid[], uuid[], uuid[], text[]
) to authenticated, service_role;

-- 回填 USD 转账缺失的汇率（与历史两笔 USD 转账一致，统一 6.70）
-- 挂已作废订单的转账由守卫触发器保护，跳过（作废订单不参与业绩口径）
update public.business_customer_transfers t
set exchange_rate_to_cny = 6.70000000,
    updated_at = now()
where t.voided_at is null
  and t.currency = 'USD'
  and t.exchange_rate_to_cny is null
  and (t.order_id is null
       or not exists (
         select 1
         from public.business_orders bo
         where bo.id = t.order_id
           and bo.voided_at is not null
       ));

commit;
