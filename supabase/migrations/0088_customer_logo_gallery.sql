-- 0088: 客户多 Logo 图库

begin;

alter table public.customers
  add column if not exists logo_urls text[] not null default '{}';

update public.customers
set logo_urls = array[logo_url]
where coalesce(array_length(logo_urls, 1), 0) = 0
  and logo_url is not null;

alter table public.customers
  drop constraint if exists customers_logo_urls_count;
alter table public.customers
  add constraint customers_logo_urls_count
  check (coalesce(array_length(logo_urls, 1), 0) <= 10);

commit;
