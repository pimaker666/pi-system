begin;

create or replace function public.normalize_adjusted_daily_order_sales_total_0096()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_setting('app.adjust_business_order_items_rpc', true) = 'true'
     and (
       new.total_product_received_amount is distinct from old.total_product_received_amount
       or new.total_shipping_received_amount is distinct from old.total_shipping_received_amount
     ) then
    new.total_sales_amount := round(
      coalesce(new.total_product_received_amount, 0)
      + coalesce(new.total_shipping_received_amount, 0),
      2
    );
    new.total_sales_overridden := false;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_normalize_adjusted_daily_order_sales_total_0096
  on public.business_orders;

create trigger trg_normalize_adjusted_daily_order_sales_total_0096
  before update of total_product_received_amount,
                   total_shipping_received_amount,
                   total_sales_amount
  on public.business_orders
  for each row
  execute function public.normalize_adjusted_daily_order_sales_total_0096();

revoke all on function public.normalize_adjusted_daily_order_sales_total_0096()
  from public, anon, authenticated, service_role;

commit;
