-- 0026_admin_subordinate_visibility.sql
-- 需求B 扩展：允许「管理员（admin）」被指派汇报上级（业务主管/管理员），
-- 并让其上级主管对该管理员「个人名下」的订单/业绩/客户获得只读可见性。
--
-- 背景与边界：
--   * 0021 引入 supervisor 角色、supervisor_id 层级、递归下属判定 is_my_subordinate、
--     防环守卫触发器，以及在既有 SELECT 策略后追加 `or is_my_subordinate(owner)`。
--   * 0024 收紧 is_my_subordinate 的递归种子，仅 approved 的 sales/supervisor 可作为
--     下属，避免遗留 supervisor_id 让主管读到已转为 admin/finance 或未审核账号的数据。
--   * 本迁移在此基础上「显式放开 admin」作为下属：
--       - set_user_manager 允许目标用户角色为 sales/supervisor/admin；
--       - is_my_subordinate 递归种子加入 'admin'（仍要求 approved，仍排除 finance）。
--     其余不变：
--       - 上级候选/角色/自引用/环检测仍由 profiles 守卫触发器 protect_profile_privileged_fields
--         与 set_user_manager 的 advisory lock 兜底（上级必须是 approved 的 supervisor/admin）；
--       - 只读可见性完全复用 0021/0024 既有策略（customers / proforma_invoices / pi_items /
--         finance_daily_orders / 截图 / business_orders via can_view_business_order），
--         本迁移只修改 is_my_subordinate 一处即自动生效；
--       - 工资/核算 business_order_finance_details 与 audit_logs 仍限 finance/admin，
--         主管不可见，保持「只读、无审批/编辑/工资」语义；
--       - 管理员被挂上级不会削弱其自身权限（is_admin() 不受影响）。
--
-- 安全性：默认没有 supervisor_id 的管理员对任何主管仍不可见；只有被管理员显式
--   set_user_manager 挂到某主管链上的管理员，其个人数据才对该主管只读可见。

-- 1) 递归下属判定：种子行放开 admin（沿用 0024 的 approved 过滤，继续排除 finance）
create or replace function public.is_my_subordinate(p_owner uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  with recursive chain as (
    select p.id, p.supervisor_id, 1 as depth
    from public.profiles p
    where p.id = p_owner
      and p.status::text = 'approved'
      and p.role::text in ('sales', 'supervisor', 'admin')
    union all
    select parent.id, parent.supervisor_id, c.depth + 1
    from public.profiles parent
    join chain c on parent.id = c.supervisor_id
    where c.depth < 50
  )
  select
    p_owner is not null
    and (select auth.uid()) is not null
    and public.is_active_supervisor()
    and exists (
      select 1 from chain where chain.supervisor_id = (select auth.uid())
    );
$$;
revoke all on function public.is_my_subordinate(uuid) from public, anon, authenticated, service_role;
grant execute on function public.is_my_subordinate(uuid) to authenticated;

-- 2) 管理员专用 RPC：放开 admin 作为可挂上级的目标用户
--    上级角色/自引用/环检测仍由守卫触发器兜底；此处仅校验目标用户角色。
create or replace function public.set_user_manager(
  p_user_id uuid,
  p_manager_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.profiles%rowtype;
  v_updated uuid;
begin
  if not public.is_admin() then
    raise exception 'Only administrators can change the reporting manager';
  end if;
  if p_user_id is null then
    raise exception 'User ID is required';
  end if;
  if p_manager_id is not null and p_manager_id = p_user_id then
    raise exception 'A user cannot be their own manager';
  end if;

  perform pg_advisory_xact_lock(hashtext('profiles_supervisor_hierarchy'));

  select * into v_user from public.profiles where id = p_user_id;
  if not found then
    raise exception 'User does not exist';
  end if;

  if v_user.role::text not in ('sales', 'supervisor', 'admin') then
    raise exception 'Only sales, supervisor, or admin users can have a manager';
  end if;

  update public.profiles
     set supervisor_id = p_manager_id
   where id = p_user_id
   returning id into v_updated;

  return v_updated;
end;
$$;

revoke all on function public.set_user_manager(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.set_user_manager(uuid, uuid) to authenticated;
