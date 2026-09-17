-- 0052_allow_legacy_product_detachment.sql
-- Archived daily-order snapshots remain immutable. Deleting a catalog product may
-- only clear its obsolete FK reference after the referenced product is gone.

create or replace function public.reject_legacy_daily_order_update_except_product_detach()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if old.product_id is not null
     and new.product_id is null
     and (to_jsonb(old) - 'product_id' - 'updated_at')
         is not distinct from (to_jsonb(new) - 'product_id' - 'updated_at')
     and not exists (
       select 1
       from public.products
       where id = old.product_id
     ) then
    return new;
  end if;

  raise exception 'Legacy daily-order facts are read-only; write business orders through business_orders';
end;
$$;
revoke all on function public.reject_legacy_daily_order_update_except_product_detach()
  from public, anon, authenticated, service_role;

-- 0034 restored a statement-level UPDATE guard, which also rejects the FK's
-- ON DELETE SET NULL maintenance. Keep row-level protection for all mutations
-- and make the one snapshot-safe update explicit.
drop trigger if exists trg_reject_legacy_daily_order_write on public.finance_daily_orders;
drop trigger if exists trg_reject_legacy_daily_order_dml on public.finance_daily_orders;
drop trigger if exists trg_reject_legacy_daily_order_truncate on public.finance_daily_orders;
drop trigger if exists trg_reject_legacy_daily_order_insert_delete on public.finance_daily_orders;
drop trigger if exists trg_reject_legacy_daily_order_update on public.finance_daily_orders;

create trigger trg_reject_legacy_daily_order_insert_delete
before insert or delete on public.finance_daily_orders
for each row execute function public.reject_legacy_daily_order_write();

create trigger trg_reject_legacy_daily_order_update
before update on public.finance_daily_orders
for each row execute function public.reject_legacy_daily_order_update_except_product_detach();

create trigger trg_reject_legacy_daily_order_truncate
before truncate on public.finance_daily_orders
for each statement execute function public.reject_legacy_daily_order_write();
