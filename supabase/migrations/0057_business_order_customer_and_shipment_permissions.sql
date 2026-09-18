begin;

do $$
begin
  if to_regprocedure('public.create_business_order_shipment_internal_0057(uuid,timestamp with time zone,text,text,jsonb,text,boolean,text)') is null then
    execute 'alter function public.create_business_order_shipment(uuid, timestamptz, text, text, jsonb, text, boolean, text) rename to create_business_order_shipment_internal_0057';
  end if;
  if to_regprocedure('public.void_business_order_shipment_internal_0057(uuid,text)') is null then
    execute 'alter function public.void_business_order_shipment(uuid, text) rename to void_business_order_shipment_internal_0057';
  end if;
end;
$$;

revoke all on function public.create_business_order_shipment_internal_0057(
  uuid, timestamptz, text, text, jsonb, text, boolean, text
) from public, anon, authenticated, service_role;
revoke all on function public.void_business_order_shipment_internal_0057(uuid, text)
  from public, anon, authenticated, service_role;

create or replace function public.create_business_order_shipment(
  p_order_id uuid,
  p_shipped_at timestamptz,
  p_tracking_number text,
  p_notes text,
  p_items jsonb,
  p_idempotency_key text,
  p_allow_overship boolean,
  p_overship_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Only approved administrators or finance users can create shipments';
  end if;

  return public.create_business_order_shipment_internal_0057(
    p_order_id, p_shipped_at, p_tracking_number, p_notes, p_items,
    p_idempotency_key, p_allow_overship, p_overship_reason
  );
end;
$$;
revoke all on function public.create_business_order_shipment(
  uuid, timestamptz, text, text, jsonb, text, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_business_order_shipment(
  uuid, timestamptz, text, text, jsonb, text, boolean, text
) to authenticated;

create or replace function public.create_business_order_shipment(
  p_order_id uuid,
  p_shipped_at timestamptz,
  p_tracking_number text,
  p_notes text,
  p_items jsonb,
  p_idempotency_key text
)
returns jsonb
language sql
security definer
set search_path = public, extensions
as $$
  select public.create_business_order_shipment(
    p_order_id, p_shipped_at, p_tracking_number, p_notes,
    p_items, p_idempotency_key, false, null::text
  );
$$;
revoke all on function public.create_business_order_shipment(
  uuid, timestamptz, text, text, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_business_order_shipment(
  uuid, timestamptz, text, text, jsonb, text
) to authenticated;

create or replace function public.void_business_order_shipment(
  p_shipment_id uuid,
  p_reason text
)
returns public.business_order_shipments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Only approved administrators or finance users can void shipments';
  end if;

  return public.void_business_order_shipment_internal_0057(p_shipment_id, p_reason);
end;
$$;
revoke all on function public.void_business_order_shipment(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.void_business_order_shipment(uuid, text) to authenticated;

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
  v_old := jsonb_build_object(
    'customer_id', v_order.customer_id,
    'customer_snapshot', v_order.customer_snapshot
  );

  update public.business_orders bo
  set customer_id = v_customer.id,
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
