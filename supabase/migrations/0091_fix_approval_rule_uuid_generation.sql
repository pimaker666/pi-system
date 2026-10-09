-- 0091 审批规则 UUID 生成修复
-- SECURITY DEFINER 函数将 search_path 固定为 public，必须显式调用内置 UUID 函数。

begin;

create or replace function public.admin_save_order_edit_approval_rule(
  p_id uuid,
  p_name text,
  p_enabled boolean,
  p_target text,
  p_trigger_actions text[],
  p_conditions jsonb,
  p_reviewer_roles public.user_role[],
  p_reviewer_ids uuid[],
  p_approval_mode text
)
returns public.order_edit_approval_rules
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_row public.order_edit_approval_rules%rowtype;
  v_id uuid := coalesce(p_id, pg_catalog.gen_random_uuid());
begin
  perform public.permission_require_admin();
  if p_target not in ('business_order', 'daily_order') or p_approval_mode not in ('any', 'sequential') then
    raise exception 'Invalid approval rule configuration';
  end if;
  if jsonb_typeof(p_conditions) <> 'object' or coalesce(cardinality(p_trigger_actions), 0) = 0
     or not (p_trigger_actions <@ array['order_edit', 'amount_or_rate_change', 'shipment_change', 'void_order']::text[])
  then
    raise exception 'Invalid approval rule conditions';
  end if;
  if p_enabled and coalesce(cardinality(p_reviewer_roles), 0) = 0 and coalesce(cardinality(p_reviewer_ids), 0) = 0 then
    raise exception 'Enabled rule requires at least one reviewer';
  end if;
  if exists (select 1 from unnest(coalesce(p_reviewer_ids, '{}'::uuid[])) reviewer_id where not exists (select 1 from public.profiles where id = reviewer_id and status::text = 'approved')) then
    raise exception 'Reviewers must be approved accounts';
  end if;
  select to_jsonb(ar) into v_old from public.order_edit_approval_rules ar where ar.id = v_id;
  insert into public.order_edit_approval_rules (id, name, enabled, target, trigger_actions, conditions, reviewer_roles, reviewer_ids, approval_mode, updated_by)
  values (v_id, nullif(btrim(p_name), ''), p_enabled, p_target, p_trigger_actions, p_conditions, coalesce(p_reviewer_roles, '{}'::public.user_role[]), coalesce(p_reviewer_ids, '{}'::uuid[]), p_approval_mode, (select auth.uid()))
  on conflict (id) do update set
    name = excluded.name, enabled = excluded.enabled, target = excluded.target, trigger_actions = excluded.trigger_actions,
    conditions = excluded.conditions, reviewer_roles = excluded.reviewer_roles, reviewer_ids = excluded.reviewer_ids,
    approval_mode = excluded.approval_mode, updated_at = now(), updated_by = excluded.updated_by
  returning * into v_row;
  perform public.write_permission_audit('order_edit_approval_rule', v_row.id, case when v_old is null then 'create' else 'update' end, v_old, to_jsonb(v_row));
  return v_row;
end;
$$;

revoke all on function public.admin_save_order_edit_approval_rule(uuid, text, boolean, text, text[], jsonb, public.user_role[], uuid[], text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_save_order_edit_approval_rule(uuid, text, boolean, text, text[], jsonb, public.user_role[], uuid[], text)
  to authenticated;

commit;
