-- 0061 终止订单的物理清除
--
-- 作废(voided_at)或特殊关闭(closed_at)的业务订单保留 3 个月，超期后物理删除。
-- 关键约束与设计取舍：
--   1) 保留期起算于「作废/关闭动作时间」(voided_at / closed_at)，与下单日期无关。
--   2) 客户级预收款转账(business_customer_transfers.customer_id 非空)跨多单共享，
--      永不删除；仅删除该订单自身的分摊以及订单作用域转账(order_id 非空)。
--   3) 附件/凭证的实际图片文件由 NAS cron 通过 Storage API 删除；本函数只删业务表行，
--      并返回待删对象的 (bucket, object_path)。
--   4) 删除前把整单快照写入 business_order_purge_log，作为不可逆删除的兜底恢复依据。
-- 所有子表 FK 均为 on delete restrict，且存在大量「作废/关闭/审批」不可变触发器，
-- 普通 DELETE 会被拒绝。函数以 supabase_admin(超级用户) 拥有的 security definer 运行，
-- 期间 set local session_replication_role='replica' 关闭全部用户触发器与 RI，
-- 再按依赖顺序手工删除，事务结束后角色自动复位。
-- 该函数仅供 supabase_admin / cron 调用，不授予 authenticated。
-- 本迁移可重复执行。

begin;

-- -----------------------------------------------------------------------------
-- 1. 清除归档表（删除前快照，用于兜底恢复与审计）
-- -----------------------------------------------------------------------------
create table if not exists public.business_order_purge_log (
  id              bigint generated always as identity primary key,
  order_id        uuid not null,
  order_number    text,
  terminated_kind text not null check (terminated_kind in ('voided', 'closed')),
  terminated_at   timestamptz not null,
  purged_at       timestamptz not null default now(),
  retention       interval not null,
  snapshot        jsonb not null,
  storage_objects jsonb not null default '[]'::jsonb
);

comment on table public.business_order_purge_log is
  '终止订单物理清除的归档：删除前的整单快照 + 待删存储对象清单，供不可逆删除兜底恢复';

create index if not exists idx_business_order_purge_log_order
  on public.business_order_purge_log (order_id);
create index if not exists idx_business_order_purge_log_purged_at
  on public.business_order_purge_log (purged_at desc);

alter table public.business_order_purge_log enable row level security;
-- 仅超级用户 / security definer 可访问；应用侧无需读取，故不建任何策略。
revoke all on table public.business_order_purge_log
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. 清除函数
-- -----------------------------------------------------------------------------
create or replace function public.purge_terminated_business_orders(
  p_retention interval default interval '3 months',
  p_limit int default 500
)
returns table (bucket text, object_path text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff timestamptz := now() - p_retention;
  v_order record;
  v_snapshot jsonb;
  v_storage jsonb;
begin
  -- 防止误传极小保留期导致大面积误删。
  if p_retention is null or p_retention < interval '1 day' then
    raise exception 'Retention must be at least 1 day to avoid accidental mass deletion';
  end if;
  if p_limit is null or p_limit <= 0 or p_limit > 5000 then
    raise exception 'Purge limit must be between 1 and 5000';
  end if;

  -- 关闭全部用户触发器与 RI；set local 在事务结束时自动复位。
  set local session_replication_role = 'replica';

  for v_order in
    select bo.id,
           bo.order_number,
           case when bo.voided_at is not null then 'voided' else 'closed' end as kind,
           coalesce(bo.voided_at, bo.closed_at) as terminated_at
    from public.business_orders bo
    where (bo.voided_at is not null and bo.voided_at < v_cutoff)
       or (bo.voided_at is null and bo.closed_at is not null and bo.closed_at < v_cutoff)
    order by coalesce(bo.voided_at, bo.closed_at)
    limit p_limit
  loop
    -- 待删存储对象：店铺截图 + 收款凭证 + 订单作用域转账凭证。
    select coalesce(jsonb_agg(jsonb_build_object('bucket', o.bucket, 'object_path', o.object_path)), '[]'::jsonb)
      into v_storage
    from (
      select 'finance-daily-order-screenshots'::text as bucket, a.object_path as object_path
        from public.business_order_attachments a
        where a.order_id = v_order.id
      union all
      select 'business-payment-proofs'::text, p.proof_path
        from public.business_order_payments p
        where p.order_id = v_order.id
      union all
      select 'business-payment-proofs'::text, t.proof_path
        from public.business_customer_transfers t
        where t.order_id = v_order.id
    ) o;

    -- 整单快照（含全部子表），删除前落库。
    v_snapshot := jsonb_build_object(
      'order', (select to_jsonb(bo) from public.business_orders bo where bo.id = v_order.id),
      'items', (select coalesce(jsonb_agg(to_jsonb(i)), '[]'::jsonb)
                  from public.business_order_items i where i.order_id = v_order.id),
      'payments', (select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb)
                  from public.business_order_payments p where p.order_id = v_order.id),
      'allocations', (select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb)
                  from public.business_order_payment_allocations a where a.order_id = v_order.id),
      'order_scoped_transfers', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
                  from public.business_customer_transfers t where t.order_id = v_order.id),
      'shipments', (select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb)
                  from public.business_order_shipments s where s.order_id = v_order.id),
      'shipment_items', (select coalesce(jsonb_agg(to_jsonb(si)), '[]'::jsonb)
                  from public.business_order_shipment_items si
                  join public.business_order_shipments s on s.id = si.shipment_id
                  where s.order_id = v_order.id),
      'returns', (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
                  from public.business_order_returns r where r.order_id = v_order.id),
      'return_items', (select coalesce(jsonb_agg(to_jsonb(ri)), '[]'::jsonb)
                  from public.business_order_return_items ri where ri.order_id = v_order.id),
      'attachments', (select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb)
                  from public.business_order_attachments a where a.order_id = v_order.id),
      'amount_revisions', (select coalesce(jsonb_agg(to_jsonb(rev)), '[]'::jsonb)
                  from public.business_order_amount_revisions rev where rev.order_id = v_order.id),
      'finance_details', (select coalesce(jsonb_agg(to_jsonb(fd)), '[]'::jsonb)
                  from public.business_order_finance_details fd where fd.order_id = v_order.id),
      'costs', (select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb)
                  from public.finance_order_costs c where c.business_order_id = v_order.id),
      'item_cost_overrides', (select coalesce(jsonb_agg(to_jsonb(co)), '[]'::jsonb)
                  from public.finance_business_order_item_cost_overrides co
                  join public.business_order_items i on i.id = co.business_order_item_id
                  where i.order_id = v_order.id),
      'item_settlements', (select coalesce(jsonb_agg(to_jsonb(st)), '[]'::jsonb)
                  from public.finance_business_order_item_settlements st
                  join public.business_order_items i on i.id = st.business_order_item_id
                  where i.order_id = v_order.id),
      'audit_logs', (select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb)
                  from public.business_order_audit_logs l where l.order_id = v_order.id),
      'lifecycle_logs', (select coalesce(jsonb_agg(to_jsonb(ll)), '[]'::jsonb)
                  from public.business_lifecycle_audit_logs ll where ll.order_id = v_order.id)
    );

    insert into public.business_order_purge_log (
      order_id, order_number, terminated_kind, terminated_at, retention, snapshot, storage_objects
    ) values (
      v_order.id, v_order.order_number, v_order.kind, v_order.terminated_at,
      p_retention, v_snapshot, v_storage
    );

    return query
      select (obj->>'bucket')::text, (obj->>'object_path')::text
      from jsonb_array_elements(v_storage) obj;

    -- 按依赖顺序删除子行，最后删订单本身。客户级预收款转账不在此列。
    delete from public.business_order_return_items ri
      using public.business_order_returns r
      where ri.return_id = r.id and r.order_id = v_order.id;
    delete from public.business_order_returns where order_id = v_order.id;

    delete from public.business_order_shipment_items si
      using public.business_order_shipments s
      where si.shipment_id = s.id and s.order_id = v_order.id;
    delete from public.business_order_shipments where order_id = v_order.id;

    delete from public.finance_business_order_item_settlements st
      using public.business_order_items i
      where st.business_order_item_id = i.id and i.order_id = v_order.id;
    delete from public.finance_business_order_item_cost_overrides co
      using public.business_order_items i
      where co.business_order_item_id = i.id and i.order_id = v_order.id;

    delete from public.business_order_payment_allocations where order_id = v_order.id;
    -- 订单作用域转账(order_id 非空)随单删除；客户作用域转账(customer_id 非空)保留。
    delete from public.business_customer_transfers where order_id = v_order.id;

    delete from public.business_order_amount_revisions where order_id = v_order.id;
    delete from public.finance_order_costs where business_order_id = v_order.id;
    delete from public.business_order_finance_details where order_id = v_order.id;
    delete from public.business_order_attachments where order_id = v_order.id;
    delete from public.business_order_payments where order_id = v_order.id;
    delete from public.business_order_items where order_id = v_order.id;
    delete from public.business_order_audit_logs where order_id = v_order.id;
    delete from public.business_lifecycle_audit_logs where order_id = v_order.id;
    delete from public.business_orders where id = v_order.id;
  end loop;

  return;
end;
$$;

revoke all on function public.purge_terminated_business_orders(interval, int)
  from public, anon, authenticated, service_role;

commit;
