-- 0027_daily_order_shop_currency.sql
-- 每日订单店铺支持默认币种：
--   1) finance_daily_order_shops 增加 default_currency 列（默认 'CNY'）。
--   2) 新增 6 参 save_finance_daily_order_shop RPC 持久化店铺默认币种；
--      沿用每日订单仅 CNY/USD 的约束，避免引入其它币种。
-- 建单时前端按店铺 default_currency 预填订单币种（本迁移只负责存储与读取）。
-- 注：新增的 6 参签名与既有 5 参签名参数键集合不同，PostgREST 按传入键精确解析，
--     不产生歧义；旧签名保留以兼容滚动切换期间尚未更新的容器。

alter table public.finance_daily_order_shops
  add column if not exists default_currency public.currency_code not null default 'CNY';

create or replace function public.save_finance_daily_order_shop(
  p_shop_id uuid, p_name text, p_group_id uuid, p_is_active boolean,
  p_salesperson_ids uuid[], p_default_currency public.currency_code
)
returns public.finance_daily_order_shops
language plpgsql
security definer
set search_path = public
as $$
declare v_actor public.profiles%rowtype; v_shop public.finance_daily_order_shops%rowtype; v_sales_id uuid;
begin
  v_actor := public.assert_daily_order_finance_actor();
  if nullif(btrim(p_name), '') is null or char_length(btrim(p_name)) > 100 then raise exception 'Invalid shop name'; end if;
  if p_default_currency is null or p_default_currency::text not in ('CNY', 'USD') then raise exception 'Invalid shop currency'; end if;
  if p_group_id is not null and not exists (select 1 from public.finance_daily_order_shop_groups where id = p_group_id)
    then raise exception 'Shop group does not exist'; end if;
  if coalesce(array_length(p_salesperson_ids, 1), 0) > 200 then raise exception 'Too many salespeople'; end if;
  foreach v_sales_id in array coalesce(p_salesperson_ids, array[]::uuid[]) loop
    if not exists (select 1 from public.profiles where id = v_sales_id and status::text = 'approved' and role::text in ('sales', 'admin'))
      then raise exception 'Salesperson does not exist or is not approved'; end if;
  end loop;
  if p_shop_id is null then
    insert into public.finance_daily_order_shops(name, group_id, is_active, default_currency, created_by)
      values (btrim(p_name), p_group_id, p_is_active, p_default_currency, v_actor.id) returning * into v_shop;
  else
    update public.finance_daily_order_shops
      set name = btrim(p_name), group_id = p_group_id, is_active = p_is_active, default_currency = p_default_currency
      where id = p_shop_id returning * into v_shop;
    if not found then raise exception 'Shop does not exist'; end if;
  end if;
  update public.finance_daily_order_shop_salespeople set is_active = false
    where shop_id = v_shop.id and salesperson_id <> all(coalesce(p_salesperson_ids, array[]::uuid[]));
  foreach v_sales_id in array coalesce(p_salesperson_ids, array[]::uuid[]) loop
    insert into public.finance_daily_order_shop_salespeople(shop_id, salesperson_id, is_active, created_by)
      values (v_shop.id, v_sales_id, true, v_actor.id)
    on conflict (shop_id, salesperson_id) do update set is_active = true;
  end loop;
  return v_shop;
end;
$$;
revoke all on function public.save_finance_daily_order_shop(uuid, text, uuid, boolean, uuid[], public.currency_code) from public, anon, authenticated, service_role;
grant execute on function public.save_finance_daily_order_shop(uuid, text, uuid, boolean, uuid[], public.currency_code) to authenticated;
