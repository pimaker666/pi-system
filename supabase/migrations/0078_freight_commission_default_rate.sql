-- 0078 默认运费提点与成本门禁

begin;

create table if not exists public.finance_freight_commission_settings (
  id smallint primary key check (id = 1),
  freight_commission_rate numeric(7, 4) not null default 0,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_freight_commission_settings_rate_valid
    check (freight_commission_rate >= 0 and freight_commission_rate <= 100)
);

insert into public.finance_freight_commission_settings (id, freight_commission_rate)
values (1, 0)
on conflict (id) do nothing;

drop trigger if exists trg_finance_freight_commission_settings_touch
  on public.finance_freight_commission_settings;
create trigger trg_finance_freight_commission_settings_touch
  before update on public.finance_freight_commission_settings
  for each row execute function public.touch_updated_at();

update public.finance_business_order_commissions
set freight_commission_rate = 0
where freight_cost <= 0
  and freight_commission_rate <> 0;

alter table public.finance_business_order_commissions
  drop constraint if exists finance_business_order_commission_cost_rate_valid;
alter table public.finance_business_order_commissions
  add constraint finance_business_order_commission_cost_rate_valid
  check (freight_cost > 0 or freight_commission_rate = 0);

alter table public.finance_freight_commission_settings enable row level security;

revoke all on table public.finance_freight_commission_settings
  from public, anon, authenticated, service_role;
grant select, update on table public.finance_freight_commission_settings to authenticated;

drop policy if exists "freight_commission_settings_select"
  on public.finance_freight_commission_settings;
create policy "freight_commission_settings_select"
  on public.finance_freight_commission_settings
  for select to authenticated
  using (public.is_approved_user());

drop policy if exists "freight_commission_settings_update"
  on public.finance_freight_commission_settings;
create policy "freight_commission_settings_update"
  on public.finance_freight_commission_settings
  for update to authenticated
  using (public.is_finance_or_admin())
  with check (
    id = 1
    and public.is_finance_or_admin()
    and updated_by = (select auth.uid())
  );

comment on table public.finance_freight_commission_settings is
  '财务维护的默认运费提点；仅正数运费成本订单套用。';
comment on column public.finance_business_order_commissions.freight_commission_rate is
  '订单实际运费提点；运费成本为零时必须为零，正数成本时按默认运费提点保存。';

commit;
