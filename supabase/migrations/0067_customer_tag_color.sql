-- Customer color tags: allow assigning a hex color to each customer so the
-- customer name can be rendered in that color across the customer list and
-- order views (commission, cost, and daily order tables).

alter table public.customers
  add column if not exists tag_color text null;

alter table public.finance_daily_order_workflows
  add column if not exists customer_tag_color text null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.customers'::regclass
      and conname = 'customers_tag_color_check'
  ) then
    alter table public.customers
      add constraint customers_tag_color_check
      check (tag_color is null or tag_color ~ '^#[0-9A-Fa-f]{6}$');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.finance_daily_order_workflows'::regclass
      and conname = 'fdo_workflow_customer_tag_color_check'
  ) then
    alter table public.finance_daily_order_workflows
      add constraint fdo_workflow_customer_tag_color_check
      check (customer_tag_color is null or customer_tag_color ~ '^#[0-9A-Fa-f]{6}$');
  end if;
end $$;

comment on column public.customers.tag_color is '客户标记颜色（十六进制，如 #ff0000）';
comment on column public.finance_daily_order_workflows.customer_tag_color is '绑定客户时的标记颜色快照';

-- Update workflow customer binding to also snapshot the tag color.
create or replace function public.bind_workflow_customer(
  p_workflow_id uuid,
  p_expected_version int,
  p_customer_id uuid
)
returns table (id uuid, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_workflow public.finance_daily_order_workflows%rowtype;
  v_customer public.customers%rowtype;
  v_old jsonb;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved business role required';
  end if;

  select * into v_workflow
  from public.finance_daily_order_workflows wf
  where wf.id = p_workflow_id
  for update;
  if not found then raise exception 'Workflow does not exist'; end if;
  if v_workflow.version <> p_expected_version then
    raise exception 'Workflow version conflict';
  end if;
  if v_workflow.customer_id is not null then
    raise exception 'Workflow already has a customer';
  end if;

  select * into v_customer from public.customers c where c.id = p_customer_id;
  if not found or (
    v_actor.role::text in ('sales', 'supervisor')
    and v_customer.created_by is distinct from v_uid
  ) then
    raise exception 'Customer does not exist or is not manageable by current user';
  end if;

  v_old := jsonb_build_object(
    'customer_id', v_workflow.customer_id,
    'customer_name_snapshot', v_workflow.customer_name_snapshot,
    'customer_tag_color', v_workflow.customer_tag_color
  );

  update public.finance_daily_order_workflows wf
  set
    customer_id = v_customer.id,
    customer_name_snapshot = left(coalesce(
      nullif(btrim(v_customer.name), ''),
      nullif(btrim(v_customer.company), ''),
      '客户'
    ), 300),
    customer_tag_color = v_customer.tag_color,
    version = wf.version + 1
  where wf.id = p_workflow_id
  returning * into v_workflow;

  perform public.write_daily_order_workflow_audit(
    v_workflow.id, 'update', v_old,
    jsonb_build_object(
      'customer_id', v_workflow.customer_id,
      'customer_name_snapshot', v_workflow.customer_name_snapshot,
      'customer_tag_color', v_workflow.customer_tag_color
    ),
    'Bound customer ' || coalesce(v_customer.name, v_customer.company, v_customer.id::text),
    v_uid
  );

  return query select v_workflow.id, v_workflow.version;
end;
$$;
revoke all on function public.bind_workflow_customer(uuid, int, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.bind_workflow_customer(uuid, int, uuid) to authenticated;

-- Include tag_color in the business order customer snapshot so that
-- historical orders keep the color that was set at the time of order creation.
create or replace function public.create_business_order(
  p_customer_id uuid,
  p_order_date date,
  p_fulfillment_type public.business_fulfillment_type,
  p_currency public.currency_code,
  p_exchange_rate_to_cny numeric,
  p_shipping_fee numeric,
  p_tracking_number text,
  p_sales_notes text,
  p_items jsonb
)
returns table (id uuid, order_number text, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_customer public.customers%rowtype;
  v_customer_snapshot jsonb := '{}'::jsonb;
  v_order public.business_orders%rowtype;
  v_subtotal numeric(18,2);
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Only approved sales, supervisor, admin, or finance users can create business orders';
  end if;
  if p_customer_id is null and v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Business order customer is required';
  end if;
  if p_order_date is null then raise exception 'Order date is required'; end if;
  if p_exchange_rate_to_cny is not null
     and (p_exchange_rate_to_cny <= 0 or p_exchange_rate_to_cny > 1000000) then
    raise exception 'Exchange rate is invalid';
  end if;
  if p_currency::text = 'CNY' and p_exchange_rate_to_cny is not null
     and p_exchange_rate_to_cny <> 1 then
    raise exception 'CNY exchange rate must equal one';
  end if;
  if p_shipping_fee is null or p_shipping_fee < 0 or p_shipping_fee > 999999999999 then
    raise exception 'Shipping fee is invalid';
  end if;
  if char_length(coalesce(p_tracking_number, '')) > 200
     or char_length(coalesce(p_sales_notes, '')) > 2000 then
    raise exception 'Business order text exceeds maximum length';
  end if;

  if p_customer_id is not null then
    select * into v_customer from public.customers c where c.id = p_customer_id;
    if not found or (
      v_actor.role::text in ('sales', 'supervisor') and v_customer.created_by is distinct from v_uid
    ) then
      raise exception 'Customer does not exist or is not manageable by current user';
    end if;
    v_customer_snapshot := jsonb_build_object(
      'name', v_customer.name, 'company', v_customer.company,
      'email', v_customer.email, 'phone', v_customer.phone,
      'address', v_customer.address, 'city', v_customer.city,
      'state', v_customer.state, 'postal_code', v_customer.postal_code,
      'country', v_customer.country, 'contact_person', v_customer.contact_person,
      'tag_color', v_customer.tag_color
    );
  end if;

  insert into public.business_orders (
    order_number, customer_id, customer_snapshot, salesperson_id,
    salesperson_name_snapshot, order_date, fulfillment_type, currency,
    exchange_rate_to_cny, items_subtotal, shipping_fee, total_amount,
    tracking_number, sales_notes
  ) values (
    public.next_business_order_number(), p_customer_id, v_customer_snapshot,
    v_uid, coalesce(
      nullif(btrim(v_actor.chinese_name), ''),
      nullif(btrim(v_actor.full_name), ''),
      v_actor.email
    ),
    p_order_date, p_fulfillment_type, p_currency, p_exchange_rate_to_cny,
    0, p_shipping_fee, p_shipping_fee,
    nullif(btrim(p_tracking_number), ''), nullif(btrim(p_sales_notes), '')
  ) returning * into v_order;

  v_subtotal := public.replace_business_order_items(v_order.id, p_items);
  update public.business_orders bo
  set items_subtotal = v_subtotal, total_amount = v_subtotal + p_shipping_fee
  where bo.id = v_order.id returning * into v_order;

  perform public.write_business_order_audit(
    v_order.id, 'order', v_order.id, 'create', null, v_order.status, null,
    jsonb_build_object(
      'order', to_jsonb(v_order),
      'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order)
                         from public.business_order_items i
                         where i.order_id = v_order.id), '[]'::jsonb)
    ), null, v_uid
  );
  return query select v_order.id, v_order.order_number, v_order.version;
end;
$$;
revoke all on function public.create_business_order(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.create_business_order(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb
) to authenticated;

create or replace function public.update_business_order(
  p_order_id uuid,
  p_expected_version int,
  p_customer_id uuid,
  p_order_date date,
  p_fulfillment_type public.business_fulfillment_type,
  p_currency public.currency_code,
  p_exchange_rate_to_cny numeric,
  p_shipping_fee numeric,
  p_tracking_number text,
  p_sales_notes text,
  p_items jsonb,
  p_reason text
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
  v_customer_snapshot jsonb := '{}'::jsonb;
  v_old jsonb;
  v_subtotal numeric(18,2);
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved sales, supervisor, admin, or finance account required';
  end if;
  select * into v_order from public.business_orders bo where bo.id = p_order_id for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if v_order.version <> p_expected_version then raise exception 'Business order version conflict'; end if;
  if v_order.status::text = 'completed' or v_order.closed_at is not null then
    raise exception 'Completed or closed business order cannot be edited';
  end if;
  if v_order.status::text not in ('draft', 'rejected') then
    if v_actor.role::text not in ('admin', 'finance')
       or v_order.status::text <> 'approved'
       or exists (
         select 1
         from public.business_order_payment_allocations a
         join public.business_customer_transfers t on t.id = a.transfer_id
         where a.order_id = v_order.id and a.voided_at is null and t.voided_at is null
       )
       or exists (
         select 1 from public.business_order_shipments s
         where s.order_id = v_order.id and s.voided_at is null
       ) then
      raise exception 'Business order cannot be edited in current status';
    end if;
  end if;
  if v_actor.role::text in ('sales', 'supervisor') and v_order.salesperson_id is distinct from v_uid then
    raise exception 'Sales user cannot edit another owner business order';
  end if;
  if p_customer_id is null and v_actor.role::text not in ('admin', 'finance') then
    raise exception 'Business order customer is required';
  end if;
  if p_order_date is null then raise exception 'Order date is required'; end if;
  if p_exchange_rate_to_cny is not null
     and (p_exchange_rate_to_cny <= 0 or p_exchange_rate_to_cny > 1000000) then
    raise exception 'Exchange rate is invalid';
  end if;
  if p_currency::text = 'CNY' and p_exchange_rate_to_cny is not null
     and p_exchange_rate_to_cny <> 1 then
    raise exception 'CNY exchange rate must equal one';
  end if;
  if p_shipping_fee is null or p_shipping_fee < 0 or p_shipping_fee > 999999999999 then
    raise exception 'Shipping fee is invalid';
  end if;
  if char_length(coalesce(p_tracking_number, '')) > 200
     or char_length(coalesce(p_sales_notes, '')) > 2000
     or char_length(coalesce(p_reason, '')) > 1000 then
    raise exception 'Business order text exceeds maximum length';
  end if;

  if p_customer_id is not null then
    select * into v_customer from public.customers c where c.id = p_customer_id;
    if not found or (
      v_actor.role::text in ('sales', 'supervisor') and v_customer.created_by is distinct from v_uid
    ) then
      raise exception 'Customer does not exist or is not manageable by current user';
    end if;
    v_customer_snapshot := jsonb_build_object(
      'name', v_customer.name, 'company', v_customer.company,
      'email', v_customer.email, 'phone', v_customer.phone,
      'address', v_customer.address, 'city', v_customer.city,
      'state', v_customer.state, 'postal_code', v_customer.postal_code,
      'country', v_customer.country, 'contact_person', v_customer.contact_person,
      'tag_color', v_customer.tag_color
    );
  end if;

  v_old := jsonb_build_object(
    'order', to_jsonb(v_order),
    'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order)
                       from public.business_order_items i
                       where i.order_id = v_order.id), '[]'::jsonb)
  );

  update public.business_orders bo set
    customer_id = p_customer_id,
    customer_snapshot = v_customer_snapshot
  where bo.id = v_order.id;

  v_subtotal := public.replace_business_order_items(v_order.id, p_items);

  update public.business_orders bo set
    customer_id = p_customer_id,
    customer_snapshot = v_customer_snapshot,
    order_date = p_order_date, fulfillment_type = p_fulfillment_type,
    currency = p_currency, exchange_rate_to_cny = p_exchange_rate_to_cny,
    items_subtotal = v_subtotal, shipping_fee = p_shipping_fee,
    total_amount = v_subtotal + p_shipping_fee,
    tracking_number = nullif(btrim(p_tracking_number), ''),
    sales_notes = nullif(btrim(p_sales_notes), ''), version = bo.version + 1
  where bo.id = v_order.id returning * into v_order;

  perform public.write_business_order_audit(
    v_order.id, 'order', v_order.id, 'update', v_order.status, v_order.status,
    v_old,
    jsonb_build_object(
      'order', to_jsonb(v_order),
      'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order)
                         from public.business_order_items i
                         where i.order_id = v_order.id), '[]'::jsonb)
    ), p_reason, v_uid
  );
  return query select v_order.id, v_order.order_number, v_order.version;
end;
$$;
revoke all on function public.update_business_order(
  uuid, int, uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.update_business_order(
  uuid, int, uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb, text
) to authenticated;

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

  return query select v_order.id, v_order.order_number, v_order.version;
end;
$$;
revoke all on function public.set_business_order_customer(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.set_business_order_customer(uuid, uuid) to authenticated;
