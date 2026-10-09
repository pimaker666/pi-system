-- 0094_sync_custom_sample_shipping_category.sql
-- 同步业务订单 RPC、业绩标签与提成默认费率。

 do $$
declare
  function_definition text;
begin
  if version() not ilike '%pglite%' then
    for function_definition in
      select pg_get_functiondef(p.oid)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and pg_get_functiondef(p.oid) like '%not in (''stock'', ''sample'', ''custom'', ''purchase'')%'
    loop
      execute replace(
        function_definition,
        'not in (''stock'', ''sample'', ''custom'', ''purchase'')',
        'not in (''stock'', ''sample'', ''custom_sample'', ''custom'', ''purchase'')'
      );
    end loop;

    for function_definition in
      select pg_get_functiondef(p.oid)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and pg_get_functiondef(p.oid) like '%when ''sample'' then ''样品''%'
    loop
      execute replace(
        function_definition,
        'when ''sample'' then ''样品''',
        'when ''sample'' then ''现货样品'' when ''custom_sample'' then ''定制打样'''
      );
    end loop;
  end if;
end;
$$;

insert into public.finance_commission_category_rates (category, product_commission_rate)
values ('custom_sample', 0)
on conflict (category) do nothing;
