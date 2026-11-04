-- 0138 每日订单台账：汇总下推 SQL + 分页 id 下发
--
-- 背景：台账原先为了算 5 张汇总卡，必须先把最多 500 单连同附件/发货/退货/分摊
-- 全部取回，再在 JS 里求和；首屏整条重查询链路要跑完才出第一屏。
-- 这里把「基础筛选 + 后过滤（完成/尾款/结算/提成结清）」一次算完，返回：
--   * 每个币种的 5 项汇总金额（口径与 businessDailyOrderTotals 一致）
--   * 筛选后的订单数（保留 500 单展示上限）
--   * 指定页的订单 id（页面只按 id 取这一页 50 单的明细）
--
-- 口径要点：
--   * 实收 = 订单声明的三项总额（未填回落到明细小计 / 运费 / 订单金额）
--     + 有效分摊（allocation_target 为 item / shipping，作废分摊与作废转账剔除）
--   * 未收尾款与 get_business_orders_outstanding_amount 一致：
--     total_amount - coalesce(total_sales_amount, 0) - 全部分摊，下限 0
--   * 结算/提成结清按订单全部明细行判定；没有明细行的订单视为未结清
--   * 可见范围与 business_orders 的 RLS（can_view_business_order）一致
--   * 记录状态、关键字（表头字段 OR 产品名/SKU）等筛选与 buildLedgerQuery 对齐

begin;

create or replace function public.get_business_daily_order_ledger(
  p_date_from date default null,
  p_date_to date default null,
  p_shops uuid[] default '{}',
  p_shop_groups uuid[] default '{}',
  p_salespeople uuid[] default '{}',
  p_record_statuses text[] default '{}',
  p_payments text[] default '{}',
  p_customer_bindings text[] default '{}',
  p_fulfillments text[] default '{}',
  p_completions text[] default '{}',
  p_balance_statuses text[] default '{}',
  p_settlement_statuses text[] default '{}',
  p_commission_statuses text[] default '{}',
  p_categories text[] default '{}',
  p_marked_only boolean default false,
  p_keyword text default null,
  p_page integer default 1,
  p_page_size integer default 50
)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
with viewer as (
  select p.id, p.status::text as status, p.role::text as role
  from public.profiles p
  where p.id = (select auth.uid())
),
f as (
  select
    coalesce(p_shops, '{}'::uuid[]) as shops,
    coalesce(p_shop_groups, '{}'::uuid[]) as shop_groups,
    coalesce(p_salespeople, '{}'::uuid[]) as salespeople,
    coalesce(p_record_statuses, '{}'::text[]) as record_statuses,
    coalesce(p_payments, '{}'::text[]) as payments,
    coalesce(p_customer_bindings, '{}'::text[]) as customer_bindings,
    coalesce(p_fulfillments, '{}'::text[]) as fulfillments,
    coalesce(p_completions, '{}'::text[]) as completions,
    coalesce(p_balance_statuses, '{}'::text[]) as balance_statuses,
    coalesce(p_settlement_statuses, '{}'::text[]) as settlement_statuses,
    coalesce(p_commission_statuses, '{}'::text[]) as commission_statuses,
    coalesce(p_categories, '{}'::text[]) as categories,
    coalesce(p_marked_only, false) as marked_only,
    nullif(btrim(coalesce(p_keyword, '')), '') as keyword,
    -- 「完成」基础条件下推：旧查询只在唯一勾选「已完成」时加 fulfillment_status='fully_shipped'
    (coalesce(array_length(p_completions, 1), 0) = 1
      and (coalesce(p_completions, '{}'::text[]))[1] = 'completed') as only_completed,
    ('completed' = any(coalesce(p_completions, '{}'::text[]))) as want_completed,
    ('incomplete' = any(coalesce(p_completions, '{}'::text[]))) as want_incomplete,
    ('settled' = any(coalesce(p_balance_statuses, '{}'::text[]))) as balance_want_settled,
    ('unsettled' = any(coalesce(p_balance_statuses, '{}'::text[]))) as balance_want_unsettled,
    ('settled' = any(coalesce(p_settlement_statuses, '{}'::text[]))) as settlement_want_settled,
    ('unsettled' = any(coalesce(p_settlement_statuses, '{}'::text[]))) as settlement_want_unsettled,
    ('cleared' = any(coalesce(p_commission_statuses, '{}'::text[]))) as clearance_want_cleared,
    ('uncleared' = any(coalesce(p_commission_statuses, '{}'::text[]))) as clearance_want_uncleared,
    ('bound' = any(coalesce(p_customer_bindings, '{}'::text[]))) as want_bound,
    ('unbound' = any(coalesce(p_customer_bindings, '{}'::text[]))) as want_unbound
),
scored as (
  select
    bo.id,
    bo.order_date,
    bo.created_at,
    bo.currency::text as currency,
    bo.fulfillment_status as fulfillment_status,
    bo.total_amount as receivable,
    round(
      coalesce(bo.total_product_received_amount, bo.items_subtotal) + pay.item_alloc,
      4
    ) as product_received,
    round(
      coalesce(bo.total_shipping_received_amount, bo.shipping_fee) + pay.shipping_alloc,
      4
    ) as shipping_received,
    round(
      coalesce(bo.total_sales_amount, bo.total_amount) + pay.item_alloc + pay.shipping_alloc,
      4
    ) as sales_total,
    greatest(
      bo.total_amount - coalesce(bo.total_sales_amount, 0) - pay.total_alloc,
      0
    ) as outstanding
  from public.business_orders bo
  cross join viewer v
  cross join f
  left join public.customers c on c.id = bo.customer_id
  left join lateral (
    select
      coalesce(sum(a.amount) filter (
        where a.allocation_target = 'item' and a.order_item_id is not null
      ), 0) as item_alloc,
      coalesce(sum(a.amount) filter (
        where a.allocation_target = 'shipping'
      ), 0) as shipping_alloc,
      coalesce(sum(a.amount), 0) as total_alloc
    from public.business_order_payment_allocations a
    join public.business_customer_transfers t on t.id = a.transfer_id
    where a.order_id = bo.id
      and a.voided_at is null
      and t.voided_at is null
  ) pay on true
  where v.status = 'approved'
    and (
      v.role in ('admin', 'finance')
      or bo.salesperson_id = v.id
      or public.is_my_subordinate(bo.salesperson_id)
      or c.created_by = v.id
      or public.is_my_subordinate(c.created_by)
    )
    and (p_date_from is null or bo.order_date >= p_date_from)
    and (p_date_to is null or bo.order_date <= p_date_to)
    and (array_length(f.shops, 1) is null or bo.shop_id = any(f.shops))
    and (array_length(f.shop_groups, 1) is null or bo.shop_group_id = any(f.shop_groups))
    and (array_length(f.salespeople, 1) is null or bo.salesperson_id = any(f.salespeople))
    -- 记录状态：正常（含特殊关闭）/ 仅特殊关闭 / 仅已作废，多选取并集
    and (
      array_length(f.record_statuses, 1) is null
      or (('active' = any(f.record_statuses)) and ('voided' = any(f.record_statuses)))
      or (('active' = any(f.record_statuses)) and bo.voided_at is null)
      or (('special_closed' = any(f.record_statuses)) and ('voided' = any(f.record_statuses))
          and not ('active' = any(f.record_statuses))
          and (bo.closed_at is not null or bo.voided_at is not null))
      or (('special_closed' = any(f.record_statuses)) and not ('active' = any(f.record_statuses))
          and not ('voided' = any(f.record_statuses))
          and bo.voided_at is null and bo.closed_at is not null)
      or (not ('active' = any(f.record_statuses))
          and not ('special_closed' = any(f.record_statuses))
          and bo.voided_at is not null)
    )
    and (array_length(f.payments, 1) is null
         or bo.daily_payment_category::text = any(f.payments))
    and (
      f.want_bound = f.want_unbound
      or (f.want_bound and bo.customer_id is not null)
      or (f.want_unbound and bo.customer_id is null)
    )
    and (array_length(f.fulfillments, 1) is null
         or bo.fulfillment_status = any(f.fulfillments))
    and (not f.only_completed or bo.fulfillment_status = 'fully_shipped')
    and (array_length(f.categories, 1) is null
         or exists (
           select 1 from public.business_order_items i
           where i.order_id = bo.id
             and i.daily_shipping_category::text = any(f.categories)
         ))
    and (not f.marked_only
         or exists (
           select 1 from public.business_order_marks m
           where m.order_id = bo.id and m.user_id = v.id
         ))
    and (
      f.keyword is null
      or bo.order_number ilike '%' || f.keyword || '%'
      or bo.external_order_number ilike '%' || f.keyword || '%'
      or bo.daily_shipping_number ilike '%' || f.keyword || '%'
      or bo.payment_account ilike '%' || f.keyword || '%'
      or bo.tracking_number ilike '%' || f.keyword || '%'
      or exists (
        select 1 from public.business_order_items i
        where i.order_id = bo.id
          and (i.name_snapshot ilike '%' || f.keyword || '%'
               or i.sku_snapshot ilike '%' || f.keyword || '%')
      )
    )
),
filtered as (
  select s.*
  from scored s
  cross join f
  where
    -- 完成：全部发货且已收齐；两选项都选或都不选视为不过滤
    (f.want_completed = f.want_incomplete
      or (s.fulfillment_status = 'fully_shipped' and s.outstanding <= 0) = f.want_completed)
    -- 尾款：已收齐 outstanding = 0
    and (f.balance_want_settled = f.balance_want_unsettled
         or (s.outstanding = 0) = f.balance_want_settled)
    -- 结算：订单全部明细行都已结算
    and (f.settlement_want_settled = f.settlement_want_unsettled
         or (
           exists (select 1 from public.business_order_items i where i.order_id = s.id)
           and not exists (
             select 1 from public.business_order_items i
             where i.order_id = s.id
               and not exists (
                 select 1 from public.finance_business_order_item_settlements st
                 where st.business_order_item_id = i.id
               )
           )
         ) = f.settlement_want_settled)
    -- 提成结清：订单全部明细行都已 confirmed
    and (f.clearance_want_cleared = f.clearance_want_uncleared
         or (
           exists (select 1 from public.business_order_items i where i.order_id = s.id)
           and not exists (
             select 1 from public.business_order_items i
             where i.order_id = s.id
               and not exists (
                 select 1 from public.finance_business_order_item_commission_clearances cc
                 where cc.business_order_item_id = i.id and cc.status = 'confirmed'
               )
           )
         ) = f.clearance_want_cleared)
),
limited as (
  -- 展示上限 500 单，与 BUSINESS_DAILY_LEDGER_LIMIT 保持一致
  select *
  from filtered
  order by order_date desc, created_at desc, id desc
  limit 500
),
counted as (
  select count(*)::int as total_count from limited
),
page_params as (
  -- 页码收敛到 [1, 总页数]，与页面把越界 page 夹到末页的行为一致
  select
    c.total_count,
    least(
      greatest(coalesce(p_page, 1), 1),
      greatest(
        ceil(c.total_count::numeric
          / least(greatest(coalesce(p_page_size, 50), 1), 200)),
        1
      )
    )::int as page,
    least(greatest(coalesce(p_page_size, 50), 1), 200) as page_size
  from counted c
)
select jsonb_build_object(
  'totalCount', (select total_count from page_params),
  'page', (select page from page_params),
  'pageSize', (select page_size from page_params),
  'orderIds', coalesce(
    (
      select jsonb_agg(page.id)
      from (
        select id
        from limited
        order by order_date desc, created_at desc, id desc
        offset ((select page from page_params) - 1) * (select page_size from page_params)
        limit (select page_size from page_params)
      ) page
    ),
    '[]'::jsonb
  ),
  'currencies', coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'currency', t.currency,
          'receivable', t.receivable,
          'productReceived', t.product_received,
          'shippingReceived', t.shipping_received,
          'salesTotal', t.sales_total,
          'outstanding', t.outstanding
        )
        order by t.currency
      )
      from (
        select
          currency,
          sum(receivable) as receivable,
          sum(product_received) as product_received,
          sum(shipping_received) as shipping_received,
          sum(sales_total) as sales_total,
          sum(outstanding) as outstanding
        from limited
        group by currency
      ) t
    ),
    '[]'::jsonb
  )
);
$$;

comment on function public.get_business_daily_order_ledger(
  date, date, uuid[], uuid[], uuid[], text[], text[], text[], text[], text[],
  text[], text[], text[], text[], boolean, text, integer, integer
) is
  '每日订单台账汇总：按币种返回 5 项金额、筛选后订单数与指定页订单 id；口径与台账页面一致。';

revoke all on function public.get_business_daily_order_ledger(
  date, date, uuid[], uuid[], uuid[], text[], text[], text[], text[], text[],
  text[], text[], text[], text[], boolean, text, integer, integer
) from public, anon, authenticated, service_role;

grant execute on function public.get_business_daily_order_ledger(
  date, date, uuid[], uuid[], uuid[], text[], text[], text[], text[], text[],
  text[], text[], text[], text[], boolean, text, integer, integer
) to authenticated;

commit;

notify pgrst, 'reload schema';
