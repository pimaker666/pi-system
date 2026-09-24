-- 0080: 客户国家名称统一为中文标准名
--
-- 业务业绩的国家分组直接读取 customers.country，因此先统一现有同义写法，
-- 避免 USA / America / 美国等拆成多个分组。

begin;

update public.customers
set country = case lower(btrim(country))
  when 'ae' then '阿联酋'
  when 'america' then '美国'
  when 'us' then '美国'
  when 'usa' then '美国'
  when 'australia' then '澳大利亚'
  when 'bulgaria' then '保加利亚'
  when 'canada' then '加拿大'
  when 'china' then '中国'
  when 'czechia' then '捷克'
  else btrim(country)
end
where country is not null
  and btrim(country) <> '';

commit;
