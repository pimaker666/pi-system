-- 0082 业务业绩多维销售总览

begin;

create or replace function public.get_business_performance_multi_dimension(
  p_dimension_1 text default 'salesperson',
  p_dimension_2 text default null,
  p_dimension_3 text default null,
  p_date_from date default null,
  p_date_to date default null,
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
  with base_items as (
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
      coalesce(p.group_id, cv.product_group_id) as product_group_id,
      pg.name as product_group_name,
      pr.chinese_name as salesperson_chinese_name,
      pr.full_name as salesperson_full_name,
      pr.email as salesperson_email
    from public.business_order_items i
    join public.business_orders bo on bo.id = i.order_id
    left join public.products p on p.id = i.product_id
    left join public.business_custom_product_versions cv on cv.id = i.custom_product_version_id
    left join public.product_groups pg on pg.id = coalesce(p.group_id, cv.product_group_id)
    left join public.customers c on c.id = bo.customer_id
    left join public.profiles pr on pr.id = bo.salesperson_id
    where bo.voided_at is null
      and (p_date_from is null or bo.order_date >= p_date_from)
      and (p_date_to is null or bo.order_date <= p_date_to)
      and (p_salesperson_ids is null or array_length(p_salesperson_ids, 1) is null
        or bo.salesperson_id = any (p_salesperson_ids))
      and (p_shop_ids is null or array_length(p_shop_ids, 1) is null
        or bo.shop_id = any (p_shop_ids))
      and (p_product_group_ids is null or array_length(p_product_group_ids, 1) is null
        or coalesce(p.group_id, cv.product_group_id) = any (p_product_group_ids))
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
        when 'shipping_category' then case bi.daily_shipping_category::text when 'custom' then '定制' when 'stock' then '现货' when 'sample' then '样品' when 'purchase' then '外采' else '(未填写)' end
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
        when 'shipping_category' then case bi.daily_shipping_category::text when 'custom' then '定制' when 'stock' then '现货' when 'sample' then '样品' when 'purchase' then '外采' else '(未填写)' end
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
        when 'shipping_category' then case bi.daily_shipping_category::text when 'custom' then '定制' when 'stock' then '现货' when 'sample' then '样品' when 'purchase' then '外采' else '(未填写)' end
        when 'date' then bi.order_date::text
        when 'month' then to_char(bi.order_date, 'YYYY-MM')
      end as dimension_3_label
    from base_items bi
  )
  select
    dimension_1_key,
    dimension_1_label,
    dimension_2_key,
    dimension_2_label,
    dimension_3_key,
    dimension_3_label,
    count(distinct order_id),
    coalesce(sum(quantity), 0),
    coalesce(sum(line_amount) filter (where currency = 'CNY'), 0),
    coalesce(sum(line_amount) filter (where currency = 'USD'), 0)
  from dimensioned_items
  group by
    dimension_1_key, dimension_1_label,
    dimension_2_key, dimension_2_label,
    dimension_3_key, dimension_3_label
  order by
    coalesce(sum(line_amount) filter (where currency = 'CNY'), 0) desc,
    coalesce(sum(line_amount) filter (where currency = 'USD'), 0) desc,
    dimension_1_label, dimension_2_label, dimension_3_label;
end;
$$;

revoke all on function public.get_business_performance_multi_dimension(
  text, text, text, date, date, uuid[], uuid[], uuid[], text[]
) from public, anon, authenticated, service_role;
grant execute on function public.get_business_performance_multi_dimension(
  text, text, text, date, date, uuid[], uuid[], uuid[], text[]
) to authenticated, service_role;

commit;
