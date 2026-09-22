begin;

alter table public.finance_daily_order_workflows
  drop constraint if exists fdo_workflow_customer_required_when_submitted;
alter table public.finance_daily_order_workflows
  add constraint fdo_workflow_customer_required_when_submitted check (
    status not in ('submitted', 'approved')
    or customer_id is not null
    or customer_name_snapshot is not null
  );

create or replace function public.reject_legacy_daily_order_workflow_update_except_customer_detach()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if old.customer_id is not null
     and new.customer_id is null
     and (to_jsonb(old) - 'customer_id' - 'updated_at')
         is not distinct from (to_jsonb(new) - 'customer_id' - 'updated_at')
     and not exists (
       select 1
       from public.customers
       where id = old.customer_id
     ) then
    return new;
  end if;

  raise exception 'Legacy daily-order facts are read-only; write business orders through business_orders';
end;
$$;
revoke all on function public.reject_legacy_daily_order_workflow_update_except_customer_detach()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_reject_legacy_daily_order_write on public.finance_daily_order_workflows;
drop trigger if exists trg_reject_legacy_daily_order_dml on public.finance_daily_order_workflows;
drop trigger if exists trg_reject_legacy_daily_order_insert_delete on public.finance_daily_order_workflows;
drop trigger if exists trg_reject_legacy_daily_order_update on public.finance_daily_order_workflows;
drop trigger if exists trg_reject_legacy_daily_order_truncate on public.finance_daily_order_workflows;

create trigger trg_reject_legacy_daily_order_insert_delete
before insert or delete on public.finance_daily_order_workflows
for each row execute function public.reject_legacy_daily_order_write();

create trigger trg_reject_legacy_daily_order_update
before update on public.finance_daily_order_workflows
for each row execute function public.reject_legacy_daily_order_workflow_update_except_customer_detach();

create trigger trg_reject_legacy_daily_order_truncate
before truncate on public.finance_daily_order_workflows
for each statement execute function public.reject_legacy_daily_order_write();

create or replace function public.set_business_order_customer(
  p_order_id uuid,
  p_customer_id uuid
)
returns table (id uuid, order_number text, version int)
language plpgsql
security definer
set search_path = public
as $$
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
      'contact_person', v_customer.contact_person
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

  return query select v_order.id, v_order.order_number, v_order.version;
end;
$$;
revoke all on function public.set_business_order_customer(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.set_business_order_customer(uuid, uuid) to authenticated;

commit;
