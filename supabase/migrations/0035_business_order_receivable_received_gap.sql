-- 0035: Make the receivable/received gap explicit and auditable.
--
-- Accounting definitions remain unchanged:
--   business_orders.total_amount       = receivable amount used by payment/lifecycle gates
--   business_orders.total_sales_amount = actually received amount entered in the daily ledger
-- A non-zero final gap requires a persisted reason. The constraint is deferred because the
-- V3/V4 write path updates the receivable and daily-ledger fields in two internal steps.
--
-- The whole migration runs in one explicit transaction: deploy/nas/apply-migrations.sh feeds this
-- file to psql in autocommit mode, so without it a failure would leave the new column in place
-- without its backfill and guard, and legacy V3 writers could still persist unexplained gaps.

begin;

alter table public.business_orders
  add column if not exists receivable_received_difference_reason text;

comment on column public.business_orders.receivable_received_difference_reason is
  'Required explanation when total_amount (receivable) differs from total_sales_amount (received).';

alter table public.business_orders
  drop constraint if exists business_orders_receivable_received_difference_reason_length;
alter table public.business_orders
  add constraint business_orders_receivable_received_difference_reason_length
  check (
    receivable_received_difference_reason is null
    or char_length(receivable_received_difference_reason) <= 1000
  );

-- Existing rows predate this requirement. Keep the historical difference visible without
-- inventing a business-specific explanation.
--
-- Three guards must stand down for this one statement:
--   trg_protect_business_order_closure     freezes every field of specially closed orders,
--   trg_protect_business_order_daily_fields locks daily fields once money or shipments exist,
--   trg_business_orders_touch              would rewrite updated_at for untouched business data.
-- They are restored inside the same transaction, and every backfilled order gets a system audit row.
do $$
declare
  v_trigger text;
  v_disabled text[] := array[]::text[];
begin
  foreach v_trigger in array array[
    'trg_protect_business_order_closure',
    'trg_protect_business_order_daily_fields',
    'trg_business_orders_touch'
  ]
  loop
    if exists (
      select 1
      from pg_trigger t
      where t.tgrelid = 'public.business_orders'::regclass
        and t.tgname = v_trigger
        and not t.tgisinternal
    ) then
      execute format('alter table public.business_orders disable trigger %I', v_trigger);
      v_disabled := v_disabled || v_trigger;
    end if;
  end loop;

  with backfilled as (
    update public.business_orders bo
    set receivable_received_difference_reason = '上线前历史应收实收差额'
    where bo.total_sales_amount is not null
      and round(bo.total_amount, 2) <> round(bo.total_sales_amount, 2)
      and nullif(
        regexp_replace(coalesce(bo.receivable_received_difference_reason, ''), '[[:space:]]', '', 'g'),
        ''
      ) is null
    returning bo.id, bo.status, bo.total_amount, bo.total_sales_amount,
              bo.receivable_received_difference_reason
  )
  insert into public.business_order_audit_logs (
    order_id, entity_type, entity_id, action, from_status, to_status,
    old_data, new_data, reason, actor_id, actor_snapshot
  )
  select
    b.id,
    'order',
    b.id,
    'update'::public.business_audit_action,
    b.status,
    b.status,
    jsonb_build_object('receivable_received_difference_reason', null),
    jsonb_build_object(
      'total_amount', b.total_amount,
      'total_sales_amount', b.total_sales_amount,
      'receivable_received_difference_reason', b.receivable_received_difference_reason
    ),
    '迁移 0035 为上线前存量应收实收差额补录占位原因',
    null::uuid,
    jsonb_build_object('id', null, 'source', 'migration', 'migration', '0035')
  from backfilled b;

  foreach v_trigger in array v_disabled
  loop
    execute format('alter table public.business_orders enable trigger %I', v_trigger);
  end loop;
end;
$$;

create or replace function public.validate_business_order_receivable_received_gap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total_amount numeric;
  v_total_sales_amount numeric;
  v_reason text;
begin
  select bo.total_amount, bo.total_sales_amount, bo.receivable_received_difference_reason
    into v_total_amount, v_total_sales_amount, v_reason
  from public.business_orders bo
  where bo.id = new.id;

  -- The row may have been removed later in the same transaction.
  if not found then return null; end if;

  if char_length(coalesce(v_reason, '')) > 1000 then
    raise exception 'Receivable and received amount difference reason cannot exceed 1000 characters';
  end if;

  if v_total_sales_amount is not null
     and round(v_total_amount, 2) <> round(v_total_sales_amount, 2)
     and nullif(regexp_replace(coalesce(v_reason, ''), '[[:space:]]', '', 'g'), '') is null then
    raise exception 'Receivable and received amount difference reason is required';
  end if;

  return null;
end;
$$;
revoke all on function public.validate_business_order_receivable_received_gap()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_business_orders_receivable_received_gap on public.business_orders;
create constraint trigger trg_business_orders_receivable_received_gap
  after insert or update on public.business_orders
  deferrable initially deferred
  for each row execute function public.validate_business_order_receivable_received_gap();

-- The daily-field lock must not block the protected account-handover RPC from moving the
-- current owner. The original salesperson_name_snapshot is frozen separately below.
create or replace function public.protect_business_order_daily_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if row(
    new.shop_id,
    new.shop_name_snapshot,
    new.shop_group_id,
    new.shop_group_name_snapshot,
    new.external_order_number,
    new.daily_shipping_date,
    new.daily_shipping_number,
    new.daily_payment_category,
    new.total_product_received_amount,
    new.total_product_received_overridden,
    new.total_shipping_received_amount,
    new.total_shipping_received_overridden,
    new.total_sales_amount,
    new.total_sales_overridden,
    new.receivable_received_difference_reason
  ) is distinct from row(
    old.shop_id,
    old.shop_name_snapshot,
    old.shop_group_id,
    old.shop_group_name_snapshot,
    old.external_order_number,
    old.daily_shipping_date,
    old.daily_shipping_number,
    old.daily_payment_category,
    old.total_product_received_amount,
    old.total_product_received_overridden,
    old.total_shipping_received_amount,
    old.total_shipping_received_overridden,
    old.total_sales_amount,
    old.total_sales_overridden,
    old.receivable_received_difference_reason
  ) and (
    exists (
      select 1
      from public.business_order_payment_allocations a
      join public.business_customer_transfers t on t.id = a.transfer_id
      where a.order_id = old.id
        and a.voided_at is null
        and t.voided_at is null
    )
    or exists (
      select 1
      from public.business_order_shipments s
      where s.order_id = old.id and s.voided_at is null
    )
  ) then
    raise exception 'Business order daily fields cannot be changed after payment or shipment';
  end if;
  return new;
end;
$$;
revoke all on function public.protect_business_order_daily_fields()
  from public, anon, authenticated, service_role;

create or replace function public.freeze_business_order_original_salesperson_name()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- create_business_order_v2 first creates the canonical order and the daily applicator then
  -- assigns its selected owner. Allow that one initialization only; later edits and account
  -- handovers keep the original ownership-name snapshot frozen.
  if new.salesperson_name_snapshot is distinct from old.salesperson_name_snapshot
     and not (
       old.shop_id is null
       and old.external_order_number is null
       and old.total_sales_amount is null
     ) then
    new.salesperson_name_snapshot := old.salesperson_name_snapshot;
  end if;
  return new;
end;
$$;
revoke all on function public.freeze_business_order_original_salesperson_name()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_zzz_business_order_original_salesperson_name on public.business_orders;
create trigger trg_zzz_business_order_original_salesperson_name
  before update of salesperson_name_snapshot on public.business_orders
  for each row execute function public.freeze_business_order_original_salesperson_name();

create or replace function public.create_business_order_v4(
  p_customer_id uuid,
  p_order_date date,
  p_fulfillment_type public.business_fulfillment_type,
  p_currency public.currency_code,
  p_exchange_rate_to_cny numeric,
  p_shipping_fee numeric,
  p_tracking_number text,
  p_sales_notes text,
  p_items jsonb,
  p_payment_due_date date,
  p_shop_id uuid,
  p_salesperson_id uuid,
  p_external_order_number text,
  p_daily_shipping_date date,
  p_daily_shipping_number text,
  p_daily_payment_category public.daily_order_payment_category,
  p_total_product_received_amount numeric,
  p_total_product_received_overridden boolean,
  p_total_shipping_received_amount numeric,
  p_total_shipping_received_overridden boolean,
  p_total_sales_amount numeric,
  p_total_sales_overridden boolean,
  p_receivable_received_difference_reason text
)
returns table (id uuid, order_number text, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_created record;
  v_order public.business_orders%rowtype;
  v_reason text := nullif(
    regexp_replace(
      coalesce(p_receivable_received_difference_reason, ''),
      '^[[:space:]]+|[[:space:]]+$',
      '',
      'g'
    ),
    ''
  );
begin
  if char_length(coalesce(p_receivable_received_difference_reason, '')) > 1000 then
    raise exception 'Receivable and received amount difference reason cannot exceed 1000 characters';
  end if;

  select * into v_created
  from public.create_business_order_v3(
    p_customer_id,
    p_order_date,
    p_fulfillment_type,
    p_currency,
    p_exchange_rate_to_cny,
    p_shipping_fee,
    p_tracking_number,
    p_sales_notes,
    p_items,
    p_payment_due_date,
    p_shop_id,
    p_salesperson_id,
    p_external_order_number,
    p_daily_shipping_date,
    p_daily_shipping_number,
    p_daily_payment_category,
    p_total_product_received_amount,
    p_total_product_received_overridden,
    p_total_shipping_received_amount,
    p_total_shipping_received_overridden,
    p_total_sales_amount,
    p_total_sales_overridden
  );

  select * into v_order
  from public.business_orders bo
  where bo.id = v_created.id
  for update;

  if round(v_order.total_amount, 2) <> round(v_order.total_sales_amount, 2) then
    if v_reason is null then
      raise exception 'Receivable and received amount difference reason is required';
    end if;
  else
    v_reason := null;
  end if;

  update public.business_orders bo
  set receivable_received_difference_reason = v_reason
  where bo.id = v_order.id
  returning * into v_order;

  if v_reason is not null then
    perform public.write_business_order_audit(
      v_order.id,
      'order',
      v_order.id,
      'update',
      v_order.status,
      v_order.status,
      jsonb_build_object('receivable_received_difference_reason', null),
      jsonb_build_object(
        'total_amount', v_order.total_amount,
        'total_sales_amount', v_order.total_sales_amount,
        'receivable_received_difference_reason', v_reason
      ),
      v_reason,
      v_uid
    );
  end if;

  return query select v_created.id, v_created.order_number, v_created.version;
end;
$$;

create or replace function public.update_business_order_v4(
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
  p_payment_due_date date,
  p_reason text,
  p_shop_id uuid,
  p_salesperson_id uuid,
  p_external_order_number text,
  p_daily_shipping_date date,
  p_daily_shipping_number text,
  p_daily_payment_category public.daily_order_payment_category,
  p_total_product_received_amount numeric,
  p_total_product_received_overridden boolean,
  p_total_shipping_received_amount numeric,
  p_total_shipping_received_overridden boolean,
  p_total_sales_amount numeric,
  p_total_sales_overridden boolean,
  p_receivable_received_difference_reason text
)
returns table (id uuid, order_number text, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_updated record;
  v_order public.business_orders%rowtype;
  v_old_reason text;
  v_reason text := nullif(
    regexp_replace(
      coalesce(p_receivable_received_difference_reason, ''),
      '^[[:space:]]+|[[:space:]]+$',
      '',
      'g'
    ),
    ''
  );
  v_audit_reason text;
begin
  if char_length(coalesce(p_receivable_received_difference_reason, '')) > 1000 then
    raise exception 'Receivable and received amount difference reason cannot exceed 1000 characters';
  end if;

  v_audit_reason := coalesce(nullif(btrim(p_reason), ''), v_reason);

  -- V3 owns existence, authorization and optimistic-lock checks. Reading or locking the order
  -- before that would let an unauthorized caller probe orders through this definer function.
  select * into v_updated
  from public.update_business_order_v3(
    p_order_id,
    p_expected_version,
    p_customer_id,
    p_order_date,
    p_fulfillment_type,
    p_currency,
    p_exchange_rate_to_cny,
    p_shipping_fee,
    p_tracking_number,
    p_sales_notes,
    p_items,
    p_payment_due_date,
    v_audit_reason,
    p_shop_id,
    p_salesperson_id,
    p_external_order_number,
    p_daily_shipping_date,
    p_daily_shipping_number,
    p_daily_payment_category,
    p_total_product_received_amount,
    p_total_product_received_overridden,
    p_total_shipping_received_amount,
    p_total_shipping_received_overridden,
    p_total_sales_amount,
    p_total_sales_overridden
  );

  select * into v_order
  from public.business_orders bo
  where bo.id = v_updated.id
  for update;

  v_old_reason := v_order.receivable_received_difference_reason;

  if round(v_order.total_amount, 2) <> round(v_order.total_sales_amount, 2) then
    if v_reason is null then
      raise exception 'Receivable and received amount difference reason is required';
    end if;
  else
    v_reason := null;
  end if;

  update public.business_orders bo
  set receivable_received_difference_reason = v_reason
  where bo.id = v_order.id
  returning * into v_order;

  if v_old_reason is distinct from v_reason then
    perform public.write_business_order_audit(
      v_order.id,
      'order',
      v_order.id,
      'update',
      v_order.status,
      v_order.status,
      jsonb_build_object('receivable_received_difference_reason', v_old_reason),
      jsonb_build_object(
        'total_amount', v_order.total_amount,
        'total_sales_amount', v_order.total_sales_amount,
        'receivable_received_difference_reason', v_reason
      ),
      coalesce(v_audit_reason, '应收实收差额已归零'),
      v_uid
    );
  end if;

  return query select v_updated.id, v_updated.order_number, v_updated.version;
end;
$$;

revoke all on function public.create_business_order_v4(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb, date, uuid, uuid, text, date, text,
  public.daily_order_payment_category, numeric, boolean, numeric, boolean,
  numeric, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_business_order_v4(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb, date, uuid, uuid, text, date, text,
  public.daily_order_payment_category, numeric, boolean, numeric, boolean,
  numeric, boolean, text
) to authenticated;

revoke all on function public.update_business_order_v4(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text,
  uuid, uuid, text, date, text, public.daily_order_payment_category,
  numeric, boolean, numeric, boolean, numeric, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.update_business_order_v4(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text,
  uuid, uuid, text, date, text, public.daily_order_payment_category,
  numeric, boolean, numeric, boolean, numeric, boolean, text
) to authenticated;

-- V4 is the only client write entry after this migration. V3 remains private for V4.
revoke all on function public.create_business_order_v3(
  uuid, date, public.business_fulfillment_type, public.currency_code,
  numeric, numeric, text, text, jsonb, date, uuid, uuid, text, date, text,
  public.daily_order_payment_category, numeric, boolean, numeric, boolean,
  numeric, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.update_business_order_v3(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text,
  uuid, uuid, text, date, text, public.daily_order_payment_category,
  numeric, boolean, numeric, boolean, numeric, boolean
) from public, anon, authenticated, service_role;

-- Preserve the disabled-account boundary after the restored daily-order policies are applied.
drop policy if exists "finance_daily_order_screenshots_select" on storage.objects;
create policy "finance_daily_order_screenshots_select"
  on storage.objects for select to authenticated
using (
  public.is_approved_user()
  and bucket_id = 'finance-daily-order-screenshots'
  and case
    when array_length(storage.foldername(name), 1) = 2
      and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$'
    then (
      public.is_finance_or_admin()
      or exists (
        select 1
        from public.finance_daily_orders legacy_order
        where legacy_order.id = ((storage.foldername(name))[2])::uuid
          and (
            legacy_order.salesperson_id = (select auth.uid())
            or public.is_my_subordinate(legacy_order.salesperson_id)
          )
      )
      or public.can_view_business_order(((storage.foldername(name))[2])::uuid)
    )
    else false
  end
);

drop policy if exists "finance_daily_order_screenshots_delete_unbound" on storage.objects;
create policy "finance_daily_order_screenshots_delete_unbound"
  on storage.objects for delete to authenticated
using (
  public.is_approved_user()
  and bucket_id = 'finance-daily-order-screenshots'
  and array_length(storage.foldername(name), 1) = 2
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and public.daily_order_screenshot_object_is_unbound(storage.objects.name)
);

drop policy if exists "daily_order_assignments_select"
  on public.finance_daily_order_shop_salespeople;
create policy "daily_order_assignments_select"
  on public.finance_daily_order_shop_salespeople
  for select to authenticated
  using (
    public.is_approved_user()
    and (
      public.is_finance_or_admin()
      or salesperson_id = (select auth.uid())
      or public.is_my_subordinate(salesperson_id)
    )
  );

commit;
