-- 0084 业务业绩业务员筛选范围

begin;

create or replace function public.get_business_performance_salespeople()
returns table (
  id uuid,
  full_name text,
  email text,
  chinese_name text
)
language sql
security definer
set search_path = public
stable
as $$
  select
    p.id,
    p.full_name,
    p.email,
    p.chinese_name
  from public.profiles p
  join public.profiles me on me.id = (select auth.uid())
  where p.status::text = 'approved'
    and p.role::text in ('sales', 'supervisor', 'admin')
    and (
      me.role::text in ('admin', 'finance')
      or p.id = me.id
      or public.is_my_subordinate(p.id)
    )
  order by p.full_name;
$$;

revoke all on function public.get_business_performance_salespeople()
  from public, anon, authenticated, service_role;
grant execute on function public.get_business_performance_salespeople()
  to authenticated, service_role;

commit;
