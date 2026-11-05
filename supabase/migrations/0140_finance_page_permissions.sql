-- 0140_finance_page_permissions.sql
-- 财务页面级权限：把原来的“查看财务”整体放行拆成六个页面开关。
-- 保留原 finance.view 键（前端已不再读取），便于回滚旧版本；新增 finance.page.* 作为唯一生效口径。

-- 角色模板默认值：管理员与财务六项全开，业务主管与业务员六项全关。
update public.permission_templates
set permissions = jsonb_set(
      permissions,
      '{finance,page}',
      coalesce(permissions #> '{finance,page}', '{}'::jsonb) || jsonb_build_object(
        'overview', true,
        'journal', true,
        'costs', true,
        'settled_orders', true,
        'profit', true,
        'commission_settled', true
      ),
      true
    ),
    updated_at = now()
where system_role in ('admin', 'finance');

update public.permission_templates
set permissions = jsonb_set(
      permissions,
      '{finance,page}',
      coalesce(permissions #> '{finance,page}', '{}'::jsonb) || jsonb_build_object(
        'overview', false,
        'journal', false,
        'costs', false,
        'settled_orders', false,
        'profit', false,
        'commission_settled', false
      ),
      true
    ),
    updated_at = now()
where system_role in ('sales', 'supervisor');

-- 账号例外回填：原来单独放行 finance.view 的账号，继续拥有六个页面；
-- 原来单独禁止 finance.view 的账号，继续保持全部禁止。
update public.profile_permission_overrides
set allowed_permissions = (
      select jsonb_agg(distinct entry)
      from jsonb_array_elements(
        allowed_permissions || '[
          "finance.page.overview",
          "finance.page.journal",
          "finance.page.costs",
          "finance.page.settled_orders",
          "finance.page.profit",
          "finance.page.commission_settled"
        ]'::jsonb
      ) as entry
    ),
    updated_at = now()
where allowed_permissions ? 'finance.view';

update public.profile_permission_overrides
set denied_permissions = (
      select jsonb_agg(distinct entry)
      from jsonb_array_elements(
        denied_permissions || '[
          "finance.page.overview",
          "finance.page.journal",
          "finance.page.costs",
          "finance.page.settled_orders",
          "finance.page.profit",
          "finance.page.commission_settled"
        ]'::jsonb
      ) as entry
    ),
    updated_at = now()
where denied_permissions ? 'finance.view';

-- 一次往返返回多个权限点的判定结果，供布局/导航一次性取齐页面可见性。
create or replace function public.current_permission_map(p_permissions text[])
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_key text;
  v_result jsonb := '{}'::jsonb;
begin
  if p_permissions is null or cardinality(p_permissions) = 0 then
    return v_result;
  end if;
  if cardinality(p_permissions) > 100 then
    raise exception 'Too many permissions requested (max 100)';
  end if;

  foreach v_key in array p_permissions loop
    continue when nullif(btrim(v_key), '') is null;
    v_result := v_result || jsonb_build_object(
      v_key,
      public.has_current_permission(v_key)
    );
  end loop;

  return v_result;
end;
$$;

revoke all on function public.current_permission_map(text[]) from public, anon, authenticated, service_role;
grant execute on function public.current_permission_map(text[]) to authenticated;
