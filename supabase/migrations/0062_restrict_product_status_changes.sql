-- 0062 产品上下架仅限已审批财务或管理员。
-- 产品其他维护权限保持 0003 的既有规则；仅保护 is_active 状态字段。

begin;

create or replace function public.guard_product_active_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.is_active is distinct from new.is_active
     and not public.is_finance_or_admin() then
    raise exception 'Approved finance or administrator required to change product status';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_product_active_change()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_products_guard_active_change on public.products;
create trigger trg_products_guard_active_change
  before update of is_active on public.products
  for each row execute function public.guard_product_active_change();

commit;
