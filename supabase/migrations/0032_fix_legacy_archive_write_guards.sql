-- 0032_fix_legacy_archive_write_guards.sql
--
-- 0031 froze legacy daily-order fact tables with one statement-level trigger for
-- INSERT/UPDATE/DELETE/TRUNCATE. PostgreSQL also fires a statement-level DELETE
-- trigger for a zero-row foreign-key cascade, which made deletion of an entirely
-- unreferenced user fail. Keep legacy facts immutable while allowing harmless
-- zero-row cascades: reject row-level DML and retain a statement-level TRUNCATE
-- guard.

do $$
declare
  legacy_table_name text;
  legacy_table regclass;
begin
  foreach legacy_table_name in array array[
    'finance_daily_orders',
    'finance_daily_order_screenshots',
    'finance_daily_order_workflows',
    'finance_daily_order_commissions',
    'finance_daily_order_change_requests',
    'finance_daily_order_workflow_audit_logs',
    'finance_daily_order_cost_overrides'
  ]
  loop
    legacy_table := pg_catalog.to_regclass(pg_catalog.format('public.%I', legacy_table_name));
    if legacy_table is null then
      raise exception 'Required legacy table public.% is missing', legacy_table_name;
    end if;

    execute pg_catalog.format(
      'drop trigger if exists trg_reject_legacy_daily_order_write on %s',
      legacy_table
    );
    execute pg_catalog.format(
      'drop trigger if exists trg_reject_legacy_daily_order_dml on %s',
      legacy_table
    );
    execute pg_catalog.format(
      'drop trigger if exists trg_reject_legacy_daily_order_truncate on %s',
      legacy_table
    );
    execute pg_catalog.format(
      'create trigger trg_reject_legacy_daily_order_dml before insert or update or delete on %s for each row execute function public.reject_legacy_daily_order_write()',
      legacy_table
    );
    execute pg_catalog.format(
      'create trigger trg_reject_legacy_daily_order_truncate before truncate on %s for each statement execute function public.reject_legacy_daily_order_write()',
      legacy_table
    );
  end loop;
end;
$$;

do $$
declare
  legacy_table_name text;
  legacy_table regclass;
  matching_trigger_count integer;
begin
  foreach legacy_table_name in array array[
    'finance_daily_orders',
    'finance_daily_order_screenshots',
    'finance_daily_order_workflows',
    'finance_daily_order_commissions',
    'finance_daily_order_change_requests',
    'finance_daily_order_workflow_audit_logs',
    'finance_daily_order_cost_overrides'
  ]
  loop
    legacy_table := pg_catalog.to_regclass(pg_catalog.format('public.%I', legacy_table_name));

    select count(*)
      into matching_trigger_count
    from pg_catalog.pg_trigger as trigger_catalog
    where trigger_catalog.tgrelid = legacy_table
      and trigger_catalog.tgname = 'trg_reject_legacy_daily_order_dml'
      and not trigger_catalog.tgisinternal
      and trigger_catalog.tgenabled = 'O'
      and trigger_catalog.tgtype = 31
      and trigger_catalog.tgfoid = 'public.reject_legacy_daily_order_write()'::regprocedure;

    if matching_trigger_count <> 1 then
      raise exception 'Legacy DML guard is invalid on public.%', legacy_table_name;
    end if;

    select count(*)
      into matching_trigger_count
    from pg_catalog.pg_trigger as trigger_catalog
    where trigger_catalog.tgrelid = legacy_table
      and trigger_catalog.tgname = 'trg_reject_legacy_daily_order_truncate'
      and not trigger_catalog.tgisinternal
      and trigger_catalog.tgenabled = 'O'
      and trigger_catalog.tgtype = 34
      and trigger_catalog.tgfoid = 'public.reject_legacy_daily_order_write()'::regprocedure;

    if matching_trigger_count <> 1 then
      raise exception 'Legacy TRUNCATE guard is invalid on public.%', legacy_table_name;
    end if;

    if exists (
      select 1
      from pg_catalog.pg_trigger as trigger_catalog
      where trigger_catalog.tgrelid = legacy_table
        and trigger_catalog.tgname = 'trg_reject_legacy_daily_order_write'
        and not trigger_catalog.tgisinternal
    ) then
      raise exception 'Obsolete legacy write guard still exists on public.%', legacy_table_name;
    end if;
  end loop;
end;
$$;
