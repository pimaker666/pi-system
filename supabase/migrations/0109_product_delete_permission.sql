-- 0109_product_delete_permission.sql
-- 产品删除权限：products.delete 可配置给任意角色（角色模板或账号例外），不再限定管理员；
-- 定制产品库新增删除入口（security definer RPC，订单引用保护）。

-- 产品库 RLS：管理员或持有 products.delete 权限的账号可删除。
drop policy if exists "products_delete" on public.products;
create policy "products_delete" on public.products
  for delete using (
    public.is_admin()
    or public.has_current_permission('products.delete')
  );

-- 角色模板种子：默认仅管理员可删；其他角色默认关闭，由权限配置按需授予。
update public.permission_templates
set permissions = jsonb_set(permissions, '{products,delete}', 'true'::jsonb, true),
    updated_at = now()
where system_role = 'admin';

-- 定制产品删除：被订单行引用的产品禁止删除（历史快照依赖），提示改用归档。
create or replace function public.delete_business_custom_product(p_custom_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_count integer;
begin
  if not public.has_current_permission('products.delete') then
    raise exception '没有删除定制产品的权限';
  end if;

  select count(*) into v_item_count
  from public.business_order_items
  where custom_product_id = p_custom_product_id;

  if v_item_count > 0 then
    raise exception '该定制产品已被 % 个订单行引用，不能删除；请改用归档下架', v_item_count;
  end if;

  delete from public.business_custom_product_versions
  where custom_product_id = p_custom_product_id;

  delete from public.business_custom_products
  where id = p_custom_product_id;

  if not found then
    raise exception '定制产品不存在或已删除';
  end if;

  return jsonb_build_object('deleted', true);
end;
$$;

revoke all on function public.delete_business_custom_product(uuid) from public, anon, authenticated, service_role;
grant execute on function public.delete_business_custom_product(uuid) to authenticated;
