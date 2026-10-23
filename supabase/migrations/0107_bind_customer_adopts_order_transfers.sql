-- 0107: 补绑客户后归拢订单级转账
-- 背景：订单未绑客户时登记的转账 customer_id 为空（订单级转账）；0101 补绑客户后
-- 前端按客户口径查转账看不到这笔钱，其分摊被误渲染为「已作废/转账信息不可见」。
-- 两步：
--   1) 一次性回填：已绑客户且未作废订单名下的无客户转账，归拢到该订单的客户；
--   2) set_business_order_customer 绑定客户时同步归拢该订单的无客户转账（防复发）。

update public.business_customer_transfers t
set customer_id = bo.customer_id
from public.business_orders bo
where bo.id = t.order_id
  and t.customer_id is null
  and bo.customer_id is not null
  and bo.voided_at is null;

-- 以下函数体来自生产 pg_get_functiondef 原文，仅在 return query 前追加归拢块。
create or replace function public.set_business_order_customer(p_order_id uuid, p_customer_id uuid)
 returns table(id uuid, order_number text, version integer)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_customer public.customers%rowtype;
  v_snapshot jsonb;
  v_old jsonb;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved business role required';
  end if;

  select * into v_order
  from public.business_orders bo
  where bo.id = p_order_id
  for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if v_order.voided_at is not null then raise exception 'Voided business order records are immutable'; end if;
  if v_actor.role::text in ('sales', 'supervisor')
     and v_order.salesperson_id is distinct from v_uid then
    raise exception 'Sales user cannot set customer for another owner business order';
  end if;

  if p_customer_id is not null then
    select * into v_customer from public.customers c where c.id = p_customer_id;
    if not found or (
      v_actor.role::text in ('sales', 'supervisor')
      and v_customer.created_by is distinct from v_uid
    ) then
      raise exception 'Customer does not exist or is not manageable by current user';
    end if;

    v_snapshot := jsonb_build_object(
      'name', v_customer.name,
      'company', v_customer.company,
      'email', v_customer.email,
      'phone', v_customer.phone,
      'address', v_customer.address,
      'city', v_customer.city,
      'state', v_customer.state,
      'postal_code', v_customer.postal_code,
      'country', v_customer.country,
      'contact_person', v_customer.contact_person,
      'tag_color', v_customer.tag_color
    );
  else
    v_snapshot := '{}'::jsonb;
  end if;

  v_old := jsonb_build_object(
    'customer_id', v_order.customer_id,
    'customer_snapshot', v_order.customer_snapshot
  );

  update public.business_orders bo
  set customer_id = p_customer_id,
      customer_snapshot = v_snapshot,
      version = bo.version + 1
  where bo.id = v_order.id
  returning bo.* into v_order;

  perform public.write_business_order_audit(
    v_order.id,
    'order',
    v_order.id,
    'update',
    v_order.status,
    v_order.status,
    v_old,
    jsonb_build_object(
      'customer_id', v_order.customer_id,
      'customer_snapshot', v_order.customer_snapshot
    ),
    null,
    v_uid
  );

  if p_customer_id is not null then
    update public.business_customer_transfers t
    set customer_id = p_customer_id
    where t.order_id = v_order.id
      and t.customer_id is null;
  end if;

  return query select v_order.id, v_order.order_number, v_order.version;
end;
$function$;

revoke all on function public.set_business_order_customer(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.set_business_order_customer(uuid, uuid) to authenticated;
